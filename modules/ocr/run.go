package ocr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"toolbox/core"
	"toolbox/core/sidecar"
)

const (
	renderDPI      = 200
	minTextChars   = 20 // a page with at least this many non-space characters "has text"
	renderShare    = 0.25
	encryptedMsg   = "Remove this PDF's password first (PDF Toolkit → Remove password)"
	methodImage    = "ocr.image"
	methodPDF      = "ocr.pdf"
	previewMaxRune = 2000
)

// withDefaults fills empty enum fields so partial option JSON still works.
func withDefaults(o Options) Options {
	d := DefaultOptions()
	if o.Language == "" {
		o.Language = d.Language
	}
	if o.PDFOutput == "" {
		o.PDFOutput = d.PDFOutput
	}
	if o.ImageOutput == "" {
		o.ImageOutput = d.ImageOutput
	}
	return o
}

func validateOptions(o Options) error {
	fields := map[string]string{}
	if _, ok := presets[o.Language]; !ok {
		fields["language"] = "Choose a supported language"
	}
	switch o.PDFOutput {
	case PDFSearchable, PDFText, PDFBoth:
	default:
		fields["pdfOutput"] = "Choose searchable PDF, text or both"
	}
	switch o.ImageOutput {
	case ImageText, ImageJSON:
	default:
		fields["imageOutput"] = "Choose text or text with positions"
	}
	if len(fields) > 0 {
		return core.ValidationError("Some options are invalid", fields)
	}
	return nil
}

func isPDF(path string) bool { return strings.EqualFold(filepath.Ext(path), ".pdf") }

// looksEncrypted reports whether the PDF has an /Encrypt entry (in the trailer or
// the cross-reference stream dictionary, both stored unencrypted).
func looksEncrypted(doc []byte) bool { return bytes.Contains(doc, []byte("/Encrypt")) }

func encryptedError() error {
	return core.ValidationError(encryptedMsg, map[string]string{"inputs": encryptedMsg})
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if err := validateOptions(withDefaults(o)); err != nil {
		return err
	}
	for _, in := range inputs {
		if !isPDF(in) {
			continue
		}
		doc, err := os.ReadFile(in)
		if err != nil {
			return fmt.Errorf("read %s: %w", in, err)
		}
		if looksEncrypted(doc) {
			return encryptedError()
		}
	}
	return nil
}

// eventSink maps sidecar events onto a job; progress is rescaled into [lo, hi].
type eventSink struct {
	job    *core.JobContext
	lo, hi float64
	seen   map[string]bool
	err    error
}

func (s *eventSink) register(path string) {
	if path == "" || s.seen[path] {
		return
	}
	s.seen[path] = true
	if _, err := s.job.Output(path); err != nil && s.err == nil {
		s.err = err
	}
}

func (s *eventSink) onEvent(ev sidecar.Event) {
	switch ev.Kind {
	case "progress":
		pct := ev.Pct
		if pct >= 0 {
			pct = s.lo + pct*(s.hi-s.lo)
		}
		s.job.Progress(pct, ev.Msg)
	case "log":
		stream := core.StreamStdout
		if ev.Level == "warning" || ev.Level == "error" {
			stream = core.StreamStderr
		}
		s.job.Log(stream, ev.Line)
	case "output":
		s.register(ev.Path)
	}
}

// modelParams turns a preset entry into the engine's model table (nil = bundled).
func modelParams(e *modelEntry) any {
	if e == nil {
		return nil
	}
	return map[string]any{"file": e.File, "url": e.URL, "sha256": e.SHA256}
}

func (m *Module) baseParams(o Options, input string, job *core.JobContext) map[string]any {
	p := presets[o.Language]
	return map[string]any{
		"input":     input,
		"outputDir": job.OutputDir,
		"baseName":  core.StemName(input),
		"det":       modelParams(p.Det),
		"rec":       modelParams(p.Rec),
		"modelDir":  filepath.Join(m.modelsDir, "ocr"),
	}
}

// groupInt formats n with thousands separators.
func groupInt(n int) string {
	s := fmt.Sprintf("%d", n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", one)
	}
	return fmt.Sprintf("%s %s", groupInt(n), many)
}

func imageSummary(r Result) string {
	return fmt.Sprintf("%s · %s", plural(r.Lines, "line", "lines"), plural(r.Characters, "character", "characters"))
}

func pdfSummary(r Result) string {
	parts := []string{plural(r.Pages, "page", "pages")}
	if r.PagesSkipped > 0 {
		parts = append(parts, fmt.Sprintf("%d already had text", r.PagesSkipped))
	}
	parts = append(parts, plural(r.Characters, "character", "characters"))
	return strings.Join(parts, " · ")
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	o = withDefaults(o)
	if err := validateOptions(o); err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("Add at least one file", map[string]string{"inputs": "Add at least one file"})
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	input := job.Inputs[0]
	job.SetTitle(filepath.Base(input))
	if isPDF(input) {
		return m.runPDF(ctx, job, o, input)
	}
	return m.runImage(ctx, job, o, input)
}

func (m *Module) runImage(ctx context.Context, job *core.JobContext, o Options, input string) error {
	params := m.baseParams(o, input, job)
	params["output"] = string(o.ImageOutput)
	sink := &eventSink{job: job, hi: 1, seen: map[string]bool{}}
	raw, err := m.sc.Call(ctx, methodImage, params, sink.onEvent)
	if err != nil {
		return err
	}
	var res struct {
		Lines          int     `json:"lines"`
		Characters     int     `json:"characters"`
		MeanConfidence float64 `json:"meanConfidence"`
		Output         string  `json:"output"`
		Preview        string  `json:"preview"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	sink.register(res.Output)
	if sink.err != nil {
		return sink.err
	}
	preview := res.Preview
	if r := []rune(preview); len(r) > previewMaxRune {
		preview = string(r[:previewMaxRune])
	}
	out := Result{Kind: "image", Lines: res.Lines, Characters: res.Characters, MeanConfidence: res.MeanConfidence,
		Preview: preview, Outputs: nonEmpty(res.Output)}
	if err := job.SetResult(out); err != nil {
		return err
	}
	job.Progress(1, imageSummary(out))
	return nil
}

func nonEmpty(s string) []string {
	if s == "" {
		return []string{}
	}
	return []string{s}
}

func nonSpaceRunes(s string) int {
	n := 0
	for _, r := range s {
		if !unicode.IsSpace(r) {
			n++
		}
	}
	return n
}

func (m *Module) runPDF(ctx context.Context, job *core.JobContext, o Options, input string) error {
	doc, err := os.ReadFile(input)
	if err != nil {
		return fmt.Errorf("read %s: %w", input, err)
	}
	if looksEncrypted(doc) {
		return encryptedError()
	}
	n, err := m.pdf.PageCount(ctx, doc, "")
	if err != nil {
		if core.IsCode(err, core.CodeValidation) && strings.Contains(strings.ToLower(err.Error()), "password") {
			return encryptedError()
		}
		return err
	}
	if n < 1 {
		return core.ValidationError("This PDF has no pages", nil)
	}
	dir := filepath.Join(job.TempDir, "pages")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create page folder: %w", err)
	}
	type pageParam struct {
		Page int    `json:"page"`
		PNG  string `json:"png"`
		Skip bool   `json:"skip"`
	}
	pages := make([]pageParam, 0, n)
	for i := 1; i <= n; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		job.Progress(renderShare*float64(i-1)/float64(n), fmt.Sprintf("Rendering %d/%d", i, n))
		if o.SkipText {
			txt, err := m.pdf.PageText(ctx, doc, "", i)
			if err == nil && nonSpaceRunes(txt) >= minTextChars {
				pages = append(pages, pageParam{Page: i, Skip: true})
				continue
			}
			if err != nil && ctx.Err() != nil {
				return ctx.Err()
			}
		}
		img, err := m.pdf.Render(ctx, doc, "", i, renderDPI)
		if err != nil {
			return err
		}
		path := filepath.Join(dir, fmt.Sprintf("p%04d.png", i))
		if err := writePNG(path, img); err != nil {
			return err
		}
		pages = append(pages, pageParam{Page: i, PNG: path})
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	job.Progress(renderShare, "Starting text recognition")

	params := m.baseParams(o, input, job)
	params["pages"] = pages
	params["dpi"] = renderDPI
	params["pdfOutput"] = string(o.PDFOutput)
	sink := &eventSink{job: job, lo: renderShare, hi: 1, seen: map[string]bool{}}
	raw, err := m.sc.Call(ctx, methodPDF, params, sink.onEvent)
	if err != nil {
		return err
	}
	var res Result
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	res.Kind = "pdf"
	for _, p := range res.Outputs {
		sink.register(p)
	}
	if sink.err != nil {
		return sink.err
	}
	if res.Outputs == nil {
		res.Outputs = []string{}
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, pdfSummary(res))
	return nil
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(f, img); err != nil {
		f.Close()
		return fmt.Errorf("encode page image: %w", err)
	}
	return f.Close()
}
