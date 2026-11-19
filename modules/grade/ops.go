package grade

import "slices"

// The op catalog (Phase 21 SPEC §E3.1) as Go sees it: which kinds exist and
// the ranges of their params. It mirrors frontend/src/grade/ops.ts; recipe
// validation (validate.go) clamps against it and prompt.go lists it for the
// chat model. When ops.ts changes a range, change it here too (the shared
// vectors in core/testdata/grade-recipes.json catch drift).

type paramKind int

const (
	pNumber paramKind = iota // Min..Max
	pColor                   // "#rrggbb"
	pEnum                    // one of Options
	pBool
	pNumbers // exactly N numbers, each Min..Max
	pStops   // 2..8 gradient stops written "#rrggbb@pos,#rrggbb@pos" (pos 0..1)
	pBands   // 18 numbers: Lab mean L,a,b then std L,a,b for 3 bands (transfer)
)

type paramSpec struct {
	Kind     paramKind
	Min, Max float64
	Options  []string
	N        int
	Doc      string // one phrase for the chat model's catalog
}

type opSpec struct {
	Kind      string
	Effect    string // one line for the chat model
	ColorOnly bool
	Animates  bool // has a natural motion (huecycle, gradmap); any op may still carry anim
	Needs     string
	Params    map[string]paramSpec // iteration order for prompts: see paramOrder
	Order     []string
}

func num(min, max float64, doc string) paramSpec {
	return paramSpec{Kind: pNumber, Min: min, Max: max, Doc: doc}
}
func nums(n int, min, max float64, doc string) paramSpec {
	return paramSpec{Kind: pNumbers, N: n, Min: min, Max: max, Doc: doc}
}
func col(doc string) paramSpec { return paramSpec{Kind: pColor, Doc: doc} }
func enum(doc string, opts ...string) paramSpec {
	return paramSpec{Kind: pEnum, Options: opts, Doc: doc}
}

func spec(kind, effect string, colorOnly bool, order []string, params map[string]paramSpec) opSpec {
	return opSpec{Kind: kind, Effect: effect, ColorOnly: colorOnly, Params: params, Order: order}
}

// opSpecs lists every op kind in catalog order.
var opSpecs = buildSpecs()

func buildSpecs() []opSpec {
	s := []opSpec{
		spec("balance", "exposure, white balance, contrast, saturation and vibrance", true,
			[]string{"exposure", "temp", "tint", "contrast", "pivot", "saturation", "vibrance"},
			map[string]paramSpec{
				"exposure": num(-3, 3, "stops"), "temp": num(-1, 1, "cool to warm"), "tint": num(-1, 1, "green to magenta"),
				"contrast": num(0, 3, "1 = unchanged"), "pivot": num(0, 1, "contrast pivot, 0.5 mid grey"),
				"saturation": num(0, 3, "1 = unchanged"), "vibrance": num(-1, 1, "boosts dull colours only"),
			}),
		spec("wheels", "lift/gamma/gain colour wheels and an offset", true,
			[]string{"lift", "gamma", "gain", "offset"},
			map[string]paramSpec{
				"lift": nums(3, -1, 1, "[r,g,b] shadows"), "gamma": nums(3, -1, 1, "[r,g,b] midtones"),
				"gain": nums(3, -1, 1, "[r,g,b] highlights"), "offset": nums(3, -1, 1, "[r,g,b] everything"),
			}),
		spec("curves", "tone curves: master, red, green, blue, each 5 points [x0,y0,...,x4,y4]", true,
			[]string{"master", "r", "g", "b"},
			map[string]paramSpec{
				"master": nums(10, 0, 1, "5 points"), "r": nums(10, 0, 1, "5 points"),
				"g": nums(10, 0, 1, "5 points"), "b": nums(10, 0, 1, "5 points"),
			}),
		spec("hsl", "per-colour hue, saturation and luminance (red, yellow, green, cyan, blue, magenta)", true,
			[]string{"hue", "sat", "lum"},
			map[string]paramSpec{
				"hue": nums(6, -180, 180, "degrees, 6 colours"), "sat": nums(6, -1, 1, "6 colours"), "lum": nums(6, -1, 1, "6 colours"),
			}),
		spec("split", "split toning: one colour in the shadows, another in the highlights", true,
			[]string{"shadow", "highlight", "balance"},
			map[string]paramSpec{"shadow": col("#rrggbb"), "highlight": col("#rrggbb"), "balance": num(-1, 1, "toward shadows or highlights")}),
		spec("gradmap", "maps brightness (or depth, or hue) onto a colour gradient", true,
			[]string{"stops", "source", "blend", "drift"},
			map[string]paramSpec{
				"stops":  {Kind: pStops, Doc: `2 to 8 stops as "#rrggbb@pos,#rrggbb@pos" with pos 0..1`},
				"source": enum("what drives the gradient", "luma", "depth", "hue"),
				"blend":  enum("how it mixes", "mix", "add", "multiply", "screen", "overlay", "softlight", "color"),
				"drift":  num(-1, 1, "slides the gradient"),
			}),
		spec("chanmix", "channel mixer: a 3x3 matrix plus bias as 12 numbers (r row, g row, b row, bias)", true,
			[]string{"matrix", "preset"},
			map[string]paramSpec{
				"matrix": nums(12, -4, 4, "[rr,rg,rb, gr,gg,gb, br,bg,bb, biasR,biasG,biasB]"),
				"preset": enum("a ready matrix", "", "aerochrome", "brg", "gbr", "monored"),
			}),
		spec("solarize", "inverts tones above a threshold", true,
			[]string{"threshold", "mix"}, map[string]paramSpec{"threshold": num(0, 1, ""), "mix": num(0, 1, "")}),
		spec("posterize", "reduces each channel to a few levels", true,
			[]string{"levels"}, map[string]paramSpec{"levels": num(2, 16, "whole number")}),
		spec("invert", "inverts the chosen channels", true,
			[]string{"r", "g", "b"}, map[string]paramSpec{"r": {Kind: pBool}, "g": {Kind: pBool}, "b": {Kind: pBool}}),
		spec("huecycle", "rotates hue by brightness, depth or distance from the centre", true,
			[]string{"by", "cycles", "phase"},
			map[string]paramSpec{"by": enum("what drives it", "luma", "depth", "radius"), "cycles": num(0, 8, ""), "phase": num(0, 1, "")}),
		spec("transfer", "matches another picture's colour (made by Steal a look, don't write it)", true,
			[]string{"stats"}, map[string]paramSpec{"stats": {Kind: pBands, Doc: "18 numbers"}}),
		spec("bleach", "bleach bypass: silvery, contrasty, desaturated", true,
			[]string{"mix"}, map[string]paramSpec{"mix": num(0, 1, "")}),
		spec("glow", "soft bloom around bright areas", false,
			[]string{"radius", "threshold", "tint"},
			map[string]paramSpec{"radius": num(0, 1, "of the short side"), "threshold": num(0, 1, ""), "tint": col("#rrggbb")}),
		spec("halation", "red-orange film halation around highlights", false,
			[]string{"radius", "threshold", "tint"},
			map[string]paramSpec{"radius": num(0, 1, "of the short side"), "threshold": num(0, 1, ""), "tint": col("#rrggbb")}),
		spec("edgeglow", "glowing outlines on edges", false,
			[]string{"strength", "color", "thickness"},
			map[string]paramSpec{"strength": num(0, 2, ""), "color": col("#rrggbb"), "thickness": num(0, 1, "")}),
		spec("depthfog", "coloured fog that thickens with distance", false,
			[]string{"color", "start", "density"},
			map[string]paramSpec{"color": col("#rrggbb"), "start": num(0, 1, ""), "density": num(0, 1, "")}),
		spec("tiltshift", "blurs everything away from a focus depth", false,
			[]string{"focus", "range", "blur"},
			map[string]paramSpec{"focus": num(0, 1, "depth in focus"), "range": num(0, 1, ""), "blur": num(0, 1, "")}),
		spec("grain", "film grain", false, []string{"amount"}, map[string]paramSpec{"amount": num(0, 1, "")}),
		spec("vignette", "darkens the corners", false, []string{"amount"}, map[string]paramSpec{"amount": num(0, 1, "")}),
		spec("chromatic", "splits the colour channels apart", false,
			[]string{"amount"}, map[string]paramSpec{"amount": num(0, 24, "pixels")}),
		spec("halftone", "newspaper dots", false,
			[]string{"dots", "angle", "mode"},
			map[string]paramSpec{"dots": num(20, 240, "across"), "angle": num(-90, 90, "degrees"), "mode": enum("", "mono", "color")}),
		spec("glitch", "digital glitch slices and shifts", false, []string{"amount"}, map[string]paramSpec{"amount": num(0, 1, "")}),
		spec("vhs", "VHS tape: scanlines, colour bleed, wobble, noise", false,
			[]string{"scanlines", "bleed", "wobble", "noise"},
			map[string]paramSpec{"scanlines": num(0, 1, ""), "bleed": num(0, 1, ""), "wobble": num(0, 1, ""), "noise": num(0, 1, "")}),
		spec("sharpen", "sharpens detail", false, []string{}, map[string]paramSpec{}),
		spec("mirror", "kaleidoscope mirror", false,
			[]string{"segments", "spin", "zoom"},
			map[string]paramSpec{"segments": num(2, 16, "whole number"), "spin": num(-1, 1, ""), "zoom": num(0.5, 2, "")}),
	}
	for i := range s {
		switch s[i].Kind {
		case "huecycle", "gradmap":
			s[i].Animates = true
		case "depthfog", "tiltshift":
			s[i].Needs = "depth"
		}
	}
	return s
}

// OpKinds lists the kinds in catalog order.
func OpKinds() []string {
	out := make([]string, len(opSpecs))
	for i, s := range opSpecs {
		out[i] = s.Kind
	}
	return out
}

func specOf(kind string) (opSpec, bool) {
	for _, s := range opSpecs {
		if s.Kind == kind {
			return s, true
		}
	}
	return opSpec{}, false
}

// Region kinds.
var (
	lumaRegions    = []string{"highlights", "shadows", "midtones"}
	subjectRegions = []string{"subject", "background", "people"}
	depthRegions   = []string{"near", "far"}
	waves          = []string{"sine", "saw", "beat", "bar"}
	wildCurves     = []string{"linear", "late", "early"}
	tiers          = []Tier{TierFilm, TierBold, TierBonkers, TierMine, TierAI}
)

// regionNeeds is the map a region kind needs ("" = none).
func regionNeeds(kind string) string {
	switch {
	case slices.Contains(subjectRegions, kind):
		return kind
	case slices.Contains(depthRegions, kind):
		return "depth"
	}
	return ""
}

// RegionsUsed lists the maps ("depth", "subject", "people") a recipe's active
// ops need: their regions plus ops that read depth themselves.
func RegionsUsed(r Recipe) []string {
	seen := map[string]bool{}
	var out []string
	add := func(k string) {
		if k != "" && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	for _, op := range r.Ops {
		if !op.On {
			continue
		}
		switch op.Region.Kind {
		case "background":
			add("subject")
		default:
			add(regionNeeds(op.Region.Kind))
		}
		if s, ok := specOf(op.Kind); ok {
			add(s.Needs)
		}
		switch op.Kind {
		case "gradmap", "huecycle":
			if v, ok := op.Params["source"]; ok && string(v) == `"depth"` {
				add("depth")
			}
			if v, ok := op.Params["by"]; ok && string(v) == `"depth"` {
				add("depth")
			}
		}
	}
	return out
}
