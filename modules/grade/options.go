package grade

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"toolbox/core"
)

// Job actions.
const (
	ActionGrade = ""     // grade one file (the default)
	ActionMaps  = "maps" // prepare region maps (Regions panel)
)

// Options are a grade job's options (one input per job).
type Options struct {
	Recipe Recipe  `json:"recipe"`
	Wild   float64 `json:"wild"`   // 0..1
	Format string  `json:"format"` // "same" | "jpg" | "png" | "webp" (pictures; videos are always .mp4)
	Beat   Beat    `json:"beat"`

	// Vibe, when set, makes the job ask the chat model for the look (a step's
	// per-file vibe); Recipe is then ignored. VibeSeed seeds the request.
	Vibe     string `json:"vibe,omitempty"`
	VibeSeed uint32 `json:"vibeSeed,omitempty"`

	// Action "maps" prepares region maps instead of grading (G2).
	Action   string   `json:"action,omitempty"`
	MapKinds []string `json:"mapKinds,omitempty"` // "depth" | "subject" | "people"
}

// Beat syncs animated ops to music (videos).
type Beat struct {
	On   bool   `json:"on"`
	Song string `json:"song"` // "" = the video's own audio
}

// DefaultOptions are the tool's starting options: the empty "Clean" look at Bold.
func DefaultOptions() Options {
	return Options{Recipe: Recipe{V: RecipeVersion, Name: "Clean", Tier: TierFilm, WildCurve: "linear", Ops: []Op{}}, Wild: 0.5, Format: "same"}
}

// StepOptions are the pipeline step's options (SPEC §E1).
type StepOptions struct {
	Look   string  `json:"look"` // a built-in look id or a saved look id
	Wild   float64 `json:"wild"`
	Seed   uint32  `json:"seed"`
	Vibe   string  `json:"vibe"`   // template; when set the chat model writes the look per item
	Format string  `json:"format"` // as Options.Format
	// Recipe is the resolved look. Built-in looks live in the frontend, so the
	// step editor stores the recipe here when a look is picked; Go never needs
	// a copy of the 40 built-ins. Hidden in paramDefs. Nil with a vibe.
	Recipe *Recipe `json:"recipe,omitempty"`
}

// DefaultStepOptions are a new step's options.
func DefaultStepOptions() StepOptions {
	return StepOptions{Look: "teal-orange", Wild: 0.5, Format: "same"}
}

// decodeOptions decodes a job's options strictly.
func decodeOptions(raw json.RawMessage) (Options, error) {
	o := DefaultOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return o, nil
}

// checkOptions validates a grade job's options.
func checkOptions(o Options) error {
	if o.Wild < 0 || o.Wild > 1 {
		return core.ValidationError("Wildness is 0 to 1", map[string]string{"wild": "Wildness is 0 to 1"})
	}
	if !slices.Contains([]string{"same", "jpg", "png", "webp"}, o.Format) {
		return core.ValidationError("Pick a format", map[string]string{"format": "Pick a format"})
	}
	if _, err := Normalize(o.Recipe); err != nil {
		return core.ValidationError("This look isn't valid", map[string]string{"recipe": err.Error()})
	}
	return nil
}

// mapKinds validates and de-duplicates the requested map kinds.
func mapKinds(kinds []string) ([]string, error) {
	var out []string
	for _, k := range kinds {
		k = strings.TrimSpace(k)
		if !slices.Contains([]string{"depth", "subject", "people"}, k) {
			return nil, core.ValidationError("Unknown map "+k, map[string]string{"mapKinds": "Unknown map " + k})
		}
		if !slices.Contains(out, k) {
			out = append(out, k)
		}
	}
	if len(out) == 0 {
		return nil, core.ValidationError("Pick a map to prepare", map[string]string{"mapKinds": "Pick a map to prepare"})
	}
	return out, nil
}
