package grade

import "encoding/json"

// The Color Grader recipe (Phase 21 SPEC §E2). FROZEN after Wave 0. It
// mirrors frontend/src/grade/types.ts; both validate against the shared
// vectors in core/testdata/grade-recipes.json. Params are kept as raw JSON
// values per op kind (numbers, strings, booleans, number arrays) and clamped
// against the op catalog (ops.go mirrors frontend/src/grade/ops.ts).

// Recipe limits.
const (
	RecipeVersion = 1
	MaxOps        = 16
	MaxNameLen    = 40
	ChaosAbove    = 0.66 // ops with Chaos are active only above this Wildness
)

// Tier is where a look comes from.
type Tier string

const (
	TierFilm    Tier = "film"
	TierBold    Tier = "bold"
	TierBonkers Tier = "bonkers"
	TierMine    Tier = "mine"
	TierAI      Tier = "ai"
)

// Recipe is one look.
type Recipe struct {
	V         int    `json:"v"`         // 1
	Name      string `json:"name"`      // ≤ 40 chars
	Tier      Tier   `json:"tier"`      //
	Seed      uint32 `json:"seed"`      //
	WildCurve string `json:"wildCurve"` // "linear" | "late" | "early"
	Ops       []Op   `json:"ops"`       // ≤ 16
}

// Op is one step of a recipe.
type Op struct {
	ID     string                     `json:"id"`   // 6 chars, unique in the recipe
	Kind   string                     `json:"kind"` // an op kind from the catalog
	On     bool                       `json:"on"`
	Chaos  bool                       `json:"chaos,omitempty"`
	Amount float64                    `json:"amount"` // 0..1
	Region Region                     `json:"region"`
	Params map[string]json.RawMessage `json:"params"`
	Anim   *Anim                      `json:"anim,omitempty"`
}

// Region is where an op applies. Kind: "all" | "highlights" | "shadows" |
// "midtones" (Soft) | "subject" | "background" | "people" (Feather, Invert) |
// "near" | "far" (Split, Feather).
type Region struct {
	Kind    string  `json:"kind"`
	Soft    float64 `json:"soft,omitempty"`
	Feather float64 `json:"feather,omitempty"`
	Invert  bool    `json:"invert,omitempty"`
	Split   float64 `json:"split,omitempty"`
}

// Anim moves an op over time (video only).
type Anim struct {
	Speed float64 `json:"speed"` // cycles per 10 s, 0.05..6
	Wave  string  `json:"wave"`  // "sine" | "saw" | "beat" | "bar"
}

// Suggestion is one "Read the picture" answer.
type Suggestion struct {
	Name   string `json:"name"`
	Why    string `json:"why"` // ≤ 90 chars
	Recipe Recipe `json:"recipe"`
}

// VibeRequest asks the chat model for looks.
type VibeRequest struct {
	Text string `json:"text"` // 1..300 chars
	Seed uint32 `json:"seed"`
	N    int    `json:"n"` // 1..4
}

// MapState says which region maps exist for a file (SPEC §E5).
type MapState struct {
	Path      string   `json:"path"`
	Depth     MapInfo  `json:"depth"`
	Subject   MapInfo  `json:"subject"`
	People    MapInfo  `json:"people"`
	Preparing []string `json:"preparing"` // kinds with a job queued/running
}

// MapInfo is one region map.
type MapInfo struct {
	Ready   bool   `json:"ready"`
	Preview string `json:"preview"` // a PNG for the Regions panel ("" = none)
	Still   string `json:"still"`   // pictures: the full map PNG
	Stream  string `json:"stream"`  // videos: export-tier stream (+ .idx.json); preview tier is Stream with "-preview"
	Missing string `json:"missing"` // the pack/component to install, "" = available
}
