package editstudio

import (
	"math"
	"strconv"
	"strings"
	"testing"
)

func near(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

func TestGainExprVectors(t *testing.T) {
	lin2 := `{"base":0,"keys":[{"t":0,"v":0,"ease":"linear"},{"t":1000,"v":-12,"ease":"linear"}]}`
	cases := []struct {
		name     string
		volume   float64
		gain     string
		shiftMs  float64
		want     string
		constant bool
		linear   float64
	}{
		{"unity", 1, "", 0, "1", true, 1},
		{"volume only", 0.5, "", 0, "0.5", true, 0.5},
		{"volume 0 is silence", 0, "", 0, "0", true, 0},
		{"constant dB as a number", 1, "-6", 0, "0.501187", true, 0.501187},
		{"constant dB base", 2, `{"base":-20}`, 0, "0.2", true, 0.2},
		{"+12 dB", 1, "12", 0, "3.981072", true, 3.981072},
		{"two linear keys", 1, lin2, 0,
			`'pow(10,(lt(t,0)*0+gte(t,0)*lt(t,1)*(0+(-12)*(t-0))+gte(t,1)*(-12))/20)'`, false, 0},
		{"volume folds in", 0.5, lin2, 0,
			`'0.5*pow(10,(lt(t,0)*0+gte(t,0)*lt(t,1)*(0+(-12)*(t-0))+gte(t,1)*(-12))/20)'`, false, 0},
		{"head trimmed 500 ms", 1, lin2, 500,
			`'pow(10,(lt(t,(-0.5))*0+gte(t,(-0.5))*lt(t,0.5)*(0+(-12)*(t-(-0.5)))+gte(t,0.5)*(-12))/20)'`, false, 0},
		{"flat keys have no slope", 1, `{"base":0,"keys":[{"t":0,"v":-6,"ease":"linear"},{"t":500,"v":-6,"ease":"linear"}]}`, 0,
			`'pow(10,(lt(t,0)*(-6)+gte(t,0)*lt(t,0.5)*((-6))+gte(t,0.5)*(-6))/20)'`, false, 0},
		{"one key holds", 1, `{"base":0,"keys":[{"t":250,"v":-9,"ease":"linear"}]}`, 0,
			`'pow(10,(lt(t,0.25)*(-9)+gte(t,0.25)*(-9))/20)'`, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, ok := parseGain(tc.gain)
			if !ok {
				t.Fatal("parseGain")
			}
			got, constant, lin := gainExpr(tc.volume, g, tc.shiftMs)
			if got != tc.want && !(constant && near(mustFloat(t, got), tc.linear, 1e-6)) {
				t.Errorf("value = %s\nwant    %s", got, tc.want)
			}
			if constant != tc.constant {
				t.Errorf("constant = %v", constant)
			}
			if constant && !near(lin, tc.linear, 1e-5) {
				t.Errorf("linear = %v, want %v", lin, tc.linear)
			}
		})
	}
}

func mustFloat(t *testing.T, s string) float64 {
	t.Helper()
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		t.Fatalf("not a number: %s", s)
	}
	return f
}

func TestGainExprIsBalanced(t *testing.T) {
	g, _ := parseGain(`{"base":0,"keys":[{"t":0,"v":0,"ease":"ease"},{"t":800,"v":-30,"ease":"hold"},{"t":1500,"v":6,"ease":"inout"},{"t":2000,"v":-60,"ease":"linear"}]}`)
	v, constant, _ := gainExpr(0.8, g, 120)
	if constant || !strings.HasPrefix(v, "'") || !strings.HasSuffix(v, "'") {
		t.Fatalf("value = %s", v)
	}
	if strings.Count(v, "(") != strings.Count(v, ")") {
		t.Errorf("unbalanced parentheses: %s", v)
	}
	if strings.ContainsAny(v[1:len(v)-1], "':;[]\n") {
		t.Errorf("characters that would break the filtergraph: %s", v)
	}
}

func TestGainPointsEasing(t *testing.T) {
	key := func(ease string, bez []float64) gainCurve {
		return gainCurve{keys: []gainKey{{T: 0, V: 0, Ease: ease, Bez: bez}, {T: 1000, V: -12, Ease: "linear"}}}
	}
	cases := []struct {
		name string
		g    gainCurve
		at   float64 // seconds
		want float64 // dB
		tol  float64
	}{
		{"linear mid", key("linear", nil), 0.5, -6, 1e-9},
		{"ease mid", key("ease", nil), 0.5, -6, 1e-9},
		{"ease quarter", key("ease", nil), 0.25, -12 * 0.15625, 1e-9},
		{"in quarter", key("in", nil), 0.25, -12 * 0.015625, 1e-9},
		{"out quarter", key("out", nil), 0.25, -12 * (1 - 0.421875), 1e-9},
		{"inout quarter", key("inout", nil), 0.25, -12 * 0.0625, 1e-9},
		{"hold keeps the first value", key("hold", nil), 0.9, 0, 1e-9},
		{"hold ends at the next key", key("hold", nil), 1.0, -12, 1e-9},
		{"bezier linear control points", key("bezier", []float64{0.25, 0.25, 0.75, 0.75}), 0.5, -6, 1e-3},
		{"before the first key", key("linear", nil), -1, 0, 0},
		{"after the last key", key("linear", nil), 5, -12, 0},
	}
	for _, tc := range cases {
		pts := gainPoints(tc.g, 0)
		if got := dbAt(pts, tc.at); !near(got, tc.want, tc.tol) {
			t.Errorf("%s: dbAt(%v) = %v, want %v", tc.name, tc.at, got, tc.want)
		}
	}
}

func TestGainPointsOrderAndDuplicates(t *testing.T) {
	g := gainCurve{keys: []gainKey{{T: 1000, V: -12}, {T: 0, V: 0}, {T: 1000, V: -6}}}
	pts := gainPoints(g, 0)
	if len(pts) != 2 || pts[0] != (gainPoint{0, 0}) || pts[1] != (gainPoint{1, -6}) {
		t.Errorf("points = %+v", pts)
	}
	if pts := gainPoints(gainCurve{base: -3}, 0); len(pts) != 1 || pts[0].Db != -3 {
		t.Errorf("no keys = %+v", pts)
	}
}

func TestDbToGain(t *testing.T) {
	for _, tc := range []struct{ db, want float64 }{{0, 1}, {-6.0206, 0.5}, {20, 10}, {-60, 0.001}, {12, 3.981072}} {
		if got := dbToGain(tc.db); !near(got, tc.want, 1e-4*math.Max(1, tc.want)) {
			t.Errorf("dbToGain(%v) = %v, want %v", tc.db, got, tc.want)
		}
	}
}
