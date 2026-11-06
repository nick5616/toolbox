package composer

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/viz"
)

// "Fill a template" (Phase 14 A2): a saved composition is the template; its
// photo slots take the job's inputs and the result is rendered in the main
// window (composer/render.ts) through the render broker.

// Options are the job options of a fill.
type Options struct {
	ProjectID string  `json:"projectId"` // the template
	Format    string  `json:"format"`    // "jpg" | "png"; "" = the template's
	Scale     float64 `json:"scale"`     // output pixels per document pixel; 0 = 1
	Name      string  `json:"name"`      // file name without extension; "" = "<template> - <first photo>"
}

// DefaultOptions fill at the template's size and format.
func DefaultOptions() Options { return Options{Scale: 1} }

// Scale limits.
const (
	MinScale = 0.25
	MaxScale = 4
	maxSide  = 8192
)

// SlotIndexes returns the indexes (in layer order, bottom to top) of the
// layers that take photos: image layers marked Slot, or, when none is marked,
// every visible image layer.
func SlotIndexes(doc Composition) []int {
	var marked, all []int
	for i, l := range doc.Layers {
		if l.Kind != "image" || l.Image == nil {
			continue
		}
		if l.Slot {
			marked = append(marked, i)
		}
		if !l.Hidden {
			all = append(all, i)
		}
	}
	if len(marked) > 0 {
		return marked
	}
	return all
}

// FillSlots returns doc with the slots' photos replaced by inputs, in order.
// A slot without an input (the last, incomplete group) is hidden. More inputs
// than slots is an error. The source document is not modified.
func FillSlots(doc Composition, inputs []string) (Composition, error) {
	slots := SlotIndexes(doc)
	if len(slots) == 0 {
		return doc, core.ValidationError("This template has no photo layers to fill", nil)
	}
	if len(inputs) == 0 {
		return doc, core.ValidationError("Add a photo to fill the template with", nil)
	}
	if len(inputs) > len(slots) {
		return doc, core.ValidationError(fmt.Sprintf("%d photos don't fit the %d slots of this template", len(inputs), len(slots)), nil)
	}
	out := doc
	out.Layers = append([]Layer(nil), doc.Layers...)
	for n, idx := range slots {
		l := out.Layers[idx]
		if n >= len(inputs) {
			l.Hidden = true
			out.Layers[idx] = l
			continue
		}
		img := *l.Image
		img.Ref = ImageRef{Path: inputs[n]}
		img.Crop = Rect{X: 0, Y: 0, W: 1, H: 1}
		l.Image = &img
		l.Hidden = false
		out.Layers[idx] = l
	}
	return out, nil
}

// validate checks fill options (shape only).
func (o Options) validate() error {
	if o.ProjectID == "" {
		return core.ValidationError("Pick a template", map[string]string{"projectId": "Pick a template"})
	}
	if o.Format != "" && o.Format != "jpg" && o.Format != "png" {
		return core.ValidationError("Format must be JPEG or PNG", map[string]string{"format": "Format must be JPEG or PNG"})
	}
	if o.Scale != 0 && (o.Scale < MinScale || o.Scale > MaxScale) {
		return core.ValidationError("Scale must be between 0.25 and 4", map[string]string{"scale": "Scale must be between 0.25 and 4"})
	}
	return nil
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if err := o.validate(); err != nil {
		return err
	}
	if len(inputs) == 0 {
		return core.ValidationError("Add a photo to fill the template with", nil)
	}
	return nil
}

// renderFn is the test seam for the broker.
var renderFn = func(ctx context.Context, b *viz.RenderBroker, job *core.JobContext, c viz.CompositionPlan, w, h int) (viz.RenderOutput, error) {
	if b == nil {
		return viz.RenderOutput{}, core.Errorf(core.CodeInternal, "The picture renderer isn't available")
	}
	return b.RenderComposition(ctx, job, c, w, h)
}

// Run implements core.Module: one filled, rendered picture.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := o.validate(); err != nil {
		return err
	}
	stored, err := m.docs.Load(ctx, o.ProjectID)
	if err != nil {
		return err
	}
	doc, err := m.Get(ctx, o.ProjectID)
	if err != nil {
		return err
	}
	filled, err := FillSlots(doc, job.Inputs)
	if err != nil {
		return err
	}
	if err := Validate(filled); err != nil {
		return err
	}
	format := o.Format
	if format == "" {
		format = doc.Format
	}
	scale := o.Scale
	if scale == 0 {
		scale = 1
	}
	w, h := int(float64(doc.Width)*scale+0.5), int(float64(doc.Height)*scale+0.5)
	if max(w, h) > maxSide {
		return core.ValidationError("The picture would be larger than 8192 pixels", map[string]string{"scale": "Use a smaller scale"})
	}
	raw, err := json.Marshal(filled)
	if err != nil {
		return fmt.Errorf("encode composition: %w", err)
	}
	stem := safeFileName(o.Name)
	if strings.TrimSpace(o.Name) == "" {
		first := strings.TrimSuffix(filepath.Base(job.Inputs[0]), filepath.Ext(job.Inputs[0]))
		stem = safeFileName(stored.Name + " - " + first)
	}
	job.SetTitle("Filling " + stored.Name)
	job.Progress(core.IndeterminateProgress, "Drawing…")
	out, err := renderFn(ctx, m.cfg.Broker, job, viz.CompositionPlan{DocumentJSON: string(raw), Format: format, Scale: scale}, w, h)
	if err != nil {
		return err
	}
	ext := ".jpg"
	if format == "png" {
		ext = ".png"
	}
	dst := core.UniquePath(job.OutputDir, stem, ext)
	if err := moveFile(out.Path, dst); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the picture").WithCause(err)
	}
	if _, err := job.Output(dst); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	job.Progress(1, "Saved "+filepath.Base(dst))
	return nil
}

// moveFile renames src to dst, copying across volumes when needed.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, in); err != nil {
		f.Close()
		os.Remove(dst)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	_ = os.Remove(src)
	return nil
}

// SlotInfo describes a template for the step editor.
type SlotInfo struct {
	Name   string   `json:"name"`
	Slots  []string `json:"slots"` // layer names in fill order
	Width  int      `json:"width"`
	Height int      `json:"height"`
	Format string   `json:"format"`
}

// Slots lists the photo slots of a composition.
func (m *Module) Slots(ctx context.Context, id string) (SlotInfo, error) {
	stored, err := m.docs.Load(ctx, id)
	if err != nil {
		return SlotInfo{}, err
	}
	doc, err := m.Get(ctx, id)
	if err != nil {
		return SlotInfo{}, err
	}
	info := SlotInfo{Name: stored.Name, Slots: []string{}, Width: doc.Width, Height: doc.Height, Format: doc.Format}
	for n, i := range SlotIndexes(doc) {
		name := doc.Layers[i].Name
		if strings.TrimSpace(name) == "" {
			name = fmt.Sprintf("Photo %d", n+1)
		}
		info.Slots = append(info.Slots, name)
	}
	return info, nil
}
