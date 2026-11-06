package brushimport

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Limits for everything read from a brush file.
const (
	MaxZipTotal   = 64 << 20 // bytes of all zip entries together, uncompressed
	MaxZipEntries = 8192
	MaxImageSide  = 4096 // longest accepted image side, in pixels
	MaxTipSide    = 1024 // tips and grains larger than this are scaled down
	MaxPNGBytes   = 32 << 20
)

// Source values stored in a set's metadata.
const (
	SourceProcreate = "procreate"
	SourceMyPaint   = "mypaint"
	SourceABR       = "abr"
	SourceKrita     = "krita"
	SourcePaintPlus = "paintplus"
)

// Curve, Dynamics, Tip, ... mirror frontend/src/paint/brushes/schema.ts
// (BrushPreset, version 1) so importers build brushes with real types.
type Curve [][2]float64

type Dynamics struct {
	Input  string  `json:"input"`
	Target string  `json:"target"`
	Amount float64 `json:"amount"`
	Curve  Curve   `json:"curve"`
}

type Tip struct {
	Shape          string  `json:"shape"`
	Hardness       float64 `json:"hardness"`
	Roundness      float64 `json:"roundness"`
	Angle          float64 `json:"angle"`
	AngleMode      string  `json:"angleMode"`
	RotationJitter float64 `json:"rotationJitter"`
	Invert         bool    `json:"invert"`
}

type Grain struct {
	Texture  string  `json:"texture"`
	Mode     string  `json:"mode"`
	Scale    float64 `json:"scale"`
	Depth    float64 `json:"depth"`
	Contrast float64 `json:"contrast"`
}

type Wet struct {
	Mix      float64 `json:"mix"`
	Dilution float64 `json:"dilution"`
	Charge   float64 `json:"charge"`
	Pull     float64 `json:"pull"`
	Grade    float64 `json:"grade"`
	Edges    float64 `json:"edges"`
	Bleed    float64 `json:"bleed"`
}

type ColorDynamics struct {
	HueJitter    float64 `json:"hueJitter"`
	SatJitter    float64 `json:"satJitter"`
	BriJitter    float64 `json:"briJitter"`
	PerStroke    bool    `json:"perStroke"`
	SecondaryMix float64 `json:"secondaryMix"`
}

type Smoothing struct {
	Streamline    float64 `json:"streamline"`
	Stabilisation float64 `json:"stabilisation"`
	MotionFilter  float64 `json:"motionFilter"`
}

type Taper struct {
	Start      float64 `json:"start"`
	End        float64 `json:"end"`
	ByPressure bool    `json:"byPressure"`
}

// Preset is a brush (schema version 1).
type Preset struct {
	Version   int           `json:"version"`
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	Set       string        `json:"set"`
	Size      float64       `json:"size"`
	MinSize   float64       `json:"minSize"`
	Opacity   float64       `json:"opacity"`
	Flow      float64       `json:"flow"`
	Spacing   float64       `json:"spacing"`
	Scatter   float64       `json:"scatter"`
	Count     int           `json:"count"`
	Taper     Taper         `json:"taper"`
	Tip       Tip           `json:"tip"`
	Dual      *Tip          `json:"dual"`
	Grain     Grain         `json:"grain"`
	Dynamics  []Dynamics    `json:"dynamics"`
	Color     ColorDynamics `json:"color"`
	Wet       Wet           `json:"wet"`
	Rendering string        `json:"rendering"`
	Impasto   float64       `json:"impasto"`
	Blend     string        `json:"blend"`
	Smoothing Smoothing     `json:"smoothing"`
	Antialias bool          `json:"antialias"`
	Credit    string        `json:"credit"`
	License   string        `json:"license"`
	Fidelity  []string      `json:"fidelity"`
}

// NewPreset returns a brush with the engine's neutral defaults.
func NewPreset(name string) *Preset {
	return &Preset{
		Version: 1, Name: name, Size: 24, MinSize: 0.2, Opacity: 1, Flow: 1, Spacing: 0.1, Count: 1,
		Tip:       Tip{Shape: "round", Hardness: 1, Roundness: 1, AngleMode: "fixed"},
		Grain:     Grain{Mode: "moving", Scale: 1, Contrast: 1},
		Dynamics:  []Dynamics{},
		Rendering: "light-glaze", Blend: "normal",
		Smoothing: Smoothing{Streamline: 0.2},
		Antialias: true, Fidelity: []string{},
	}
}

// Brush is one finished brush of an imported set.
type Brush struct {
	ID      string
	Name    string
	Credit  string
	License string
	JSON    []byte // schema JSON; image references use the placeholder set ID "@"
}

// Set is the result of importing one file: brushes plus their images.
type Set struct {
	Name    string
	Source  string
	Brushes []Brush
	// Files holds the PNGs by their path inside the set: "tips/<name>.png", "grains/<name>.png".
	Files map[string][]byte
	// Raw keeps the source's unmapped settings per brush ID (JSON), so a later version can map more.
	Raw map[string][]byte
}

// Result is what an importer returns: the set and what was approximated or skipped.
type Result struct {
	Set      Set
	Fidelity []string
}

// Ref is a placeholder image reference, bound to the stored set ID by Bind.
func Ref(file string) string { return "set:@/" + file }

var (
	nonSlug = regexp.MustCompile(`[^a-z0-9]+`)
	// SlugRe matches a safe set or brush ID.
	SlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
)

// Slug turns any name into a safe ID ("" becomes "brush").
func Slug(s string) string {
	s = strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 48 {
		s = strings.Trim(s[:48], "-")
	}
	if s == "" {
		return "brush"
	}
	return s
}

// add marshals p into the set under a unique ID.
func (s *Set) add(p *Preset) error {
	base := Slug(p.Name)
	id := base
	for n := 2; s.hasBrush(id); n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	p.ID = id
	p.Set = "@"
	if p.Fidelity == nil {
		p.Fidelity = []string{}
	}
	if p.Dynamics == nil {
		p.Dynamics = []Dynamics{}
	}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	s.Brushes = append(s.Brushes, Brush{ID: id, Name: p.Name, Credit: p.Credit, License: p.License, JSON: data})
	return nil
}

func (s *Set) hasBrush(id string) bool {
	for _, b := range s.Brushes {
		if b.ID == id {
			return true
		}
	}
	return false
}

// addFile stores a PNG under dir ("tips" or "grains") with a unique name and
// returns its path inside the set.
func (s *Set) addFile(dir, name string, png []byte) string {
	if s.Files == nil {
		s.Files = map[string][]byte{}
	}
	base := Slug(name)
	file := dir + "/" + base + ".png"
	for n := 2; ; n++ {
		if _, taken := s.Files[file]; !taken {
			break
		}
		file = fmt.Sprintf("%s/%s-%d.png", dir, base, n)
	}
	s.Files[file] = png
	return file
}

// Bind gives the set its stored ID: every "set:@/..." reference and each
// brush's "set" field are rewritten. It returns new brush JSON documents.
func (s *Set) Bind(id string) error {
	for i, b := range s.Brushes {
		var doc map[string]any
		if err := json.Unmarshal(b.JSON, &doc); err != nil {
			return fmt.Errorf("brush %s: %w", b.ID, err)
		}
		doc["set"] = id
		rewriteRefs(doc, id)
		out, err := json.Marshal(doc)
		if err != nil {
			return err
		}
		s.Brushes[i].JSON = out
	}
	return nil
}

func rewriteRefs(v any, id string) {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			if str, ok := e.(string); ok && strings.HasPrefix(str, "set:@/") {
				t[k] = "set:" + id + "/" + strings.TrimPrefix(str, "set:@/")
				continue
			}
			rewriteRefs(e, id)
		}
	case []any:
		for i, e := range t {
			if str, ok := e.(string); ok && strings.HasPrefix(str, "set:@/") {
				t[i] = "set:" + id + "/" + strings.TrimPrefix(str, "set:@/")
				continue
			}
			rewriteRefs(e, id)
		}
	}
}

func clamp(v, lo, hi float64) float64 {
	if v != v { // NaN
		return lo
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func round3(v float64) float64 { return float64(int64(v*1000+0.5*sign(v))) / 1000 }

func sign(v float64) float64 {
	if v < 0 {
		return -1
	}
	return 1
}

// notes collects fidelity messages without duplicates, in order.
type notes struct{ list []string }

func (n *notes) add(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	for _, e := range n.list {
		if e == msg {
			return
		}
	}
	n.list = append(n.list, msg)
}
