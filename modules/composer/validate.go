package composer

import (
	"fmt"
	"regexp"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/media"
)

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

var (
	bgKinds     = map[string]bool{"color": true, "gradient": true, "image": true}
	lookPresets = map[string]bool{"none": true, "vivid": true, "warm": true, "cool": true, "mono": true, "fade": true, "noir": true}
	aligns      = map[string]bool{"left": true, "center": true, "right": true}
)

// aspectByID finds a canvas shape.
func aspectByID(id string) (AspectInfo, bool) {
	for _, a := range Aspects() {
		if a.ID == id {
			return a, true
		}
	}
	return AspectInfo{}, false
}

// validator collects the first problem as a plain message.
type validator struct {
	field string
	msg   string
}

func (v *validator) fail(field, format string, args ...any) {
	if v.msg == "" {
		v.field, v.msg = field, fmt.Sprintf(format, args...)
	}
}

// rng checks lo <= x <= hi (false for NaN).
func (v *validator) rng(field string, x, lo, hi float64) {
	if !(x >= lo && x <= hi) {
		v.fail(field, "%s must be between %g and %g", field, lo, hi)
	}
}

func (v *validator) colour(field, c string) {
	if !hexColor.MatchString(c) {
		v.fail(field, "%s must be a colour like #1a2b3c", field)
	}
}

func (v *validator) look(field string, l Look) {
	if !lookPresets[l.Preset] {
		v.fail(field+".preset", "%s has an unknown preset", field)
	}
	v.rng(field+".brightness", l.Brightness, -1, 1)
	v.rng(field+".contrast", l.Contrast, -1, 1)
	v.rng(field+".saturation", l.Saturation, -1, 1)
	v.rng(field+".warmth", l.Warmth, -1, 1)
}

// Validate checks a composition against the limits in SPEC.md §B5.1.
func Validate(doc Composition) error {
	v := &validator{}
	if doc.Version != 1 {
		v.fail("version", "Unsupported composition version")
	}
	a, ok := aspectByID(doc.Aspect)
	switch {
	case !ok:
		v.fail("aspect", "Unknown aspect %q", doc.Aspect)
	case a.Width != doc.Width || a.Height != doc.Height:
		v.fail("width", "The size %d×%d doesn't match the %s aspect", doc.Width, doc.Height, doc.Aspect)
	}
	if doc.Format != "jpg" && doc.Format != "png" {
		v.fail("format", "Format must be jpg or png")
	}

	bg := doc.Background
	if !bgKinds[bg.Kind] {
		v.fail("background.kind", "Unknown background kind %q", bg.Kind)
	}
	v.colour("background.color", bg.Color)
	if bg.Kind == "gradient" {
		v.colour("background.color2", bg.Color2)
	} else if bg.Color2 != "" {
		v.colour("background.color2", bg.Color2)
	}
	if bg.Angle < -360 || bg.Angle > 360 {
		v.fail("background.angle", "background.angle must be between -360 and 360")
	}
	if bg.Kind == "image" && (bg.Image == nil || bg.Image.Path == "") {
		v.fail("background.image", "The background needs a photo")
	}
	v.rng("background.panX", bg.PanX, -1, 1)
	v.rng("background.panY", bg.PanY, -1, 1)
	v.rng("background.zoom", bg.Zoom, 1, 4)
	v.rng("background.blur", bg.Blur, 0, 1)
	v.look("background.look", bg.Look)

	if len(doc.Layers) > MaxLayers {
		v.fail("layers", "A composition can have at most %d layers", MaxLayers)
	}
	seen := make(map[string]bool, len(doc.Layers))
	for i, l := range doc.Layers {
		f := fmt.Sprintf("layers[%d]", i)
		if l.ID == "" {
			v.fail(f+".id", "Every layer needs an ID")
		} else if seen[l.ID] {
			v.fail(f+".id", "Layer IDs must be unique")
		}
		seen[l.ID] = true
		if utf8.RuneCountInString(l.Name) > 120 {
			v.fail(f+".name", "Layer names are limited to 120 characters")
		}
		v.rng(f+".x", l.X, -2, 3)
		v.rng(f+".y", l.Y, -2, 3)
		v.rng(f+".rotation", l.Rotation, -3600, 3600)
		v.rng(f+".opacity", l.Opacity, 0, 1)
		switch l.Kind {
		case "image":
			v.rng(f+".size", l.Size, 0.005, 5)
			validateImageLayer(v, f, l)
		case "text":
			v.rng(f+".size", l.Size, 0.005, 1)
			validateTextLayer(v, f, l)
		default:
			v.fail(f+".kind", "Unknown layer kind %q", l.Kind)
		}
		validateEffects(v, f, l)
		v.look(f+".look", l.Look)
	}
	if v.msg == "" {
		return nil
	}
	return core.ValidationError(v.msg, map[string]string{v.field: v.msg})
}

func validateImageLayer(v *validator, f string, l Layer) {
	if l.Image == nil || l.Text != nil {
		v.fail(f+".image", "Image layers need an image")
		return
	}
	if l.Image.Ref.Path == "" {
		v.fail(f+".image.ref", "Image layers need a source photo")
	}
	c := l.Image.Crop
	v.rng(f+".image.crop.x", c.X, 0, 1)
	v.rng(f+".image.crop.y", c.Y, 0, 1)
	if !(c.W > 0 && c.W <= 1 && c.H > 0 && c.H <= 1) || c.X+c.W > 1.0001 || c.Y+c.H > 1.0001 {
		v.fail(f+".image.crop", "The crop must lie inside the photo")
	}
	v.rng(f+".image.radius", l.Image.Radius, 0, 0.5)
}

func validateTextLayer(v *validator, f string, l Layer) {
	t := l.Text
	if t == nil || l.Image != nil {
		v.fail(f+".text", "Text layers need text settings")
		return
	}
	if n := utf8.RuneCountInString(t.Text); n > MaxTextChars {
		v.fail(f+".text.text", "Text is limited to %d characters", MaxTextChars)
	}
	if !media.ValidFont(t.Font) {
		v.fail(f+".text.font", "Unknown font %q", t.Font)
	}
	v.colour(f+".text.color", t.Color)
	if !aligns[t.Align] {
		v.fail(f+".text.align", "Text alignment must be left, center or right")
	}
	v.rng(f+".text.lineHeight", t.LineHeight, 0.8, 2)
	if t.Pill != "" {
		v.colour(f+".text.pill", t.Pill)
	}
}

func validateEffects(v *validator, f string, l Layer) {
	s := l.Shadow
	if s.On || s.Color != "" {
		v.colour(f+".shadow.color", s.Color)
	}
	v.rng(f+".shadow.blur", s.Blur, 0, 0.5)
	v.rng(f+".shadow.offsetX", s.OffsetX, -0.5, 0.5)
	v.rng(f+".shadow.offsetY", s.OffsetY, -0.5, 0.5)
	v.rng(f+".shadow.opacity", s.Opacity, 0, 1)
	o := l.Outline
	if o.On || o.Color != "" {
		v.colour(f+".outline.color", o.Color)
	}
	v.rng(f+".outline.width", o.Width, 0, 0.2)
}
