// Package imagebatch resizes, crops or pads, converts, watermarks and renames
// batches of pictures (Phase 15, SPEC.md §2). Scaling and JPEG/PNG encoding
// are pure Go; text watermarks and WebP use FFmpeg.
package imagebatch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/par"
)

// ModuleID is Image Batch's module ID.
const ModuleID = "imagebatch"

// Module implements core.Module.
type Module struct{}

// Register adds the module to the registry.
func Register(reg *core.Registry) error { return reg.Register(&Module{}) }

// Accepts lists the input extensions (HEIC through the shared converter).
func Accepts() []string {
	return []string{".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"}
}

// maxFiles caps one submission.
const maxFiles = 500

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Image Batch", Icon: "image", Category: core.CategoryImage,
		Tagline:     "Resize, convert and watermark many photos",
		Description: "Resize by long side or exact size, crop or pad to a shape, convert to JPEG, PNG or WebP, add a text or logo watermark, strip metadata and rename with a pattern.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Order:       141, OutputSubdir: "Images", MaxInputs: maxFiles, MaxConcurrent: 1,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) == 0 {
		return core.ValidationError("Add at least one picture", map[string]string{"inputs": "Add at least one picture"})
	}
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return opts.Validate()
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := o.Validate(); err != nil {
		return err
	}
	logo, err := loadLogo(ctx, o)
	if err != nil {
		return err
	}
	e := &engine{
		ffmpeg: func() (string, error) { return job.Tool("ffmpeg") },
		now:    time.Now,
		logf:   job.Logf,
	}
	if len(job.Inputs) == 1 {
		job.SetTitle(filepath.Base(job.Inputs[0]))
	} else {
		job.SetTitle(fmt.Sprintf("%d pictures", len(job.Inputs)))
	}
	if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	n := len(job.Inputs)
	// Pictures are processed in parallel (decode, scale, encode); naming,
	// moving and registering happen in input order through the gate, so the
	// result is exactly what a sequential run gives. Bounded at min(4, half
	// the CPUs): a 24 MP decode is ~100 MB.
	e.gate = newOrderGate(n)
	e.saved = func(in string, fr FileResult) error {
		if _, err := job.OutputFrom(fr.Output, in); err != nil {
			return &fatalError{fmt.Errorf("register output: %w", err)}
		}
		return nil
	}
	type slot struct {
		fr     FileResult
		failed string
		ok     bool
	}
	slots := make([]slot, n)
	errs := make([]error, n)
	var (
		progMu sync.Mutex
		fin    int
	)
	report := func(msg string) {
		progMu.Lock()
		job.Progress(float64(fin)/float64(n), msg)
		progMu.Unlock()
	}
	err = par.ForEach(ctx, n, min(4, par.CPUHalf()), func(ctx context.Context, i int) error {
		in := job.Inputs[i]
		defer e.gate.finish(i)
		report(fmt.Sprintf("%s (%d of %d)", filepath.Base(in), i+1, n))
		work := filepath.Join(job.TempDir, fmt.Sprintf("f%d", i))
		if err := os.MkdirAll(work, 0o755); err != nil {
			return fmt.Errorf("create work dir: %w", err)
		}
		fr, err := e.processOne(ctx, in, o, logo, job.OutputDir, work, i, n)
		_ = os.RemoveAll(work)
		if err != nil {
			var fe *fatalError
			if errors.As(err, &fe) {
				return fe.error
			}
			if ctx.Err() != nil {
				return fmt.Errorf("image batch cancelled: %w", ctx.Err())
			}
			errs[i] = err
			why := err.Error()
			if msg := core.AsAppError(err); msg != nil {
				why = msg.Message
			}
			slots[i].failed = filepath.Base(in) + ": " + why
			job.Logf("%s: %v", filepath.Base(in), err)
		} else {
			slots[i].fr, slots[i].ok = fr, true
		}
		progMu.Lock()
		fin++
		progMu.Unlock()
		return nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("image batch cancelled: %w", ctx.Err())
		}
		return err
	}
	res := Result{Files: []FileResult{}, Failed: []string{}}
	var firstErr error
	for i := range slots {
		if slots[i].ok {
			res.Files = append(res.Files, slots[i].fr)
			continue
		}
		res.Failed = append(res.Failed, slots[i].failed)
		if firstErr == nil {
			firstErr = errs[i]
		}
	}
	if len(res.Files) == 0 {
		return firstErr
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	msg := fmt.Sprintf("Saved %d picture", len(res.Files))
	if len(res.Files) != 1 {
		msg += "s"
	}
	if len(res.Failed) > 0 {
		msg += fmt.Sprintf(", %d couldn't be processed", len(res.Failed))
	}
	job.Progress(1, msg)
	return nil
}

// fatalError marks a failure that stops the whole batch (a registration
// error), as opposed to one picture that couldn't be processed.
type fatalError struct{ error }

func (f *fatalError) Unwrap() error { return f.error }

// fontOK reports whether a text watermark's font is offered.
func fontOK(w Watermark) bool { return w.Kind != WatermarkText || media.ValidFont(w.Font) }
func fonts() []string         { return media.Fonts() }
