package eraser

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/sidecar"
)

const (
	maxMaskSide     = 8192
	maxMaskBytes    = 64 << 20
	aspectTolerance = 0.01
	paintFirst      = "Paint over what to erase first"
)

func (m *Module) insideMaskDir(p string) bool {
	if m.maskDir == "" || p == "" || !filepath.IsAbs(p) {
		return false
	}
	return filepath.Dir(filepath.Clean(p)) == filepath.Clean(m.maskDir)
}

func (m *Module) validateOptions(o Options) error {
	fields := map[string]string{}
	if _, ok := models[o.Model]; !ok {
		fields["model"] = "Choose Best or Fast"
	}
	if !m.insideMaskDir(o.MaskPath) {
		fields["maskPath"] = paintFirst
	} else if fi, err := os.Stat(o.MaskPath); err != nil || !fi.Mode().IsRegular() {
		fields["maskPath"] = paintFirst
	}
	if len(fields) > 0 {
		return core.ValidationError("Some options are invalid", fields)
	}
	return nil
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return m.validateOptions(o)
}

// eventSink maps engine events onto a job and registers each output once.
type eventSink struct {
	job  *core.JobContext
	seen map[string]bool
	err  error
}

func (o *eventSink) register(path string) {
	if path == "" || o.seen[path] {
		return
	}
	o.seen[path] = true
	if _, err := o.job.Output(path); err != nil && o.err == nil {
		o.err = err
	}
}

func (o *eventSink) onEvent(ev sidecar.Event) {
	switch ev.Kind {
	case "progress":
		o.job.Progress(ev.Pct, ev.Msg)
	case "log":
		stream := core.StreamStdout
		if ev.Level == "warning" || ev.Level == "error" {
			stream = core.StreamStderr
		}
		o.job.Log(stream, ev.Line)
	case "output":
		o.register(ev.Path)
	}
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	// The mask is private to this job: remove it in every outcome (only when
	// it really is inside the mask folder).
	if m.insideMaskDir(o.MaskPath) {
		defer os.Remove(o.MaskPath)
	}
	if err := m.validateOptions(o); err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("Add a photo", map[string]string{"inputs": "Add a photo"})
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	if !m.modelPresent(string(o.Model)) {
		job.Progress(core.IndeterminateProgress, "Downloading the erasing model")
		if err := m.fetchModel(ctx, job, string(o.Model)); err != nil {
			return err
		}
	}
	spec := models[o.Model]
	input := job.Inputs[0]
	job.SetTitle(filepath.Base(input))
	sink := &eventSink{job: job, seen: map[string]bool{}}
	raw, err := m.sc.Call(ctx, "eraser.inpaint", map[string]any{
		"path":      input,
		"mask":      o.MaskPath,
		"out":       job.OutputDir,
		"model":     string(o.Model),
		"modelPath": m.modelFile(spec),
	}, sink.onEvent)
	if err != nil {
		return err
	}
	var res struct {
		Regions int    `json:"regions"`
		Warning string `json:"warning"`
		Output  string `json:"output"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	sink.register(res.Output)
	if sink.err != nil {
		return sink.err
	}
	result := Result{Regions: res.Regions, Warning: res.Warning, Outputs: []string{}}
	if res.Output != "" {
		result.Outputs = append(result.Outputs, res.Output)
	}
	if err := job.SetResult(result); err != nil {
		return err
	}
	msg := "Erased"
	if res.Warning != "" {
		msg = res.Warning
	}
	job.Progress(1, msg)
	return nil
}

// decodeMask decodes the canvas data (base64, optionally a data URL) and
// checks it is a PNG within limits.
func decodeMask(maskPNG string) ([]byte, image.Image, error) {
	s := strings.TrimSpace(maskPNG)
	if i := strings.Index(s, ","); strings.HasPrefix(s, "data:") && i >= 0 {
		s = s[i+1:]
	}
	if s == "" {
		return nil, nil, core.ValidationError(paintFirst, map[string]string{"mask": paintFirst})
	}
	if base64.StdEncoding.DecodedLen(len(s)) > maxMaskBytes {
		return nil, nil, core.ValidationError("The mask is too large", map[string]string{"mask": "Too large"})
	}
	data, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, nil, core.ValidationError("The mask isn't a valid PNG", map[string]string{"mask": "Not base64"})
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, nil, core.ValidationError("The mask isn't a valid PNG", map[string]string{"mask": "Not a PNG"})
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxMaskSide || cfg.Height > maxMaskSide {
		return nil, nil, core.ValidationError("The mask is too large", map[string]string{"mask": "Larger than 8192 px"})
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, nil, core.ValidationError("The mask isn't a valid PNG", map[string]string{"mask": "Not a PNG"})
	}
	return data, img, nil
}

// maskPainted reports whether any pixel is white (> 127) and not transparent
// (the engine's rule: luminance scaled by alpha, threshold 127).
func maskPainted(img image.Image) bool {
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			c := img.At(x, y)
			_, _, _, a := c.RGBA()
			if a == 0 {
				continue
			}
			l := uint32(color.GrayModel.Convert(c).(color.Gray).Y)
			if l*(a>>8)/255 > 127 {
				return true
			}
		}
	}
	return false
}

func aspectOK(mw, mh, iw, ih int) bool {
	ratio := func(w, h int) float64 { return float64(w) / float64(h) }
	m := ratio(mw, mh)
	for _, r := range []float64{ratio(iw, ih), ratio(ih, iw)} { // EXIF may rotate the photo
		if math.Abs(m-r)/r <= aspectTolerance {
			return true
		}
	}
	return false
}

func randomName() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("random mask name: %w", err)
	}
	return hex.EncodeToString(b[:]) + ".png", nil
}

func (m *Module) erase(jobs *core.Jobs, input, maskPNG string, opts Options) (core.Job, error) {
	if _, ok := models[opts.Model]; !ok {
		return core.Job{}, core.ValidationError("Choose Best or Fast", map[string]string{"model": "Choose Best or Fast"})
	}
	if err := core.ValidateFileInputs([]string{input}, Accepts()); err != nil {
		return core.Job{}, err
	}
	data, img, err := decodeMask(maskPNG)
	if err != nil {
		return core.Job{}, err
	}
	if !maskPainted(img) {
		return core.Job{}, core.ValidationError(paintFirst, map[string]string{"mask": paintFirst})
	}
	if sz, err := imaging.Size(input); err == nil && sz.W > 0 && sz.H > 0 {
		b := img.Bounds()
		if !aspectOK(b.Dx(), b.Dy(), sz.W, sz.H) {
			return core.Job{}, core.ValidationError("The mask doesn't match the photo's shape",
				map[string]string{"mask": "Wrong aspect ratio"})
		}
	}
	if m.maskDir == "" {
		return core.Job{}, core.Errorf(core.CodeInternal, "The mask folder isn't configured")
	}
	if err := os.MkdirAll(m.maskDir, 0o700); err != nil {
		return core.Job{}, fmt.Errorf("creating the mask folder: %w", err)
	}
	name, err := randomName()
	if err != nil {
		return core.Job{}, err
	}
	path := filepath.Join(m.maskDir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return core.Job{}, fmt.Errorf("writing the mask: %w", err)
	}
	opts.MaskPath = path
	raw, err := json.Marshal(opts)
	if err != nil {
		os.Remove(path)
		return core.Job{}, fmt.Errorf("encoding options: %w", err)
	}
	submitted, err := jobs.Submit(context.Background(), ModuleID, []string{input}, string(raw))
	if err != nil || len(submitted) == 0 {
		os.Remove(path)
		if err == nil {
			err = core.Errorf(core.CodeInternal, "The job wasn't queued")
		}
		return core.Job{}, err
	}
	return submitted[0], nil
}

// clearMasks empties the mask folder (leftovers from jobs cancelled while
// queued, or a crash).
func (m *Module) clearMasks() {
	if m.maskDir == "" {
		return
	}
	entries, err := os.ReadDir(m.maskDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		os.RemoveAll(filepath.Join(m.maskDir, e.Name()))
	}
}
