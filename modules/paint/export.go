package paint

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"toolbox/core"
	"toolbox/core/proc"
)

// Export limits: the scaled output stays within what the pure-Go pipeline
// holds in memory.
const (
	maxExportSide   = 16384
	maxExportPixels = 100_000_000
	flatPrefix      = "file:"
	maxFlatURL      = 128 << 20
)

func ext(f ExportFormat) string { return "." + string(f) }

// cleanFileName makes a safe file name stem.
func cleanFileName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 32 || strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	s := strings.Trim(strings.Join(strings.Fields(b.String()), " "), ". ")
	if r := []rune(s); len(r) > 120 {
		s = strings.TrimRight(string(r[:120]), ". ")
	}
	if s == "" {
		return "Painting"
	}
	switch strings.ToUpper(strings.SplitN(s, ".", 2)[0]) { // reserved Windows device names
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3":
		s = "_" + s
	}
	return s
}

func (m *Module) flatDir() string { return filepath.Join(m.cfg.TmpDir, "paint") }

// decodeExport reads and checks export options.
func (m *Module) decodeExport(ctx context.Context, raw json.RawMessage) (ExportOptions, PaintDoc, error) {
	var o ExportOptions
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, PaintDoc{}, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode paint export: %w", err))
	}
	switch o.Format {
	case FormatPNG, FormatJPG, FormatWebP, FormatORA:
	default:
		return o, PaintDoc{}, core.ValidationError("Choose PNG, JPG, WebP or OpenRaster", map[string]string{"format": "Unknown format"})
	}
	if (o.Format == FormatJPG || o.Format == FormatWebP) && (o.Quality < 60 || o.Quality > 100) {
		return o, PaintDoc{}, core.ValidationError("Quality must be 60 to 100", map[string]string{"quality": "60 to 100"})
	}
	if !(o.Scale >= 0.25 && o.Scale <= 4) {
		return o, PaintDoc{}, core.ValidationError("Scale must be 25% to 400%", map[string]string{"scale": "25% to 400%"})
	}
	if len([]rune(o.Name)) > 200 {
		return o, PaintDoc{}, core.ValidationError("That name is too long", map[string]string{"name": "Too long"})
	}
	doc, err := m.load(ctx, o.ProjectID)
	if err != nil {
		return o, doc, err
	}
	w, h := scaledSize(doc.Width, doc.Height, o.Scale)
	if max(w, h) > maxExportSide || w*h > maxExportPixels {
		return o, doc, core.ValidationError(fmt.Sprintf("The export would be %d × %d px; choose a smaller scale", w, h), map[string]string{"scale": "Too large"})
	}
	if o.Format == FormatJPG && doc.Background == "transparent" {
		return o, doc, core.ValidationError("A JPG can't be transparent", map[string]string{"format": "Needs a background"}).
			WithHint("Give the painting a background colour, or export PNG, WebP or OpenRaster")
	}
	switch {
	case o.Flattened == "":
		if usesNonGoBlend(doc) && o.Format != FormatORA {
			return o, doc, core.ValidationError("This painting uses blend modes that need the editor to render the export", map[string]string{"flattened": "Missing"}).
				WithHint("Export from inside Paint+")
		}
	case strings.HasPrefix(o.Flattened, flatPrefix):
		if !core.IsWithin(strings.TrimPrefix(o.Flattened, flatPrefix), m.flatDir()) {
			return o, doc, core.ValidationError("The rendered picture isn't available", nil)
		}
	case strings.HasPrefix(o.Flattened, "data:image/png;base64,"):
		if len(o.Flattened) > maxFlatURL {
			return o, doc, core.ValidationError("The rendered picture is too large", nil)
		}
	default:
		return o, doc, core.ValidationError("The rendered picture isn't a PNG", nil)
	}
	return o, doc, nil
}

func scaledSize(w, h int, s float64) (int, int) {
	return max(1, int(math.Round(float64(w)*s))), max(1, int(math.Round(float64(h)*s)))
}

// submitExport submits an export job. A frontend render is parked in a file
// so the job's stored options stay small.
func (m *Module) submitExport(jobs *core.Jobs, opts ExportOptions) (core.Job, error) {
	if jobs == nil {
		return core.Job{}, core.Errorf(core.CodeInternal, "Export isn't available")
	}
	if opts.Quality == 0 && opts.Format != FormatJPG && opts.Format != FormatWebP {
		opts.Quality = 92
	}
	raw, err := json.Marshal(opts)
	if err != nil {
		return core.Job{}, fmt.Errorf("encode export options: %w", err)
	}
	if _, _, err := m.decodeExport(bg(), raw); err != nil {
		return core.Job{}, err
	}
	if strings.HasPrefix(opts.Flattened, "data:") {
		b, err := decodeDataURL(opts.Flattened, "png", maxFlatURL)
		if err != nil {
			return core.Job{}, err
		}
		p := filepath.Join(m.flatDir(), "flat-"+core.NewID()+".png")
		if err := writeAtomic(p, b); err != nil {
			return core.Job{}, err
		}
		opts.Flattened = flatPrefix + p
		if raw, err = json.Marshal(opts); err != nil {
			return core.Job{}, fmt.Errorf("encode export options: %w", err)
		}
	}
	list, err := jobs.Submit(bg(), ModuleID, []string{}, string(raw))
	if err != nil {
		if strings.HasPrefix(opts.Flattened, flatPrefix) {
			_ = os.Remove(strings.TrimPrefix(opts.Flattened, flatPrefix))
		}
		return core.Job{}, err
	}
	if len(list) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "The export didn't start")
	}
	return list[0], nil
}

// exportAs writes an export where the user chooses (not registered).
func (m *Module) exportAs(ctx context.Context, opts ExportOptions) (string, error) {
	if m.cfg.SaveDialog == nil {
		return "", core.Errorf(core.CodeInternal, "Choosing a file isn't available")
	}
	if opts.Quality == 0 && opts.Format != FormatJPG && opts.Format != FormatWebP {
		opts.Quality = 92
	}
	raw, _ := json.Marshal(opts)
	o, doc, err := m.decodeExport(ctx, raw)
	if err != nil {
		return "", err
	}
	name, err := m.exportName(ctx, o)
	if err != nil {
		return "", err
	}
	dest, err := m.cfg.SaveDialog("Export painting", name+ext(o.Format))
	if err != nil {
		return "", fmt.Errorf("save dialog: %w", err)
	}
	if dest == "" {
		return "", nil
	}
	if filepath.Ext(dest) == "" {
		dest += ext(o.Format)
	}
	work, err := m.workDir()
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	ffmpeg := func() (string, error) {
		if m.cfg.Resolve == nil {
			return "", core.ErrDependencyMissing("ffmpeg", "FFmpeg isn't available")
		}
		return m.cfg.Resolve("ffmpeg")
	}
	tmp := filepath.Join(work, "out"+ext(o.Format))
	if err := m.renderExport(ctx, o, doc, tmp, work, ffmpeg, nil); err != nil {
		return "", err
	}
	b, err := os.ReadFile(tmp)
	if err != nil {
		return "", fmt.Errorf("read export: %w", err)
	}
	if err := writeAtomic(dest, b); err != nil {
		return "", err
	}
	return dest, nil
}

func (m *Module) workDir() (string, error) {
	base := m.flatDir()
	if err := os.MkdirAll(base, 0o755); err != nil {
		return "", fmt.Errorf("create work folder: %w", err)
	}
	return os.MkdirTemp(base, "export-")
}

func (m *Module) exportName(ctx context.Context, o ExportOptions) (string, error) {
	name := o.Name
	if strings.TrimSpace(name) == "" {
		p, err := m.docs.Load(ctx, o.ProjectID)
		if err != nil {
			return "", err
		}
		name = p.Name
	}
	return cleanFileName(name), nil
}

// flattenedImage reads the frontend's render (PNG data URL or parked file).
func (m *Module) flattenedImage(o ExportOptions) (*image.NRGBA, error) {
	var b []byte
	if strings.HasPrefix(o.Flattened, flatPrefix) {
		p := strings.TrimPrefix(o.Flattened, flatPrefix)
		if !core.IsWithin(p, m.flatDir()) {
			return nil, core.ValidationError("The rendered picture isn't available", nil)
		}
		var err error
		if b, err = os.ReadFile(p); err != nil {
			return nil, core.Errorf(core.CodeNotFound, "The rendered picture is gone").WithHint("Export again from inside Paint+").WithCause(err)
		}
	} else {
		var err error
		if b, err = decodeDataURL(o.Flattened, "png", maxFlatURL); err != nil {
			return nil, err
		}
	}
	img, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, core.ValidationError("The rendered picture isn't valid", nil).WithCause(err)
	}
	return toNRGBA(img), nil
}

// mergedImage is the flattened painting at 1×, background included.
func (m *Module) mergedImage(ctx context.Context, o ExportOptions, doc PaintDoc) (*image.NRGBA, error) {
	if o.Flattened != "" {
		img, err := m.flattenedImage(o)
		if err != nil {
			return nil, err
		}
		if img.Bounds().Dx() != doc.Width || img.Bounds().Dy() != doc.Height {
			img = resize(img, doc.Width, doc.Height)
		}
		if doc.Background != "transparent" {
			bgc := image.NewNRGBA(img.Bounds())
			r, g, b := parseHex(doc.Background)
			draw.Draw(bgc, bgc.Bounds(), image.NewUniform(color.NRGBA{r, g, b, 255}), image.Point{}, draw.Src)
			draw.Draw(bgc, bgc.Bounds(), img, image.Point{}, draw.Over)
			img = bgc
		}
		return img, nil
	}
	return m.flatten(ctx, o.ProjectID, doc, flattenOpts{Background: true})
}

// renderExport writes the export to path (a new temp file).
func (m *Module) renderExport(ctx context.Context, o ExportOptions, doc PaintDoc, path, work string, ffmpeg func() (string, error), progress func(float64, string)) error {
	report := func(p float64, msg string) {
		if progress != nil {
			progress(p, msg)
		}
	}
	report(0.05, "Flattening")
	merged, err := m.mergedImage(ctx, o, doc)
	if err != nil {
		return err
	}
	w, h := scaledSize(doc.Width, doc.Height, o.Scale)
	scaled := func(img *image.NRGBA) *image.NRGBA { return resize(img, w, h) }
	switch o.Format {
	case FormatPNG:
		report(0.7, "Encoding")
		b, err := encodePNG(scaled(merged))
		if err != nil {
			return err
		}
		return os.WriteFile(path, b, 0o644)
	case FormatJPG:
		report(0.7, "Encoding")
		img := scaled(merged)
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: o.Quality}); err != nil {
			return fmt.Errorf("encode jpeg: %w", err)
		}
		return os.WriteFile(path, buf.Bytes(), 0o644)
	case FormatWebP:
		ff, err := ffmpeg()
		if err != nil {
			return err
		}
		report(0.6, "Encoding")
		b, err := encodePNG(scaled(merged))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(work, "stage.png"), b, 0o644); err != nil {
			return fmt.Errorf("write stage: %w", err)
		}
		out := filepath.Base(path)
		if err := runFFmpeg(ctx, ff, filepath.Dir(path), []string{"-hide_banner", "-nostdin", "-y", "-v", "error",
			"-i", relTo(filepath.Dir(path), filepath.Join(work, "stage.png")), "-frames:v", "1",
			"-c:v", "libwebp", "-quality", strconv.Itoa(o.Quality), "-compression_level", "4", out}); err != nil {
			return err
		}
		return nil
	default: // ORA
		f, err := os.Create(path)
		if err != nil {
			return fmt.Errorf("create %s: %w", path, err)
		}
		layers := make([]oraLayerOut, len(doc.Layers))
		for i, l := range doc.Layers {
			layers[i] = oraLayerOut{layer: l, get: func() (*image.NRGBA, error) {
				report(0.1+0.8*float64(i)/float64(len(doc.Layers)), "Writing layers")
				img, err := m.layerImage(ctx, o.ProjectID, l, doc.Width, doc.Height)
				if err != nil {
					return nil, err
				}
				return scaled(img), nil
			}}
		}
		err = writeORA(f, w, h, layers, scaled(merged))
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		return err
	}
}

// relTo returns target relative to dir (ffmpeg runs in dir; Windows paths
// stay out of arguments only when they're beside the cwd, so fall back to the
// absolute path if it can't be made relative).
func relTo(dir, target string) string {
	if r, err := filepath.Rel(dir, target); err == nil {
		return r
	}
	return target
}

func runFFmpeg(ctx context.Context, ffmpeg, dir string, args []string) error {
	var last string
	res, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: args, Dir: dir, OnStderr: func(l string) { last = l }})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("export cancelled: %w", ctxErr)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return fmt.Errorf("run ffmpeg: %w", err)
		}
		msg := strings.TrimSpace(last)
		if msg == "" {
			msg = fmt.Sprintf("ffmpeg exited with code %d", res.ExitCode)
		}
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
	}
	return nil
}

// placeNew copies src to dir/<stem><ext>, taking the first free
// "<stem> (n)" name; it never overwrites.
func placeNew(src, dir, stem, extn string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create %s: %w", dir, err)
	}
	in, err := os.Open(src)
	if err != nil {
		return "", fmt.Errorf("open export: %w", err)
	}
	defer in.Close()
	for i := 0; i < 1000; i++ {
		p := core.UniquePath(dir, stem, extn)
		out, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			return "", fmt.Errorf("create %s: %w", p, err)
		}
		if _, err := in.Seek(0, io.SeekStart); err != nil {
			_ = out.Close()
			return p, err
		}
		_, cerr := io.Copy(out, in)
		if e := out.Close(); cerr == nil {
			cerr = e
		}
		if cerr != nil {
			_ = os.Remove(p)
			return "", fmt.Errorf("write %s: %w", p, cerr)
		}
		return p, nil
	}
	return "", core.Errorf(core.CodeConflict, "Couldn't find a free file name")
}

// runExport is the export job.
func (m *Module) runExport(ctx context.Context, job *core.JobContext) error {
	o, doc, err := m.decodeExport(ctx, job.Options)
	if err != nil {
		return err
	}
	if strings.HasPrefix(o.Flattened, flatPrefix) {
		defer os.Remove(strings.TrimPrefix(o.Flattened, flatPrefix))
	}
	name, err := m.exportName(ctx, o)
	if err != nil {
		return err
	}
	job.SetTitle("Export " + name)
	tmp := filepath.Join(job.TempDir, "out"+ext(o.Format))
	ffmpeg := func() (string, error) { return job.Tool("ffmpeg") }
	if err := m.renderExport(ctx, o, doc, tmp, job.TempDir, ffmpeg, job.Progress); err != nil {
		return err
	}
	job.Progress(0.95, "Saving")
	dest, err := placeNew(tmp, job.OutputDir, name, ext(o.Format))
	if err != nil {
		return err
	}
	if doc.Source != "" {
		_, err = job.OutputFrom(dest, doc.Source)
	} else {
		_, err = job.Output(dest)
	}
	return err
}
