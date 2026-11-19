package grade

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Prompts and reply parsing for Vibe and Read the picture (SPEC §E4). The
// chat model writes recipes without ids; Go assigns them, validates and
// clamps (validate.go), and sets tier "ai".

// MaxVibeChars is the longest vibe description.
const MaxVibeChars = 300

// MaxWhy is the longest "why" of a suggestion.
const MaxWhy = 90

// paletteWords is a small vocabulary of colours with hex values, so the model
// writes real colours.
var paletteWords = [][2]string{
	{"deep teal", "#0b4f5c"}, {"teal", "#1f8a8a"}, {"cyan", "#20d0e0"}, {"ice blue", "#bfe6ff"}, {"navy", "#0b1f4a"},
	{"electric blue", "#1e50ff"}, {"violet", "#7a3cff"}, {"purple", "#6a2c91"}, {"magenta", "#ff2bd6"}, {"hot pink", "#ff4fa0"},
	{"blush", "#f6b8c4"}, {"rose gold", "#d9a08f"}, {"crimson", "#c4122f"}, {"orange", "#ff7a1a"}, {"amber", "#ffb000"},
	{"gold", "#e8b923"}, {"butter", "#f7e7a1"}, {"lime", "#b6ff3a"}, {"acid green", "#7dff1a"}, {"forest", "#1f4d2b"},
	{"mint", "#a8f0d0"}, {"cream", "#f4ead2"}, {"sand", "#d8c3a0"}, {"rust", "#a1451d"}, {"chocolate", "#3d2314"},
	{"charcoal", "#26282c"}, {"midnight", "#0a0a1c"}, {"white", "#ffffff"}, {"black", "#000000"},
}

// SystemPrompt describes the op catalog and the reply format.
func SystemPrompt() string {
	var b strings.Builder
	b.WriteString("You are a film colourist. You write colour grades (looks) for pictures and videos as JSON. ")
	b.WriteString("Reply with the JSON only: no other text, no code fences. Never mention or guess who is in a picture; describe colours, light and mood only.\n\n")
	b.WriteString("A look is {\"name\": string (at most 40 characters), \"wildCurve\": \"linear\"|\"late\"|\"early\", \"ops\": [op, ...]}. ")
	b.WriteString("Use 3 to 10 ops that a colourist would recognise; wild combinations are welcome when the request asks for them. ")
	b.WriteString("Each op is {\"kind\": string, \"amount\": 0..1, \"chaos\": boolean, \"region\": region, \"params\": object}. ")
	b.WriteString("amount is the op's strength when the user turns Wildness all the way up; lower Wildness scales it down. ")
	b.WriteString("An op with chaos true only appears at high Wildness: put the extreme extras there. Ops run in order.\n")
	b.WriteString("A region is {\"kind\": \"all\"} or {\"kind\": \"highlights\"|\"shadows\"|\"midtones\", \"soft\": 0..1} ")
	b.WriteString("or {\"kind\": \"subject\"|\"background\"|\"people\", \"feather\": 0..1, \"invert\": boolean} ")
	b.WriteString("or {\"kind\": \"near\"|\"far\", \"split\": 0..1, \"feather\": 0..1}. Use subject/background to grade the main subject and its surroundings apart, near/far for depth.\n\n")
	b.WriteString("Op kinds, their params and what they do:\n")
	for _, s := range opSpecs {
		fmt.Fprintf(&b, "- %s: %s.", s.Kind, s.Effect)
		if s.Needs != "" {
			b.WriteString(" Needs depth.")
		}
		if len(s.Order) > 0 {
			b.WriteString(" Params:")
			for _, name := range s.Order {
				b.WriteString(" " + name + " " + describeParam(s.Params[name]) + ";")
			}
		}
		b.WriteString("\n")
	}
	b.WriteString("\nColours are \"#rrggbb\". Some colours to start from: ")
	for i, w := range paletteWords {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(w[0] + " " + w[1])
	}
	b.WriteString(".\nOmit params you don't need. Don't write the transfer op.")
	return b.String()
}

func describeParam(p paramSpec) string {
	var d string
	switch p.Kind {
	case pNumber:
		d = fmt.Sprintf("(number %s..%s)", fnum(p.Min), fnum(p.Max))
	case pColor:
		d = "(colour)"
	case pBool:
		d = "(true/false)"
	case pEnum:
		q := make([]string, len(p.Options))
		for i, o := range p.Options {
			q[i] = `"` + o + `"`
		}
		d = "(one of " + strings.Join(q, ", ") + ")"
	case pNumbers:
		d = fmt.Sprintf("(%d numbers %s..%s)", p.N, fnum(p.Min), fnum(p.Max))
	case pStops:
		d = "(string)"
	case pBands:
		d = "(18 numbers)"
	}
	if p.Doc != "" {
		d += " " + p.Doc
	}
	return d
}

func fnum(v float64) string {
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", v), "0"), ".")
}

// VibePrompt is the user message for a vibe request.
func VibePrompt(text string, variation int) string {
	p := "Write one look for this vibe: " + strings.TrimSpace(text)
	if variation > 0 {
		p += fmt.Sprintf("\nThis is variation %d: make it clearly different from the usual take while keeping the vibe.", variation+1)
	}
	return p
}

// ReadPrompt is the user message for "Read the picture".
func ReadPrompt() string {
	return "Look at this picture and write 6 different looks that would suit it: its light, its colours and its mood. " +
		"Each has a short evocative name, a \"why\" of at most 90 characters saying what the look does to this picture, and a recipe. " +
		"Reply as {\"suggestions\": [{\"name\": string, \"why\": string, \"recipe\": look}, ...]} with exactly 6 suggestions. Never name or guess who is in the picture."
}

// -- JSON schemas -----------------------------------------------------------------------

func recipeSchema() map[string]any {
	regionKinds := []string{"all", "highlights", "shadows", "midtones", "subject", "background", "people", "near", "far"}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"name":      map[string]any{"type": "string"},
			"wildCurve": map[string]any{"type": "string", "enum": wildCurves},
			"ops": map[string]any{
				"type": "array", "minItems": 1, "maxItems": 10,
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"kind":   map[string]any{"type": "string", "enum": OpKinds()},
						"amount": map[string]any{"type": "number"},
						"chaos":  map[string]any{"type": "boolean"},
						"region": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"kind":    map[string]any{"type": "string", "enum": regionKinds},
								"soft":    map[string]any{"type": "number"},
								"feather": map[string]any{"type": "number"},
								"split":   map[string]any{"type": "number"},
								"invert":  map[string]any{"type": "boolean"},
							},
							"required": []string{"kind"},
						},
						"params": map[string]any{"type": "object"},
					},
					"required": []string{"kind", "amount", "region", "params"},
				},
			},
		},
		"required": []string{"name", "wildCurve", "ops"},
	}
}

// VibeSchema constrains a Vibe reply to one look.
func VibeSchema() json.RawMessage {
	b, _ := json.Marshal(recipeSchema())
	return b
}

// ReadSchema constrains a Read reply to 6 suggestions.
func ReadSchema() json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"suggestions": map[string]any{
				"type": "array", "minItems": 1, "maxItems": 6,
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"name":   map[string]any{"type": "string"},
						"why":    map[string]any{"type": "string"},
						"recipe": recipeSchema(),
					},
					"required": []string{"name", "why", "recipe"},
				},
			},
		},
		"required": []string{"suggestions"},
	})
	return b
}

// -- parsing ----------------------------------------------------------------------------

type llmOp struct {
	Kind   string                     `json:"kind"`
	On     *bool                      `json:"on"`
	Chaos  bool                       `json:"chaos"`
	Amount float64                    `json:"amount"`
	Region Region                     `json:"region"`
	Params map[string]json.RawMessage `json:"params"`
	Anim   *Anim                      `json:"anim"`
}

type llmRecipe struct {
	Name      string  `json:"name"`
	WildCurve string  `json:"wildCurve"`
	Ops       []llmOp `json:"ops"`
}

// jsonObject cuts the first complete JSON object out of a reply (models add
// code fences or a sentence in spite of the instructions).
func jsonObject(reply string) ([]byte, error) {
	s := strings.TrimSpace(reply)
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return nil, errors.New("no JSON object in the reply")
	}
	dec := json.NewDecoder(strings.NewReader(s[start:]))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("the reply isn't valid JSON: %w", err)
	}
	return bytes.TrimSpace(raw), nil
}

// opID makes the id of the i-th op of a look: stable for (seed, i).
func opID(seed uint32, i int) string {
	const digits = "abcdefghijklmnopqrstuvwxyz0123456789"
	x := seed*2654435761 + uint32(i+1)*40503 + 977
	out := make([]byte, 6)
	for k := range out {
		x ^= x << 13
		x ^= x >> 17
		x ^= x << 5
		out[k] = digits[x%uint32(len(digits))]
	}
	return string(out)
}

// toRecipe turns the model's reply into a validated recipe (tier "ai").
func toRecipe(l llmRecipe, seed uint32) (Recipe, error) {
	curve := l.WildCurve
	if curve == "" {
		curve = "linear"
	}
	r := Recipe{V: RecipeVersion, Name: strings.TrimSpace(l.Name), Tier: TierAI, Seed: seed, WildCurve: curve, Ops: make([]Op, 0, len(l.Ops))}
	if r.Name == "" {
		r.Name = "Vibe look"
	}
	for i, o := range l.Ops {
		on := o.On == nil || *o.On
		params := o.Params
		if params == nil {
			params = map[string]json.RawMessage{}
		}
		r.Ops = append(r.Ops, Op{ID: opID(seed, i), Kind: o.Kind, On: on, Chaos: o.Chaos, Amount: o.Amount, Region: o.Region, Params: params, Anim: o.Anim})
	}
	if !validWildCurve(r.WildCurve) {
		r.WildCurve = "linear"
	}
	out, err := Normalize(r)
	if err != nil {
		return Recipe{}, err
	}
	if len(out.Ops) == 0 {
		return Recipe{}, errors.New("the look has no usable ops")
	}
	return out, nil
}

func validWildCurve(c string) bool {
	for _, w := range wildCurves {
		if w == c {
			return true
		}
	}
	return false
}

// ParseVibe reads one look from a model reply.
func ParseVibe(reply string, seed uint32) (Recipe, error) {
	raw, err := jsonObject(reply)
	if err != nil {
		return Recipe{}, err
	}
	var l llmRecipe
	if err := json.Unmarshal(raw, &l); err != nil {
		return Recipe{}, fmt.Errorf("the reply isn't a look: %w", err)
	}
	return toRecipe(l, seed)
}

// ParseSuggestions reads up to 6 suggestions from a model reply; entries that
// don't validate are skipped, and no usable entry is an error.
func ParseSuggestions(reply string, seed uint32) ([]Suggestion, error) {
	raw, err := jsonObject(reply)
	if err != nil {
		return nil, err
	}
	var env struct {
		Suggestions []struct {
			Name   string    `json:"name"`
			Why    string    `json:"why"`
			Recipe llmRecipe `json:"recipe"`
		} `json:"suggestions"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("the reply isn't a list of looks: %w", err)
	}
	var out []Suggestion
	var firstErr error
	for i, s := range env.Suggestions {
		if len(out) == 6 {
			break
		}
		if strings.TrimSpace(s.Recipe.Name) == "" {
			s.Recipe.Name = s.Name
		}
		r, err := toRecipe(s.Recipe, seed+uint32(i))
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		name := cutName(s.Name)
		if name == "" {
			name = r.Name
		}
		out = append(out, Suggestion{Name: name, Why: cutRunes(strings.TrimSpace(s.Why), MaxWhy), Recipe: r})
	}
	if len(out) == 0 {
		if firstErr == nil {
			firstErr = errors.New("the reply has no looks")
		}
		return nil, firstErr
	}
	return out, nil
}

func cutRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)[:n-1]
	return strings.TrimRight(string(r), " ,.;:") + "…"
}
