package composer

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/image/draw"

	"toolbox/core"
	"toolbox/core/projectdocs"
	"toolbox/modules/bgremove"
)

// ThumbDim is the longest side of a stored thumbnail.
const ThumbDim = 480

// maxRenderPixels bounds a stored render (a 2× 9:16 canvas is ~8 MP).
const maxRenderPixels = 64_000_000

// NewComposition is an empty composition at aspect with a white background
// (or backgroundPath, cover-fitted).
func NewComposition(aspect, backgroundPath string) (Composition, error) {
	if aspect == "" {
		aspect = "4:5"
	}
	a, ok := aspectByID(aspect)
	if !ok {
		return Composition{}, core.ValidationError(fmt.Sprintf("Unknown aspect %q", aspect), map[string]string{"aspect": "Unknown aspect"})
	}
	doc := Composition{
		Version: 1, Width: a.Width, Height: a.Height, Aspect: a.ID, Format: "jpg", Layers: []Layer{},
		Background: Background{Kind: "color", Color: "#ffffff", Color2: "#000000", Angle: 180, Zoom: 1, Look: Look{Preset: "none"}},
	}
	if backgroundPath != "" {
		doc.Background.Kind = "image"
		doc.Background.Image = &ImageRef{Path: backgroundPath}
	}
	return doc, nil
}

// Create makes a new composition.
func (m *Module) Create(ctx context.Context, name, aspect, backgroundPath string) (core.ProjectInfo, error) {
	if backgroundPath != "" && !filepath.IsAbs(backgroundPath) {
		return core.ProjectInfo{}, core.ValidationError("Background path must be absolute", nil)
	}
	doc, err := NewComposition(aspect, backgroundPath)
	if err != nil {
		return core.ProjectInfo{}, err
	}
	return m.docs.Create(ctx, name, doc)
}

// Save validates and stores a composition.
func (m *Module) Save(ctx context.Context, id, name string, doc Composition) (core.ProjectInfo, error) {
	if doc.Layers == nil {
		doc.Layers = []Layer{}
	}
	if err := Validate(doc); err != nil {
		return core.ProjectInfo{}, err
	}
	return m.docs.Save(ctx, id, name, doc)
}

// renderFile is the stored render for ext.
func (m *Module) renderFile(id, ext string) string {
	return filepath.Join(m.docs.Dir(id), "render."+ext)
}

// RenderPath returns the latest stored render of a composition, or a
// CodeNotFound error when it was never rendered.
func (m *Module) RenderPath(id string) (string, error) {
	if _, err := m.docs.Load(context.Background(), id); err != nil {
		return "", err
	}
	for _, ext := range []string{"png", "jpg"} {
		p := m.renderFile(id, ext)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
			return p, nil
		}
	}
	return "", core.Errorf(core.CodeNotFound, "This composition hasn't been rendered yet")
}

// SaveRender stores the latest render (format "jpg" | "png", base64) and a
// thumbnail.
func (m *Module) SaveRender(ctx context.Context, id, format, b64 string) error {
	if _, err := m.docs.Load(ctx, id); err != nil {
		return err
	}
	if format != "jpg" && format != "png" {
		return core.ValidationError("Format must be jpg or png", nil)
	}
	if i := strings.Index(b64, ";base64,"); i >= 0 && strings.HasPrefix(b64, "data:") {
		b64 = b64[i+len(";base64,"):]
	}
	if len(b64) > base64.StdEncoding.EncodedLen(MaxRenderBytes) {
		return core.ValidationError("The render is too large to save", nil)
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return core.ValidationError("The render isn't valid image data", nil)
	}
	if len(data) > MaxRenderBytes {
		return core.ValidationError("The render is too large to save", nil)
	}
	cfg, got, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (got != "jpeg" && got != "png") || (format == "jpg") != (got == "jpeg") {
		return core.ValidationError("The render isn't a valid "+strings.ToUpper(format)+" image", nil)
	}
	if int64(cfg.Width)*int64(cfg.Height) > maxRenderPixels {
		return core.ValidationError("The render is too large to save", nil)
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return core.ValidationError("The render isn't a valid image", nil)
	}
	dir := m.docs.Dir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the project folder").WithCause(err)
	}
	if err := writeFileAtomic(m.renderFile(id, format), data); err != nil {
		return fmt.Errorf("write render: %w", err)
	}
	other := "png"
	if format == "png" {
		other = "jpg"
	}
	_ = os.Remove(m.renderFile(id, other))

	thumb, err := encodeThumb(img)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(m.docs.ThumbPath(id), thumb); err != nil {
		return fmt.Errorf("write thumbnail: %w", err)
	}
	return nil
}

// encodeThumb scales img to ≤ ThumbDim and encodes it as JPEG on white.
func encodeThumb(img image.Image) ([]byte, error) {
	small := scaleTo(img, ThumbDim)
	flat := image.NewRGBA(small.Bounds())
	draw.Draw(flat, flat.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(flat, flat.Bounds(), small, image.Point{}, draw.Over)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, flat, &jpeg.Options{Quality: 85}); err != nil {
		return nil, fmt.Errorf("encode thumbnail: %w", err)
	}
	return buf.Bytes(), nil
}

// fileNameReplacer strips characters Windows and macOS don't allow in names.
var fileNameReplacer = strings.NewReplacer(`<`, "_", `>`, "_", `:`, "_", `"`, "_", `/`, "_", `\`, "_", `|`, "_", `?`, "_", `*`, "_")

func safeFileName(name string) string {
	name = projectdocs.CleanName(name)
	name = fileNameReplacer.Replace(name)
	name = strings.Map(func(r rune) rune {
		if r < 0x20 {
			return -1
		}
		return r
	}, name)
	name = strings.TrimRight(name, ". ")
	if name == "" {
		name = "Untitled"
	}
	return name
}

// Export copies the latest render into <library>/Compositions, registers it
// in the library and announces it.
func (m *Module) Export(ctx context.Context, id string) (core.Output, error) {
	p, err := m.docs.Load(ctx, id)
	if err != nil {
		return core.Output{}, err
	}
	src, err := m.RenderPath(id)
	if err != nil {
		return core.Output{}, err
	}
	lib := ""
	if m.cfg.LibraryDir != nil {
		lib = m.cfg.LibraryDir()
	}
	if lib == "" {
		return core.Output{}, core.Errorf(core.CodeInternal, "No library folder is set")
	}
	dir := filepath.Join(lib, "Compositions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return core.Output{}, core.Errorf(core.CodeInternal, "Couldn't create the Compositions folder").WithCause(err)
	}
	dest := core.UniquePath(dir, safeFileName(p.Name), filepath.Ext(src))
	if err := copyNew(src, dest); err != nil {
		return core.Output{}, core.Errorf(core.CodeInternal, "Couldn't save the picture").WithCause(err)
	}
	out, err := core.NewOutput(dest, "", ModuleID)
	if err != nil {
		return core.Output{}, err
	}
	if m.cfg.Outputs != nil {
		if out, err = m.cfg.Outputs.UpsertOutput(ctx, out); err != nil {
			return core.Output{}, err
		}
	}
	if m.cfg.Emitter != nil {
		m.cfg.Emitter.Emit(core.EventLibraryAdded, out)
	}
	return out, nil
}

// copyNew copies src to a new file dst (never overwriting).
func copyNew(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	return nil
}

// RemoveBackground submits a Background Remover job for path (balanced,
// transparent, cropped to the subject with no padding).
func (m *Module) RemoveBackground(ctx context.Context, path string) (core.Job, error) {
	if m.cfg.Jobs == nil {
		return core.Job{}, core.Errorf(core.CodeInternal, "Background removal isn't available")
	}
	if !filepath.IsAbs(path) {
		return core.Job{}, core.ValidationError("Image path must be absolute", nil)
	}
	if fi, err := os.Stat(path); err != nil || !fi.Mode().IsRegular() {
		return core.Job{}, core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(path))
	}
	opts := bgremove.DefaultOptions()
	opts.Model, opts.Output, opts.Crop, opts.Padding, opts.CleanEdges, opts.Refine =
		bgremove.ModelBalanced, bgremove.OutputTransparent, true, 0, true, false
	b, err := json.Marshal(opts)
	if err != nil {
		return core.Job{}, fmt.Errorf("encode options: %w", err)
	}
	jobs, err := m.cfg.Jobs.Submit(ctx, bgremove.ModuleID, []string{path}, string(b))
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "The background job wasn't created")
	}
	return jobs[0], nil
}
