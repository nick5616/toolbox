package editstudio

import (
	"math"
	"slices"
	"strconv"
	"strings"
)

// Gain keys to an FFmpeg `volume` expression (Phase 21 SPEC §B1). Pure.

// gainPoint is one vertex of the piecewise-linear dB curve: seconds on the
// filter's clock (t = 0 at the first sample the clip contributes) and dB.
type gainPoint struct{ T, Db float64 }

// easeGain maps f in 0..1 through a key's ease (frontend viz/edit Key.ease).
func easeGain(ease string, bez []float64, f float64) float64 {
	switch ease {
	case "ease":
		return f * f * (3 - 2*f)
	case "in":
		return f * f * f
	case "out":
		g := 1 - f
		return 1 - g*g*g
	case "inout":
		if f < 0.5 {
			return 4 * f * f * f
		}
		g := -2*f + 2
		return 1 - g*g*g/2
	case "bezier":
		if len(bez) == 4 {
			return cubicBezierY(bez[0], bez[1], bez[2], bez[3], f)
		}
	}
	return f
}

// cubicBezierY is CSS cubic-bezier(x1, y1, x2, y2) evaluated at progress x.
func cubicBezierY(x1, y1, x2, y2, x float64) float64 {
	at := func(a, b, s float64) float64 { // one coordinate of the curve at parameter s
		return 3*a*(1-s)*(1-s)*s + 3*b*(1-s)*s*s + s*s*s
	}
	lo, hi := 0.0, 1.0
	s := x
	for range 40 { // bisection: x(s) is monotonic for x1, x2 in 0..1
		s = (lo + hi) / 2
		if at(x1, x2, s) < x {
			lo = s
		} else {
			hi = s
		}
	}
	return at(y1, y2, s)
}

// gainPoints turns a gain curve into vertices on the filter clock. shiftMs is
// how much of the clip's start the filter doesn't see (a head trimmed by the
// cut offset or the edit's start), so key time t maps to (t − shift) seconds.
// Eased segments are sampled into linear pieces; holds become a 1 ms ramp.
func gainPoints(g gainCurve, shiftMs float64) []gainPoint {
	keys := slices.Clone(g.keys)
	slices.SortStableFunc(keys, func(a, b gainKey) int {
		switch {
		case a.T < b.T:
			return -1
		case a.T > b.T:
			return 1
		}
		return 0
	})
	// Equal times: the last key wins.
	dedup := keys[:0]
	for _, k := range keys {
		if n := len(dedup); n > 0 && dedup[n-1].T == k.T {
			dedup[n-1] = k
			continue
		}
		dedup = append(dedup, k)
	}
	keys = dedup
	sec := func(ms float64) float64 { return (ms - shiftMs) / 1000 }
	if len(keys) == 0 {
		return []gainPoint{{0, g.base}}
	}
	steps := 8
	if len(keys) > 24 {
		steps = 3
	}
	var pts []gainPoint
	for i, k := range keys {
		pts = append(pts, gainPoint{sec(k.T), k.V})
		if i+1 == len(keys) {
			break
		}
		n := keys[i+1]
		switch k.Ease {
		case "", "linear":
		case "hold":
			if n.T-k.T > 1 {
				pts = append(pts, gainPoint{sec(n.T - 1), k.V})
			}
		default:
			for j := 1; j < steps; j++ {
				f := float64(j) / float64(steps)
				pts = append(pts, gainPoint{sec(k.T + (n.T-k.T)*f), k.V + (n.V-k.V)*easeGain(k.Ease, k.Bez, f)})
			}
		}
	}
	return pts
}

// dbAt evaluates the curve the expression encodes: values hold outside the
// first and last vertex (the Go twin of gainExpr, used by tests).
func dbAt(pts []gainPoint, t float64) float64 {
	if t <= pts[0].T {
		return pts[0].Db
	}
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		if t < b.T {
			return a.Db + (b.Db-a.Db)*(t-a.T)/(b.T-a.T)
		}
	}
	return pts[len(pts)-1].Db
}

// dbToGain is 10^(dB/20).
func dbToGain(db float64) float64 { return math.Pow(10, db/20) }

// exprNum formats a number for an expression (no exponent, trimmed zeros);
// negatives are parenthesised so they are safe after any operator.
func exprNum(v float64) string {
	s := strconv.FormatFloat(v, 'f', 6, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if s == "" || s == "-0" {
		return "0"
	}
	if strings.HasPrefix(s, "-") {
		return "(" + s + ")"
	}
	return s
}

// gainExpr is the `volume` filter's value for volume (the clip's base gain,
// linear) times the gain curve. constant is true (and the string is the plain
// number) when the curve has no keys; otherwise the string is a quoted
// expression of t (seconds on the filter clock) for eval=frame.
func gainExpr(volume float64, g gainCurve, shiftMs float64) (value string, constant bool, linear float64) {
	if len(g.keys) == 0 {
		lin := volume * dbToGain(g.base)
		return mixSec(lin), true, lin
	}
	pts := gainPoints(g, shiftMs)
	var terms []string
	if first := pts[0]; len(pts) > 0 {
		terms = append(terms, "lt(t,"+exprNum(first.T)+")*"+exprNum(first.Db))
	}
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		if b.T <= a.T {
			continue
		}
		t0, t1 := exprNum(a.T), exprNum(b.T)
		body := exprNum(a.Db)
		if a.Db != b.Db {
			body = exprNum(a.Db) + "+" + exprNum((b.Db-a.Db)/(b.T-a.T)) + "*(t-" + t0 + ")"
		}
		terms = append(terms, "gte(t,"+t0+")*lt(t,"+t1+")*("+body+")")
	}
	last := pts[len(pts)-1]
	terms = append(terms, "gte(t,"+exprNum(last.T)+")*"+exprNum(last.Db))
	db := strings.Join(terms, "+")
	expr := "pow(10,(" + db + ")/20)"
	if volume != 1 {
		expr = exprNum(volume) + "*" + expr
	}
	return "'" + expr + "'", false, 0
}
