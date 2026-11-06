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
	"slow_tracking": true, "dabs_per_second": true,
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

	// Size: radius_logarithmic is ln(radius px).
	if s, ok := get("radius_logarithmic"); ok {
		p.Size = round3(clamp(2*math.Exp(s.Base), 1, 500))
		for input, pts := range s.Inputs {
			if d, ok := mapMybInput(input, "size", pts, math.Log(4), &n); ok {
				p.Dynamics = append(p.Dynamics, d)
			}
		}
	}
	p.MinSize = 0.2

	// Opacity: base + pressure contribution; a brush that is 0 without pressure is driven by it.
	op, hasOp := get("opaque")
	om, hasOm := get("opaque_multiply")
	p.Opacity = 1
	if hasOp {
		p.Opacity = clamp(op.Base, 0, 1)
	}
	pressurePts := append(append([][2]float64{}, op.Inputs["pressure"]...), om.Inputs["pressure"]...)
	if len(pressurePts) > 0 {
		if d, ok := mapMybInput("pressure", "opacity", pressurePts, 1, &n); ok {
			p.Dynamics = append(p.Dynamics, d)
		}
		if hasOp && op.Base <= 0.001 || !hasOp {
			p.Opacity = 1
		}
	} else if hasOm && om.Base > 0 && om.Base < 1 {
		p.Opacity = clamp(p.Opacity*om.Base, 0, 1)
	}
	for input, pts := range op.Inputs {
		if input == "pressure" {
			continue
		}
		if d, ok := mapMybInput(input, "opacity", pts, 1, &n); ok {
			p.Dynamics = append(p.Dynamics, d)
		}
	}

	if s, ok := get("hardness"); ok {
		p.Tip.Hardness = round3(clamp(s.Base, 0, 1))
	}

	// Spacing: dabs per radius -> fraction of the diameter.
	dabs := 0.0
	for _, k := range []string{"dabs_per_actual_radius", "dabs_per_basic_radius"} {
		if s, ok := get(k); ok && s.Base > 0 {
			dabs = s.Base
			break
		}
	}
	if dabs > 0 {
		p.Spacing = round3(clamp(1/(2*dabs), 0.01, 5))
	} else if s, ok := get("dabs_per_second"); ok && s.Base > 0 {
		n.add("Spacing in dabs per second isn't supported; a default was used.")
	}

	if s, ok := get("smudge"); ok && (s.Base > 0 || len(s.Inputs) > 0) {
		p.Wet.Mix = round3(clamp(s.Base, 0, 1))
		if p.Wet.Mix == 0 {
			p.Wet.Mix = 0.5
			n.add("Smudge depends on input only; a wet mix of 0.5 was used.")
		}
		p.Rendering = "intense"
		if l, ok := get("smudge_length"); ok {
			p.Wet.Pull = round3(clamp(l.Base, 0, 1))
		}
	}

	if s, ok := get("elliptical_dab_ratio"); ok && s.Base > 1.001 {
		p.Tip.Roundness = round3(clamp(1/s.Base, 0.05, 1))
		if a, ok := get("elliptical_dab_angle"); ok {
			p.Tip.Angle = round3(a.Base)
		}
	}
	if s, ok := get("offset_by_random"); ok && s.Base > 0 {
		p.Scatter = round3(clamp(s.Base*0.5, 0, 3))
		n.add("Dab scatter (offset by random) is approximated.")
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
