package brushimport

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
)

// mybSetting is one entry of a .myb's "settings": a base value plus input curves.
type mybSetting struct {
	Base   float64                 `json:"base_value"`
	Inputs map[string][][2]float64 `json:"inputs"`
}

type mybFile struct {
	Version  int                   `json:"version"`
	Comment  string                `json:"comment"`
	Settings map[string]mybSetting `json:"settings"`
}

// handled lists the settings ParseMyb maps; the rest are reported if they do something.
var mybHandled = map[string]bool{
	"radius_logarithmic": true, "opaque": true, "opaque_multiply": true, "hardness": true,
	"dabs_per_actual_radius": true, "dabs_per_basic_radius": true, "smudge": true, "smudge_length": true,
	"elliptical_dab_ratio": true, "elliptical_dab_angle": true, "offset_by_random": true, "eraser": true,
	"slow_tracking": true, "dabs_per_second": true, "opaque_linearize": true,
}

// ParseMyb converts a MyPaint .myb brush (JSON). name is the brush's display
// name (the file name without extension; .myb files carry none).
func ParseMyb(name string, data []byte) (*Preset, []string, error) {
	var f mybFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, nil, fmt.Errorf("not a MyPaint brush: %w", err)
	}
	if f.Settings == nil {
		return nil, nil, fmt.Errorf("not a MyPaint brush: no settings")
	}
	var n notes
	p := NewPreset(name)
	get := func(k string) (mybSetting, bool) { s, ok := f.Settings[k]; return s, ok }

	// MyPaint adds every input curve's output to the setting's base value
	// (and multiplies radius_logarithmic's result in the log domain). The
	// pressure curves are evaluated exactly; the other inputs are approximated.
	atPressure := func(k string, x float64) float64 {
		s := f.Settings[k]
		v := s.Base
		if pts := s.Inputs["pressure"]; len(pts) > 0 {
			v += plEval(pts, x)
		}
		return v
	}

	// Size: radius_logarithmic is ln(radius px); the diameter at the largest
	// input is the preset's size, and every input is a multiplier of that.
	p.MinSize = 0
	if s, ok := get("radius_logarithmic"); ok {
		top := s.Base
		var dyns []Dynamics
		names := make([]string, 0, len(s.Inputs))
		for input := range s.Inputs {
			names = append(names, input)
		}
		sort.Strings(names)
		for _, input := range names {
			pts := s.Inputs[input]
			d, ymax, ok := mapMybLogInput(input, pts, &n)
			if ok {
				dyns = append(dyns, d)
				top += ymax
			} else if len(pts) > 0 {
				top += plMax(pts)
			}
		}
		p.Size = round3(clamp(2*math.Exp(top), 1, 500))
		p.Dynamics = append(p.Dynamics, dyns...)
	}
	if !hasTarget(p.Dynamics, "size") {
		// No size input: the engine would otherwise let pressure scale the size.
		p.Dynamics = append(p.Dynamics, Dynamics{Input: "pressure", Target: "size", Amount: 0, Curve: Curve{{0, 0}, {1, 1}}})
	}

	// Dabs per radius: both settings add up. MyPaint spaces dabs by the radius.
	dabs := 0.0
	for _, k := range []string{"dabs_per_actual_radius", "dabs_per_basic_radius"} {
		if s, ok := get(k); ok && s.Base > 0 {
			dabs += s.Base
		}
	}
	if dabs > 0 {
		p.Spacing = round3(clamp(1/(2*dabs), 0.01, 5))
	} else if s, ok := get("dabs_per_second"); ok && s.Base > 0 {
		n.add("Spacing in dabs per second isn't supported; a default was used.")
	}

	// Opacity: MyPaint's dab alpha is (opaque + curves) × (opaque_multiply +
	// curves); opaque_linearize then lowers it per dab so that the dabs
	// overlapping a pixel add up to that opacity. Paint+ accumulates a stroke's
	// dabs the same way, so the per-dab alpha is the preset's flow and the
	// stroke's own opacity stays 1.
	lin := 0.9
	if s, ok := get("opaque_linearize"); ok {
		lin = clamp(s.Base, 0, 1)
	}
	perPixel := 1.0
	if dabs > 0 {
		perPixel = 1 + lin*math.Max(0, dabs*2-1)
	}
	op, om := f.Settings["opaque"], f.Settings["opaque_multiply"]
	target := func(x float64) float64 {
		v := 1.0
		if _, ok := get("opaque"); ok {
			v = clamp(atPressure("opaque", x), 0, 1)
		}
		if _, ok := get("opaque_multiply"); ok {
			v *= clamp(atPressure("opaque_multiply", x), 0, 1)
		}
		return v
	}
	perDab := func(x float64) float64 { return 1 - math.Pow(1-target(x), 1/perPixel) }
	xs := sampleXs(op.Inputs["pressure"], om.Inputs["pressure"])
	flow, lo := 0.0, 1.0
	for _, x := range xs {
		flow = math.Max(flow, perDab(x))
		lo = math.Min(lo, perDab(x))
	}
	p.Opacity = 1
	if flow < 0.002 { // a brush with no opacity at all: leave it visible
		flow = 1
	} else if flow-lo > 0.03*flow {
		curve := make(Curve, 0, len(xs))
		for _, x := range xs {
			curve = append(curve, [2]float64{round3(x), round3(perDab(x) / flow)})
		}
		p.Dynamics = append(p.Dynamics, Dynamics{Input: "pressure", Target: "opacity", Amount: 1, Curve: curve})
	}
	p.Flow = round3(clamp(flow, 0.02, 1))
	for input, pts := range op.Inputs {
		if input == "pressure" || input == "random" {
			continue
		}
		if d, ok := mapMybInput(input, "opacity", pts, 1, &n); ok {
			p.Dynamics = append(p.Dynamics, d)
		}
	}

	if _, ok := get("hardness"); ok {
		p.Tip.Hardness = round3(clamp(atPressure("hardness", 0.6), 0, 1))
	}

	if _, ok := get("smudge"); ok {
		if mix := clamp(atPressure("smudge", 0.6), 0, 1); mix > 0.02 {
			p.Wet.Mix = round3(mix)
			p.Rendering = "intense"
			if l, ok := get("smudge_length"); ok {
				p.Wet.Pull = round3(clamp(l.Base, 0, 1))
			}
			if len(f.Settings["smudge"].Inputs) > 0 {
				n.add("Smudge depends on pressure in MyPaint; a typical pressure's value was used.")
			}
		}
	}

	if _, ok := get("elliptical_dab_ratio"); ok {
		if ratio := atPressure("elliptical_dab_ratio", 0.6); ratio > 1.001 {
			p.Tip.Roundness = round3(clamp(1/ratio, 0.05, 1))
			if a, ok := get("elliptical_dab_angle"); ok {
				p.Tip.Angle = round3(a.Base)
				if len(a.Inputs["direction"]) > 0 || len(a.Inputs["direction_angle"]) > 0 {
					p.Tip.AngleMode = "stroke"
				}
				if len(a.Inputs["random"]) > 0 {
					p.Tip.RotationJitter = 1
				}
			}
		}
	}
	if _, ok := get("offset_by_random"); ok {
		// A Gaussian of this fraction of the radius; ours is uniform in ±scatter × size.
		if v := atPressure("offset_by_random", 0.7); v > 0.01 {
			p.Scatter = round3(clamp(v*0.87, 0, 3))
			n.add("Dab scatter (offset by random) is approximated.")
		}
	}
	if s, ok := get("eraser"); ok && s.Base > 0.5 {
		p.Blend = "erase"
	}
	if s, ok := get("slow_tracking"); ok && s.Base > 0 {
		p.Smoothing.Streamline = round3(clamp(s.Base/10, 0, 1))
	}

	// Anything else that does something is named.
	var skipped []string
	for k, s := range f.Settings {
		if mybHandled[k] || (math.Abs(s.Base) < 1e-9 && len(s.Inputs) == 0) {
			continue
		}
		if len(s.Inputs) == 0 && isMybDefault(k, s.Base) {
			continue
		}
		skipped = append(skipped, k)
	}
	sort.Strings(skipped)
	if len(skipped) > 0 {
		if len(skipped) > 10 {
			skipped = append(skipped[:10], fmt.Sprintf("and %d more", len(skipped)-10))
		}
		n.add("Settings that aren't mapped: %s.", strings.Join(skipped, ", "))
	}
	p.Fidelity = n.list
	return p, n.list, nil
}

// isMybDefault reports settings whose usual resting value isn't zero, so a
// brush that leaves them alone doesn't list them as skipped.
func isMybDefault(key string, base float64) bool {
	switch key {
	case "speed1_slowness", "speed2_slowness", "speed1_gamma", "speed2_gamma", "opaque_linearize",
		"stroke_threshold", "stroke_duration_logarithmic", "stroke_holdtime", "anti_aliasing",
		"direction_filter", "smudge_radius_log", "snap_to_pixel", "pressure_gain_log", "restore_color":
		return true
	case "color_h", "color_s", "color_v":
		return true // the brush's own colour: Paint+ uses the user's colour
	}
	return false
}

// inputRange is the natural span of each MyPaint input (pressure 0..1, speeds roughly 0..4, ...).
func mybInputRange(input string) (maxX float64, ours string, ok bool) {
	switch input {
	case "pressure":
		return 1, "pressure", true
	case "speed1", "speed2":
		return 4, "velocity", true
	case "tilt_declination":
		return 90, "tilt", true
	case "tilt_ascension":
		return 180, "tilt", true
	case "stroke":
		return 1, "progress", true
	}
	return 0, "", false
}

// mapMybInput turns one input curve into a dynamic. span is how much of the
// setting's units equal a full amount (ln 4 for the logarithmic radius).
func mapMybInput(input, target string, pts [][2]float64, span float64, n *notes) (Dynamics, bool) {
	maxX, ours, ok := mybInputRange(input)
	if !ok {
		if len(pts) > 0 {
			n.add("The %q input (on %s) isn't supported and was skipped.", input, target)
		}
		return Dynamics{}, false
	}
	if len(pts) < 2 {
		return Dynamics{}, false
	}
	pts = append([][2]float64{}, pts...)
	sort.SliceStable(pts, func(i, j int) bool { return pts[i][0] < pts[j][0] })
	lo, hi := pts[0][1], pts[0][1]
	for _, pt := range pts {
		lo, hi = math.Min(lo, pt[1]), math.Max(hi, pt[1])
	}
	if hi-lo < 1e-6 {
		return Dynamics{}, false
	}
	curve := make(Curve, 0, len(pts))
	last := -1.0
	for _, pt := range pts {
		x := round3(clamp(pt[0]/maxX, 0, 1))
		if x <= last { // keep x strictly increasing after clamping
			continue
		}
		last = x
		curve = append(curve, [2]float64{x, round3((pt[1] - lo) / (hi - lo))})
	}
	if len(curve) < 2 {
		return Dynamics{}, false
	}
	if input == "speed1" || input == "speed2" || input == "stroke" || input == "tilt_declination" || input == "tilt_ascension" {
		n.add("The %q input was mapped onto %s with an approximate range.", input, ours)
	}
	return Dynamics{Input: ours, Target: target, Amount: round3(clamp((hi-lo)/span, 0.05, 1)), Curve: curve}, true
}

// MybToSet wraps brushes in a set named name (all brushes' notes are merged).
func MybToSet(name string, brushes map[string][]byte) (*Result, error) {
	names := make([]string, 0, len(brushes))
	for k := range brushes {
		names = append(names, k)
	}
	sort.Strings(names)
	res := &Result{Set: Set{Name: name, Source: SourceMyPaint, Files: map[string][]byte{}}}
	var n notes
	for _, bn := range names {
		p, notes, err := ParseMyb(bn, brushes[bn])
		if err != nil {
			n.add("%s: %v", bn, err)
			continue
		}
		for _, m := range notes {
			n.add("%s: %s", bn, m)
		}
		if err := res.Set.add(p); err != nil {
			return nil, err
		}
	}
	if len(res.Set.Brushes) == 0 {
		return nil, fmt.Errorf("no MyPaint brushes could be read")
	}
	res.Fidelity = n.list
	return res, nil
}

func hasTarget(ds []Dynamics, target string) bool {
	for _, d := range ds {
		if d.Target == target {
			return true
		}
	}
	return false
}

// plEval evaluates a MyPaint curve (piecewise linear, flat outside its points).
func plEval(pts [][2]float64, x float64) float64 {
	if len(pts) == 0 {
		return 0
	}
	sorted := append([][2]float64{}, pts...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i][0] < sorted[j][0] })
	if x <= sorted[0][0] {
		return sorted[0][1]
	}
	for i := 1; i < len(sorted); i++ {
		a, b := sorted[i-1], sorted[i]
		if x <= b[0] {
			if b[0]-a[0] < 1e-9 {
				return b[1]
			}
			return a[1] + (b[1]-a[1])*(x-a[0])/(b[0]-a[0])
		}
	}
	return sorted[len(sorted)-1][1]
}

func plMax(pts [][2]float64) float64 {
	m := math.Inf(-1)
	for _, p := range pts {
		m = math.Max(m, p[1])
	}
	return m
}

// sampleXs is a sorted, de-duplicated set of 0..1 inputs: an even grid plus every curve knot.
func sampleXs(curves ...[][2]float64) []float64 {
	xs := []float64{}
	for i := 0; i <= 12; i++ {
		xs = append(xs, float64(i)/12)
	}
	for _, c := range curves {
		for _, p := range c {
			if p[0] >= 0 && p[0] <= 1 {
				xs = append(xs, p[0])
			}
		}
	}
	sort.Float64s(xs)
	out := xs[:0]
	for _, x := range xs {
		if len(out) == 0 || x-out[len(out)-1] > 0.004 {
			out = append(out, x)
		}
	}
	return out
}

// mapMybLogInput maps one input of radius_logarithmic: the radius is e^(base + curve),
// so the input is a multiplier of its largest value. ymax is that largest curve value.
func mapMybLogInput(input string, pts [][2]float64, n *notes) (Dynamics, float64, bool) {
	maxX, ours, ok := mybInputRange(input)
	if !ok {
		if len(pts) > 0 {
			n.add("The %q input (on size) isn't supported and was skipped.", input)
		}
		return Dynamics{}, 0, false
	}
	if len(pts) < 2 {
		return Dynamics{}, 0, false
	}
	ymax := plMax(pts)
	var xs []float64
	for i := 0; i <= 12; i++ {
		xs = append(xs, float64(i)/12*maxX)
	}
	for _, p := range pts {
		if p[0] >= 0 && p[0] <= maxX {
			xs = append(xs, p[0])
		}
	}
	sort.Float64s(xs)
	curve := Curve{}
	last := -1.0
	lo := 1.0
	for _, x := range xs {
		nx := round3(x / maxX)
		if nx <= last {
			continue
		}
		last = nx
		v := math.Exp(plEval(pts, x) - ymax)
		lo = math.Min(lo, v)
		curve = append(curve, [2]float64{nx, round3(v)})
	}
	if 1-lo < 0.02 || len(curve) < 2 {
		return Dynamics{}, ymax, false
	}
	if input != "pressure" {
		n.add("The %q input was mapped onto %s with an approximate range.", input, ours)
	}
	return Dynamics{Input: ours, Target: "size", Amount: 1, Curve: curve}, ymax, true
}
