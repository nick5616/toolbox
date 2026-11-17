package imagebatch

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	_ "image/gif" // decoders: gif, bmp, tiff and webp join jpeg and png

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/media"
	"toolbox/core/proc"
)

// Image Batch decides:
//   - Everything but text and WebP is pure Go (x/image/draw scaling, image/jpeg
//     and image/png encoders). Those encoders write no metadata, so stripping
//     is the default behaviour.
//   - Text watermarks go through libass (an ASS file run by FFmpeg in the
//     job's TempDir, as Subtitles and Lyric Video do) because the offered
//     fonts (media.Fonts()) are names, not files. WebP goes through FFmpeg's
//     libwebp. Both need FFmpeg, which is resolved only when used.

// maxPixels is the largest picture read (imaging's limit).
const maxPixels = imaging.MaxPixels

// fastScalePixels: above this many source pixels, scale with bilinear.
const fastScalePixels = 40_000_000

// decodeFile reads an upright picture: HEIC through the shared converter,
// EXIF orientation applied.
func decodeFile(ctx context.Context, path string) (image.Image, error) {
	readable, err := imaging.ToReadable(ctx, path)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(readable)
	if err != nil {
		return nil, core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(path))
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return nil, core.Errorf(core.CodeValidation, "%s isn't a picture this tool can read", filepath.Base(path))
	}
	if int64(cfg.Width)*int64(cfg.Height) > maxPixels {
		return nil, core.Errorf(core.CodeValidation, "%s is too large", filepath.Base(path))
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind %s: %w", readable, err)
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, core.Errorf(core.CodeValidation, "Couldn't read %s", filepath.Base(path)).WithCause(err)
	}
	if o := imaging.Orientation(readable); o > 1 {
		img = imaging.Orient(img, o)
	}
	return img, nil
}

// parseColor reads "#rrggbb".
func parseColor(hex string) (r, g, b uint8, ok bool) { return media.ParseHexColor(hex) }

// backgroundOf is the pad colour; transparent has A = 0.
func backgroundOf(s string) color.NRGBA {
	if s == "transparent" {
		return color.NRGBA{}
	}
	r, g, b, ok := parseColor(s)
	if !ok {
		return color.NRGBA{255, 255, 255, 255}
	}
	return color.NRGBA{r, g, b, 255}
}

func interpolator(src image.Image) draw.Interpolator {
	b := src.Bounds()
	if int64(b.Dx())*int64(b.Dy()) > fastScalePixels {
		return draw.ApproxBiLinear
	}
	return draw.CatmullRom
}

// renderCanvas crops, scales and places src per the layout.
func renderCanvas(src image.Image, l Layout, bg color.NRGBA, pad bool) *image.NRGBA {
	canvas := image.NewNRGBA(image.Rect(0, 0, l.Canvas.X, l.Canvas.Y))
	if pad && bg.A > 0 && l.Canvas != l.Content {
		draw.Draw(canvas, canvas.Bounds(), &image.Uniform{bg}, image.Point{}, draw.Src)
	}
	sr := l.Crop.Add(src.Bounds().Min)
	dr := image.Rectangle{Min: l.Offset, Max: l.Offset.Add(l.Content)}
	if sr.Dx() == dr.Dx() && sr.Dy() == dr.Dy() {
		draw.Draw(canvas, dr, src, sr.Min, draw.Over)
	} else {
		interpolator(src).Scale(canvas, dr, src, sr, draw.Over, nil)
	}
	return canvas
}

// overlayLogo draws logo scaled to w.Size% of the canvas width.
func overlayLogo(canvas *image.NRGBA, logo image.Image, w Watermark) {
	lb := logo.Bounds()
	if lb.Dx() == 0 || lb.Dy() == 0 {
		return
	}
	cw := canvas.Bounds().Dx()
	tw := max(1, int(float64(cw)*w.Size/100))
	th := max(1, int(float64(tw)*float64(lb.Dy())/float64(lb.Dx())))
	if th > canvas.Bounds().Dy() { // very tall logo: fit the height instead
		th = canvas.Bounds().Dy()
		tw = max(1, int(float64(th)*float64(lb.Dx())/float64(lb.Dy())))
	}
	scaled := image.NewNRGBA(image.Rect(0, 0, tw, th))
	interpolator(logo).Scale(scaled, scaled.Bounds(), logo, lb, draw.Src, nil)
	at := PlaceWatermark(image.Pt(cw, canvas.Bounds().Dy()), tw, th, w.Corner)
	mask := image.NewUniform(color.Alpha{A: uint8(w.Opacity*255 + 0.5)})
	dr := image.Rectangle{Min: at, Max: at.Add(image.Pt(tw, th))}
	draw.DrawMask(canvas, dr, scaled, image.Point{}, mask, image.Point{}, draw.Over)
}

// flatten puts the picture on an opaque background (JPEG has no alpha).
func flatten(c *image.NRGBA, bg color.NRGBA) *image.NRGBA {
	if c.Opaque() {
		return c
	}
	if bg.A == 0 {
		bg = color.NRGBA{255, 255, 255, 255}
	}
	out := image.NewNRGBA(c.Bounds())
	draw.Draw(out, out.Bounds(), &image.Uniform{bg}, image.Point{}, draw.Src)
	draw.Draw(out, out.Bounds(), c, c.Bounds().Min, draw.Over)
	return out
}

// outFormat resolves FormatSame against the input.
func outFormat(f Format, input string, opaque bool) Format {
	if f != FormatSame {
		return f
	}
	switch strings.ToLower(filepath.Ext(input)) {
	case ".jpg", ".jpeg":
		return FormatJPG
	case ".png":
		return FormatPNG
	case ".webp":
		return FormatWebP
	}
	if opaque {
		return FormatJPG
	}
	return FormatPNG
}

// ext is the file extension of a format.
func (f Format) ext() string {
	switch f {
	case FormatPNG:
		return ".png"
	case FormatWebP:
		return ".webp"
	}
	return ".jpg"
}

// engine does the work of one batch.
type engine struct {
	ffmpeg func() (string, error) // resolves FFmpeg when a step needs it
	now    func() time.Time
	logf   func(format string, args ...any)

	// gate (optional) makes the final naming, move and registration of a
	// batch happen in input order while the heavy work runs in parallel.
	gate *orderGate
	// saved (optional) runs inside the ordered section once a file has been
	// moved into place (the module registers it in the library there).
	saved func(in string, fr FileResult) error
}

// orderGate lets items finish their work in any order but enter the commit
// section strictly in index order: names (UniquePath) and output order stay
// exactly what a sequential run produces.
type orderGate struct {
	done []chan struct{}
	once []sync.Once
}

func newOrderGate(n int) *orderGate {
	g := &orderGate{done: make([]chan struct{}, n), once: make([]sync.Once, n)}
	for i := range g.done {
		g.done[i] = make(chan struct{})
	}
	return g
}

// wait blocks until every earlier index has finished (or ctx ends).
func (g *orderGate) wait(ctx context.Context, idx int) error {
	if idx <= 0 {
		return ctx.Err()
	}
	select {
	case <-g.done[idx-1]:
		return ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}

// finish releases idx's successor; safe to call more than once.
func (g *orderGate) finish(idx int) { g.once[idx].Do(func() { close(g.done[idx]) }) }

func (e *engine) log(format string, args ...any) {
	if e.logf != nil {
		e.logf(format, args...)
	}
}

// loadLogo reads the logo of a logo watermark (nil for anything else).
func loadLogo(ctx context.Context, o Options) (image.Image, error) {
	if o.Watermark.Kind != WatermarkLogo {
		return nil, nil
	}
	img, err := decodeFile(ctx, o.Watermark.Logo)
	if err != nil {
		return nil, fmt.Errorf("read the logo: %w", err)
	}
	return img, nil
}

// compose is everything that happens in Go: layout, logo, flattening.
func compose(src image.Image, o Options, logo image.Image, previewMax int, format Format) *image.NRGBA {
	b := src.Bounds()
	l := PlanLayout(b.Dx(), b.Dy(), o)
	if previewMax > 0 {
		if long := max(l.Canvas.X, l.Canvas.Y); long > previewMax {
			l = l.Scaled(float64(previewMax) / float64(long))
		}
	}
	bg := backgroundOf(o.Background)
	canvas := renderCanvas(src, l, bg, o.Fit == FitPad)
	if logo != nil {
		overlayLogo(canvas, logo, o.Watermark)
	}
	if format == FormatJPG {
		canvas = flatten(canvas, bg)
	}
	return canvas
}

// processOne converts one picture and returns its result. workDir is an
// empty scratch directory.
func (e *engine) processOne(ctx context.Context, in string, o Options, logo image.Image, outDir, workDir string, idx, total int) (FileResult, error) {
	src, err := decodeFile(ctx, in)
	if err != nil {
		return FileResult{}, err
	}
	probe := isOpaque(src)
	format := outFormat(o.Format, in, probe)
	canvas := compose(src, o, logo, 0, format)
	src = nil

	var exif []byte
	if !o.Strip && format == FormatJPG {
		if ext := strings.ToLower(filepath.Ext(in)); ext == ".jpg" || ext == ".jpeg" {
			exif = ReadExif(in)
		}
	}
	stem := ExpandName(o.Name, core.StemName(in), idx+1, total, e.now())
	tmp := filepath.Join(workDir, "result"+format.ext())
	if err := e.encode(ctx, canvas, o, format, tmp, workDir, exif); err != nil {
		return FileResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return FileResult{}, fmt.Errorf("image batch cancelled: %w", err)
	}
	if e.gate != nil {
		if err := e.gate.wait(ctx, idx); err != nil {
			return FileResult{}, fmt.Errorf("image batch cancelled: %w", err)
		}
	}
	// Ordered section: UniquePath + move must not interleave (os.Rename
	// overwrites on Windows), and registration keeps input order.
	final := core.UniquePath(outDir, stem, format.ext())
	if err := moveFile(tmp, final); err != nil {
		return FileResult{}, core.Errorf(core.CodeToolFailed, "Couldn't save %s", filepath.Base(final)).WithCause(err)
	}
	st, err := os.Stat(final)
	if err != nil {
		return FileResult{}, fmt.Errorf("stat %s: %w", final, err)
	}
	fr := FileResult{Input: in, Output: final, Width: canvas.Bounds().Dx(), Height: canvas.Bounds().Dy(), Bytes: st.Size()}
	if e.saved != nil {
		if err := e.saved(in, fr); err != nil {
			return FileResult{}, err
		}
	}
	return fr, nil
}

// isOpaque reports whether src has no transparency, cheaply: only
// formats that can carry alpha are scanned.
func isOpaque(src image.Image) bool {
	switch s := src.(type) {
	case *image.NRGBA:
		return s.Opaque()
	case *image.RGBA:
		return s.Opaque()
	case *image.NRGBA64:
		return s.Opaque()
	case *image.RGBA64:
		return s.Opaque()
	case *image.Paletted:
		return s.Opaque()
	}
	return true
}

// encode writes canvas to path in the format: Go for JPEG and PNG, FFmpeg
// when there is text to draw or the format is WebP.
func (e *engine) encode(ctx context.Context, canvas *image.NRGBA, o Options, format Format, path, workDir string, exif []byte) error {
	text := o.Watermark.Kind == WatermarkText
	if !text && format != FormatWebP {
		var buf bytes.Buffer
		switch format {
		case FormatPNG:
			if err := png.Encode(&buf, canvas); err != nil {
				return fmt.Errorf("encode png: %w", err)
			}
		default:
			if err := jpeg.Encode(&buf, canvas, &jpeg.Options{Quality: o.Quality}); err != nil {
				return fmt.Errorf("encode jpeg: %w", err)
			}
		}
		data := buf.Bytes()
		if len(exif) > 0 {
			data = InjectExif(data, exif)
		}
		return writeFile(path, data)
	}

	ffmpeg, err := e.ffmpeg()
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, canvas); err != nil {
		return fmt.Errorf("encode stage png: %w", err)
	}
	if err := writeFile(filepath.Join(workDir, "stage.png"), buf.Bytes()); err != nil {
		return err
	}
	args := []string{"-hide_banner", "-nostdin", "-y", "-v", "error", "-i", "stage.png"}
	if text {
		if err := writeTextASS(filepath.Join(workDir, "wm.ass"), canvas.Bounds().Size(), o.Watermark); err != nil {
			return err
		}
		args = append(args, "-vf", "ass=wm.ass")
	}
	args = append(args, "-frames:v", "1")
	args = append(args, codecArgs(format, o.Quality)...)
	args = append(args, filepath.Base(path))
	if err := runFFmpeg(ctx, ffmpeg, workDir, args); err != nil {
		return err
	}
	if len(exif) > 0 && format == FormatJPG {
		b, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		return writeFile(path, InjectExif(b, exif))
	}
	return nil
}

// codecArgs are the FFmpeg output args of a format.
func codecArgs(f Format, quality int) []string {
	switch f {
	case FormatPNG:
		return []string{"-c:v", "png"}
	case FormatWebP:
		return []string{"-c:v", "libwebp", "-quality", strconv.Itoa(quality), "-compression_level", "4"}
	}
	// mjpeg's -q:v runs 2 (best) … 31; map quality 100…1 onto 1…31.
	q := 1 + int(float64(100-quality)*0.30+0.5)
	return []string{"-c:v", "mjpeg", "-q:v", strconv.Itoa(min(31, max(1, q))), "-pix_fmt", "yuvj420p"}
}

// writeTextASS writes the one-line script that draws the text watermark.
func writeTextASS(path string, size image.Point, w Watermark) error {
	short := min(size.X, size.Y)
	fontSize := max(8, int(float64(short)*w.Size/100+0.5))
	alpha := int((1-w.Opacity)*255 + 0.5)
	m := marginFor(size)
	doc := media.ASSDoc{
		PlayResX: size.X, PlayResY: size.Y,
		Styles: []media.ASSStyle{{
			Name: "WM", Font: w.Font, Size: float64(fontSize),
			Primary: w.Color, Secondary: w.Color, Outline: "#000000", Back: "#000000",
			PrimaryAlpha: alpha, SecondaryAlpha: alpha, OutlineAlpha: min(255, alpha+40), BackAlpha: 255,
			Bold: true, BorderStyle: 1, OutlineWidth: float64(fontSize) / 18,
			Alignment: assAlignment(w.Corner), MarginL: m, MarginR: m, MarginV: m,
		}},
		Events: []media.ASSEvent{{StartMs: 0, EndMs: 10_000, Style: "WM", Text: media.ASSEscape(w.Text)}},
	}
	var buf bytes.Buffer
	if _, err := doc.WriteTo(&buf); err != nil {
		return fmt.Errorf("write watermark script: %w", err)
	}
	return writeFile(path, buf.Bytes())
}

func runFFmpeg(ctx context.Context, ffmpeg, dir string, args []string) error {
	var last string
	res, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: args, Dir: dir, OnStderr: func(l string) { last = l }})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("image batch cancelled: %w", ctxErr)
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

func writeFile(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// preview renders in as the batch would, at most maxDim on the long side,
// and returns a data URL.
func (e *engine) preview(ctx context.Context, in string, o Options, workDir string, maxDim int) (string, error) {
	src, err := decodeFile(ctx, in)
	if err != nil {
		return "", err
	}
	logo, err := loadLogo(ctx, o)
	if err != nil {
		return "", err
	}
	format := outFormat(o.Format, in, isOpaque(src))
	canvas := compose(src, o, logo, maxDim, format)
	var out image.Image = canvas
	if o.Watermark.Kind == WatermarkText {
		ffmpeg, err := e.ffmpeg()
		if err != nil {
			return "", err
		}
		var buf bytes.Buffer
		if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, canvas); err != nil {
			return "", fmt.Errorf("encode stage png: %w", err)
		}
		if err := writeFile(filepath.Join(workDir, "stage.png"), buf.Bytes()); err != nil {
			return "", err
		}
		if err := writeTextASS(filepath.Join(workDir, "wm.ass"), canvas.Bounds().Size(), o.Watermark); err != nil {
			return "", err
		}
		args := []string{"-hide_banner", "-nostdin", "-y", "-v", "error", "-i", "stage.png", "-vf", "ass=wm.ass", "-frames:v", "1", "-c:v", "png", "marked.png"}
		if err := runFFmpeg(ctx, ffmpeg, workDir, args); err != nil {
			return "", err
		}
		f, err := os.Open(filepath.Join(workDir, "marked.png"))
		if err != nil {
			return "", fmt.Errorf("open marked preview: %w", err)
		}
		defer f.Close()
		if out, err = png.Decode(f); err != nil {
			return "", fmt.Errorf("decode marked preview: %w", err)
		}
	}
	return dataURL(out)
}

func dataURL(img image.Image) (string, error) {
	var buf bytes.Buffer
	if op, ok := img.(interface{ Opaque() bool }); ok && op.Opaque() {
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 88}); err != nil {
			return "", fmt.Errorf("encode preview: %w", err)
		}
		return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
	}
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, img); err != nil {
		return "", fmt.Errorf("encode preview: %w", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// moveFile renames src to dst, falling back to copy+remove across volumes.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return fmt.Errorf("copy to %s: %w", dst, err)
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return fmt.Errorf("close %s: %w", dst, err)
	}
	_ = in.Close()
	return os.Remove(src)
}
