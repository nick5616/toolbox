package grade

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Recipe validation (SPEC §E4). Mirrors frontend/src/grade/validate.ts; the
// shared vectors are core/testdata/grade-recipes.json:
//   - an unknown version, a bad or duplicate op id, or a bad tier/curve is an error;
//   - unknown op kinds and unknown params are dropped; numbers are clamped
//     to the op schema; the name is cut to 40 characters; ops beyond 16 are dropped.

var (
	opIDRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{6}$`)
	hexRe   = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	hexRe3  = regexp.MustCompile(`^#[0-9a-fA-F]{3}$`)
	errBase = "This look isn't valid"
)

func clamp(v, lo, hi float64) float64 {
	if math.IsNaN(v) {
		return lo
	}
	return math.Min(math.Max(v, lo), hi)
}

// ParseRecipe decodes and normalizes one recipe.
func ParseRecipe(raw []byte) (Recipe, error) {
	var r Recipe
	if err := json.Unmarshal(raw, &r); err != nil {
		return Recipe{}, fmt.Errorf("%s: %w", errBase, err)
	}
	return Normalize(r)
}

// Normalize validates r and returns it clamped to the schema.
func Normalize(r Recipe) (Recipe, error) {
	if r.V != RecipeVersion {
		return Recipe{}, fmt.Errorf("%s: unknown version %d", errBase, r.V)
	}
	if !slices.Contains(tiers, r.Tier) {
		return Recipe{}, fmt.Errorf("%s: unknown tier %q", errBase, r.Tier)
	}
	if !slices.Contains(wildCurves, r.WildCurve) {
		return Recipe{}, fmt.Errorf("%s: unknown wildCurve %q", errBase, r.WildCurve)
	}
	out := Recipe{V: RecipeVersion, Name: cutName(r.Name), Tier: r.Tier, Seed: r.Seed, WildCurve: r.WildCurve, Ops: []Op{}}
	seen := map[string]bool{}
	for _, op := range r.Ops {
		if !opIDRe.MatchString(op.ID) {
			return Recipe{}, fmt.Errorf("%s: op id %q isn't 6 characters", errBase, op.ID)
		}
		if seen[op.ID] {
			return Recipe{}, fmt.Errorf("%s: duplicate op id %q", errBase, op.ID)
		}
		seen[op.ID] = true
		s, ok := specOf(op.Kind)
		if !ok {
			continue // unknown kinds are dropped
		}
		if len(out.Ops) >= MaxOps {
			continue
		}
		out.Ops = append(out.Ops, Op{
			ID: op.ID, Kind: op.Kind, On: op.On, Chaos: op.Chaos,
			Amount: clamp(op.Amount, 0, 1), Region: normalizeRegion(op.Region),
			Params: normalizeParams(s, op.Params), Anim: normalizeAnim(op.Anim),
		})
	}
	return out, nil
}

func cutName(n string) string {
	n = strings.TrimSpace(n)
	if utf8.RuneCountInString(n) > MaxNameLen {
		n = string([]rune(n)[:MaxNameLen])
	}
	return n
}

func normalizeRegion(r Region) Region {
	switch {
	case slices.Contains(lumaRegions, r.Kind):
		return Region{Kind: r.Kind, Soft: clamp(r.Soft, 0, 1)}
	case slices.Contains(subjectRegions, r.Kind):
		return Region{Kind: r.Kind, Feather: clamp(r.Feather, 0, 1), Invert: r.Invert}
	case slices.Contains(depthRegions, r.Kind):
		return Region{Kind: r.Kind, Split: clamp(r.Split, 0, 1), Feather: clamp(r.Feather, 0, 1)}
	}
	return Region{Kind: "all"}
}

func normalizeAnim(a *Anim) *Anim {
	if a == nil {
		return nil
	}
	w := a.Wave
	if !slices.Contains(waves, w) {
		w = "sine"
	}
	return &Anim{Speed: clamp(a.Speed, 0.05, 6), Wave: w}
}

func normalizeParams(s opSpec, in map[string]json.RawMessage) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for name, raw := range in {
		ps, ok := s.Params[name]
		if !ok {
			continue
		}
		if v, ok := clampParam(ps, raw); ok {
			out[name] = v
		}
	}
	return out
}

func clampParam(ps paramSpec, raw json.RawMessage) (json.RawMessage, bool) {
	switch ps.Kind {
	case pNumber:
		var v float64
		if json.Unmarshal(raw, &v) != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, false
		}
		return marshal(clamp(v, ps.Min, ps.Max))
	case pBool:
		var v bool
		if json.Unmarshal(raw, &v) != nil {
			return nil, false
		}
		return marshal(v)
	case pColor:
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return nil, false
		}
		hex, ok := normHex(v)
		if !ok {
			return nil, false
		}
		return marshal(hex)
	case pEnum:
		var v string
		if json.Unmarshal(raw, &v) != nil || !slices.Contains(ps.Options, v) {
			return nil, false
		}
		return marshal(v)
	case pNumbers, pBands:
		var v []float64
		n := ps.N
		if ps.Kind == pBands {
			n = 18
		}
		if json.Unmarshal(raw, &v) != nil || len(v) != n {
			return nil, false
		}
		for i := range v {
			if math.IsInf(v[i], 0) {
				return nil, false
			}
			lo, hi := ps.Min, ps.Max
			if ps.Kind == pBands {
				lo, hi = bandRange(i % 6)
			}
			v[i] = clamp(v[i], lo, hi)
		}
		return marshal(v)
	case pStops:
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return nil, false
		}
		s, ok := normStops(v)
		if !ok {
			return nil, false
		}
		return marshal(s)
	}
	return nil, false
}

// bandRange is the range of the i-th number of a transfer band
// (mean L, mean a, mean b, std L, std a, std b).
func bandRange(i int) (lo, hi float64) {
	switch i {
	case 0:
		return 0, 100
	case 1, 2:
		return -128, 128
	}
	return 0, 128
}

func marshal(v any) (json.RawMessage, bool) {
	b, err := json.Marshal(v)
	return b, err == nil
}

func normHex(s string) (string, bool) {
	s = strings.TrimSpace(s)
	switch {
	case hexRe.MatchString(s):
		return strings.ToLower(s), true
	case hexRe3.MatchString(s):
		return strings.ToLower("#" + string([]byte{s[1], s[1], s[2], s[2], s[3], s[3]})), true
	}
	return "", false
}

// normStops checks "#rrggbb@pos,..." (2..8 stops), clamps positions to 0..1
// and keeps the order.
func normStops(s string) (string, bool) {
	parts := strings.Split(s, ",")
	if len(parts) < 2 || len(parts) > 8 {
		return "", false
	}
	out := make([]string, len(parts))
	for i, p := range parts {
		colour, at, ok := strings.Cut(strings.TrimSpace(p), "@")
		hex, okHex := normHex(colour)
		if !ok || !okHex {
			return "", false
		}
		pos, err := strconv.ParseFloat(strings.TrimSpace(at), 64)
		if err != nil || math.IsInf(pos, 0) {
			return "", false
		}
		out[i] = hex + "@" + strconv.FormatFloat(clamp(pos, 0, 1), 'f', -1, 64)
	}
	return strings.Join(out, ","), true
}
