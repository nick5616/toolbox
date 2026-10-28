package upscale

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/imaging"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

const (
	noGPUMessage = "No compatible GPU found"
	noGPUHint    = "The upscaler needs a GPU with Vulkan support (any Apple Silicon Mac, or a recent NVIDIA/AMD/Intel GPU with current drivers)"

	// webpCompress is upscayl-bin's -c for WebP. Verified on the real binary:
	// -c is a compression level (0 = lossless, 100 = smallest), roughly
	// 100 - quality, so quality 90 is -c 10. It has no effect on JPEG output
	// (always quality 100) or PNG.
	webpCompress = 100 - LossyQuality
)

var (
	noGPURe = regexp.MustCompile(`(?i)invalid gpu device|vkCreateInstance failed|no vulkan|vkEnumeratePhysicalDevices`)
	// The real binary ends with a bare "100.00" (no percent sign).
	pctRe = regexp.MustCompile(`^\s*(\d+(?:\.\d+)?)(?:%|\s*$)`)

	// startupNotice is how long the GPU may stay silent before the message
	// explains that the first run is slow (shader compilation). A var for tests.
	startupNotice = 8 * time.Second
)

func validateOptions(o Options) error {
	fields := map[string]string{}
	if _, ok := models[o.Model]; !ok {
		fields["model"] = "Choose a valid model"
	}
	if o.Scale != 2 && o.Scale != 4 {
		fields["scale"] = "Choose 2× or 4×"
	}
	switch o.Format {
	case FormatSame, FormatPNG, FormatJPG, FormatWebP:
	default:
		fields["format"] = "Choose a valid format"
	}
	switch o.Device {
	case DeviceAuto, DeviceGPU, DeviceCPU:
	default:
		fields["device"] = "Choose automatic, GPU or CPU"
	}
	if len(fields) > 0 {
		return core.ValidationError("Some options are invalid", fields)
	}
	return nil
}

// checkSize applies the pixel caps for an image of size sz.
func checkSize(sz core.Size, scale int, device Device) error {
	w, h, s := int64(sz.W), int64(sz.H), int64(scale)
	if w*s*h*s > MaxOutputPixels {
		return core.ValidationError(fmt.Sprintf("Too large to upscale %d× (%d×%d → %d×%d); try 2× or a smaller image",
			scale, w, h, w*s, h*s), nil)
	}
	if device == DeviceCPU && w*h > MaxCPUInputPixels {
		return core.ValidationError("Too large for CPU upscaling (max 2 megapixels); use the GPU or a smaller image", nil)
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
	if o.Device == "" {
		o.Device = DeviceAuto
	}
	if err := validateOptions(o); err != nil {
		return err
	}
	fields := map[string]string{}
	first := ""
	for i, in := range inputs {
		if imaging.IsHEIC(in) {
			continue // Go can't read HEIC; the caps are checked in Run
		}
		var msg string
		if sz, err := imaging.Size(in); err != nil {
			msg = "Couldn't read this image"
		} else if err := checkSize(sz, o.Scale, o.Device); err != nil {
			msg = err.(*core.AppError).Message
		}
		if msg != "" {
			fields[fmt.Sprintf("inputs.%d", i)] = msg
			if first == "" {
				first = msg
			}
		}
	}
	if len(fields) == 1 {
		return core.ValidationError(first, fields)
	}
	if len(fields) > 1 {
		return core.ValidationError("Some files can't be upscaled", fields)
	}
	return nil
}

// outputExt picks the output extension (with dot).
func outputExt(f Format, input string, alpha bool) string {
	ext := ".png"
	switch f {
	case FormatPNG:
	case FormatJPG:
		ext = ".jpg"
	case FormatWebP:
		ext = ".webp"
	default: // same
		switch strings.ToLower(filepath.Ext(input)) {
		case ".jpg", ".jpeg":
			ext = ".jpg"
		case ".webp":
			ext = ".webp"
		}
	}
	// A PNG with transparency always stays PNG.
	if alpha && strings.EqualFold(filepath.Ext(input), ".png") {
		ext = ".png"
	}
	return ext
}

// hasAlpha reports whether a PNG has an alpha channel (or a palette with
// transparency). Other formats report false.
func hasAlpha(path string) bool {
	if !strings.EqualFold(filepath.Ext(path), ".png") {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	cfg, err := png.DecodeConfig(f)
	if err != nil {
		return false
	}
	switch cm := cfg.ColorModel.(type) {
	case color.Palette:
		for _, c := range cm {
			if _, _, _, a := c.RGBA(); a != 0xffff {
				return true
			}
		}
		return false
	}
	return cfg.ColorModel == color.NRGBAModel || cfg.ColorModel == color.NRGBA64Model
}

// outcome is the dimensions and device of a finished upscale.
type outcome struct {
	inW, inH, outW, outH int
	device               string
}

func isNoGPU(err error) bool {
	var ae *core.AppError
	return errors.As(err, &ae) && ae.Code == core.CodeDependencyMissing && ae.Message == noGPUMessage
}

func isDepMissing(err error) bool {
	var ae *core.AppError
	return errors.As(err, &ae) && ae.Code == core.CodeDependencyMissing
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if o.Device == "" {
		o.Device = DeviceAuto
	}
	if err := validateOptions(o); err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("Add at least one file", map[string]string{"inputs": "Add at least one file"})
	}
	input := job.Inputs[0]
	job.SetTitle(filepath.Base(input))

	src := input
	if imaging.IsHEIC(input) {
		if src, err = m.convertHEIC(ctx, job, input); err != nil {
			return err
		}
	}
	sz, err := imaging.Size(src)
	if err != nil {
		return core.Errorf(core.CodeValidation, "Couldn't read this image").WithCause(err)
	}
	if err := checkSize(sz, o.Scale, o.Device); err != nil {
		return err
	}
	ext := outputExt(o.Format, src, hasAlpha(src))

	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the output folder").WithCause(err)
	}
	tmp := filepath.Join(job.OutputDir, "."+core.NewID()+".tmp"+ext)
	defer os.Remove(tmp)

	out, err := m.process(ctx, job, o, src, sz, tmp, ext)
	if err != nil {
		return err
	}
	if fi, err := os.Stat(tmp); err != nil || fi.Size() == 0 {
		return failed(job, nil)
	}
	stem := fmt.Sprintf("%s (%dx)", core.StemName(input), o.Scale)
	final := core.UniquePath(job.OutputDir, stem, ext)
	if err := os.Rename(tmp, final); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the upscaled image").WithCause(err)
	}
	fi, err := os.Stat(final)
	if err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the upscaled image").WithCause(err)
	}
	if _, err := job.Output(final); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	res := Result{
		InWidth: out.inW, InHeight: out.inH, OutWidth: out.outW, OutHeight: out.outH,
		Model: o.Model, Scale: o.Scale, Device: out.device, Bytes: fi.Size(), Output: final,
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	msg := fmt.Sprintf("%d×%d → %d×%d", res.InWidth, res.InHeight, res.OutWidth, res.OutHeight)
	switch out.device {
	case "cpu":
		msg += " · CPU"
	case "mps":
		msg += " · GPU (MPS)"
	}
	job.Progress(1, msg)
	return nil
}

// process runs the upscale on the device(s) the options allow (SPEC §13.3).
func (m *Module) process(ctx context.Context, job *core.JobContext, o Options, src string, sz core.Size, tmp, ext string) (outcome, error) {
	switch o.Device {
	case DeviceGPU:
		exe, err := job.Tool(deps.Upscayl)
		if err != nil {
			return outcome{}, err
		}
		return m.runGPU(ctx, job, exe, o, src, sz, tmp, ext)
	case DeviceCPU:
		return m.runCPU(ctx, job, o, src, tmp, ext)
	}
	// Automatic: the GPU when installed, the engine as the fallback.
	var gpuErr error
	exe, err := job.Tool(deps.Upscayl)
	if err == nil {
		out, rerr := m.runGPU(ctx, job, exe, o, src, sz, tmp, ext)
		if rerr == nil || !isNoGPU(rerr) {
			return out, rerr
		}
		gpuErr = rerr
		job.Logf("No compatible GPU — using the CPU (slower)")
	} else if isDepMissing(err) {
		gpuErr = err
		job.Logf("The GPU upscaler isn't installed — using the CPU (slower)")
	} else {
		return outcome{}, err
	}
	if int64(sz.W)*int64(sz.H) > MaxCPUInputPixels {
		return outcome{}, gpuErr
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return outcome{}, gpuErr
	}
	_ = os.Remove(tmp)
	return m.runCPU(ctx, job, o, src, tmp, ext)
}

// failed builds the generic tool_failed error and logs the stderr tail.
func failed(job *core.JobContext, tail []string) error {
	if len(tail) > 5 {
		tail = tail[len(tail)-5:]
	}
	for _, l := range tail {
		job.Log(core.StreamStderr, l)
	}
	return core.Errorf(core.CodeToolFailed, "Upscaling failed")
}

func noGPUError() error {
	return (&core.AppError{Code: core.CodeDependencyMissing, Message: noGPUMessage}).WithHint(noGPUHint)
}

func (m *Module) runGPU(ctx context.Context, job *core.JobContext, exe string, o Options, src string, sz core.Size, tmp, ext string) (outcome, error) {
	gm := models[o.Model].GPU[o.Scale]
	modelsDir := filepath.Join(filepath.Dir(exe), "models")
	for _, e := range []string{".param", ".bin"} {
		if fi, err := os.Stat(filepath.Join(modelsDir, gm.Name+e)); err != nil || !fi.Mode().IsRegular() {
			return outcome{}, (&core.AppError{Code: core.CodeDependencyMissing, Message: "Upscaler models are missing"}).
				WithHint("Reinstall the upscaler from Settings → Dependencies")
		}
	}
	args := []string{
		"-i", src, "-o", tmp, "-n", gm.Name,
		"-z", strconv.Itoa(gm.ModelScale), "-s", strconv.Itoa(o.Scale),
		"-m", modelsDir,
	}
	if ext == ".webp" {
		args = append(args, "-c", strconv.Itoa(webpCompress))
	}
	args = append(args, "-t", "0")

	var (
		mu     sync.Mutex
		gotPct bool
		gpuHit bool
	)
	job.Progress(core.IndeterminateProgress, "Starting GPU…")
	notice := time.AfterFunc(startupNotice, func() {
		mu.Lock()
		defer mu.Unlock()
		if !gotPct {
			job.Progress(core.IndeterminateProgress, "Starting GPU — the first run can take up to a minute")
		}
	})
	defer notice.Stop()

	res, runErr := proc.Run(ctx, proc.Spec{
		Path: exe, Args: args,
		OnStderr: func(line string) {
			if mm := pctRe.FindStringSubmatch(line); mm != nil {
				pct, _ := strconv.ParseFloat(mm[1], 64)
				if pct > 100 {
					pct = 100
				}
				mu.Lock()
				gotPct = true
				mu.Unlock()
				job.Progress(pct/100, fmt.Sprintf("Upscaling · %d%%", int(pct)))
				return
			}
			if noGPURe.MatchString(line) {
				mu.Lock()
				gpuHit = true
				mu.Unlock()
			}
			job.Log(core.StreamStderr, line)
		},
	})
	notice.Stop()
	if ctxErr := ctx.Err(); ctxErr != nil {
		_ = os.Remove(tmp)
		return outcome{}, fmt.Errorf("upscaling cancelled: %w", ctxErr)
	}
	mu.Lock()
	noGPU := gpuHit
	mu.Unlock()
	if !noGPU {
		for _, l := range res.StderrTail {
			if noGPURe.MatchString(l) {
				noGPU = true
			}
		}
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return outcome{}, fmt.Errorf("run upscayl-bin: %w", runErr)
		}
		if noGPU {
			return outcome{}, noGPUError()
		}
		return outcome{}, failed(job, res.StderrTail)
	}
	fi, err := os.Stat(tmp)
	if err != nil || fi.Size() == 0 {
		if noGPU {
			return outcome{}, noGPUError()
		}
		return outcome{}, failed(job, res.StderrTail)
	}
	out := outcome{inW: sz.W, inH: sz.H, outW: sz.W * o.Scale, outH: sz.H * o.Scale, device: "gpu"}
	if got, err := imaging.Size(tmp); err == nil {
		out.outW, out.outH = got.W, got.H
	}
	return out, nil
}

// cpuResult is the engine's upscale.run result.
type cpuResult struct {
	InWidth   int    `json:"inWidth"`
	InHeight  int    `json:"inHeight"`
	OutWidth  int    `json:"outWidth"`
	OutHeight int    `json:"outHeight"`
	Device    string `json:"device"`
}

func (m *Module) runCPU(ctx context.Context, job *core.JobContext, o Options, src, tmp, ext string) (outcome, error) {
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return outcome{}, err
	}
	cm := models[o.Model].CPU
	params := map[string]any{
		"input":  src,
		"output": tmp,
		"model": map[string]any{
			"file": cm.File, "sha256": cm.SHA256, "url": cm.URL,
		},
		"modelDir": filepath.Join(m.modelsDir, "upscale"),
		"scale":    o.Scale,
		"format":   strings.TrimPrefix(ext, "."),
	}
	job.Progress(core.IndeterminateProgress, "Starting the AI engine…")
	raw, err := m.sc.Call(ctx, "upscale.run", params, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			job.Progress(ev.Pct, ev.Msg)
		case "log":
			stream := core.StreamStdout
			if ev.Level == "warning" || ev.Level == "error" {
				stream = core.StreamStderr
			}
			job.Log(stream, ev.Line)
		}
	})
	if err != nil {
		_ = os.Remove(tmp)
		return outcome{}, err
	}
	var r cpuResult
	if err := json.Unmarshal(raw, &r); err != nil {
		return outcome{}, core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	dev := r.Device
	if dev == "" {
		dev = "cpu"
	}
	return outcome{inW: r.InWidth, inH: r.InHeight, outW: r.OutWidth, outH: r.OutHeight, device: dev}, nil
}

// convertHEIC decodes a HEIC/HEIF photo to a PNG in the job's temp dir via
// the AI engine (SPEC §13.1).
func (m *Module) convertHEIC(ctx context.Context, job *core.JobContext, input string) (string, error) {
	if _, err := job.Tool(sidecar.DepID); err != nil {
		var ae *core.AppError
		if errors.As(err, &ae) && ae.Code == core.CodeDependencyMissing {
			return "", (&core.AppError{Code: core.CodeDependencyMissing, Message: "HEIC photos need the AI engine", Hint: ae.Hint}).WithCause(err)
		}
		return "", err
	}
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}
	out := filepath.Join(job.TempDir, core.StemName(input)+".png")
	job.Progress(core.IndeterminateProgress, "Reading the HEIC photo…")
	if _, err := m.sc.Call(ctx, "image.convert", map[string]any{"input": input, "output": out}, nil); err != nil {
		return "", err
	}
	if fi, err := os.Stat(out); err != nil || fi.Size() == 0 {
		return "", core.Errorf(core.CodeToolFailed, "Couldn't read this HEIC photo")
	}
	return out, nil
}
