// Package compress is Compress to Size (Phase 17, docs/specs/phase-17.md):
// any file in, the same thing out under a size limit, made as good as it can
// be at that size (re-encoding, scaling, recompressing pictures, zipping).
package compress

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
)

// ModuleID is Compress to Size's module ID.
const ModuleID = "compress"

// Module implements core.Module.
type Module struct {
	resolve toolFunc
}

// Register adds the module to the registry. resolve finds ffmpeg/ffprobe
// (deps.Service.Resolve); nil in tests.
func Register(reg *core.Registry, resolve func(depID string) (string, error)) error {
	return reg.Register(&Module{resolve: resolve})
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Compress to Size", Icon: "shrink", Category: core.CategoryUtility,
		Tagline:     "Make any file fit under a size limit",
		Description: "Pick where a file is going (Discord, Gmail, WhatsApp, …) or type a size, and it comes out under the limit: video and audio re-encoded to fit, photos and PDFs recompressed, Office files' pictures shrunk, anything else zipped.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Any: true},
		Requires:    []string{},
		Recommends:  []string{"ffmpeg", "ffprobe"},
		Order:       225, OutputSubdir: "Compressed", SplitInputs: true, MaxInputs: 200,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) == 0 {
		return core.ValidationError("Choose a file to compress", nil)
	}
	if err := validateInputs(inputs); err != nil {
		return err
	}
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return opts.Validate()
}

// validateInputs checks every input is an existing regular file.
func validateInputs(inputs []string) error {
	fields := map[string]string{}
	for i, in := range inputs {
		key := fmt.Sprintf("inputs.%d", i)
		if !filepath.IsAbs(in) {
			fields[key] = "File not found"
			continue
		}
		fi, err := os.Stat(in)
		switch {
		case err != nil:
			fields[key] = "File not found"
		case !fi.Mode().IsRegular():
			fields[key] = "Not a file (folders aren't supported yet)"
		}
	}
	if len(fields) > 0 {
		return core.ValidationError("Some files can't be used", fields)
	}
	return nil
}

// input is one file to compress, as the per-kind runners and estimators see it.
type input struct {
	Path  string
	Size  int64 // bytes
	Limit int64 // bytes every output must stay at or under
	Opts  Options
}

// runFunc compresses one file. It registers its outputs with job.Output and
// returns Outputs, Plan, Grade, Attempts and Parts; Run fills in the sizes.
// An output over the limit after MaxAttempts is an error (overLimit).
type runFunc func(ctx context.Context, job *core.JobContext, in input) (Result, error)

// estimateFunc says what compressing would do, quickly (probing only). It
// fills Possible, Plan, Grade, Parts, Note and Problem; the caller fills the rest.
type estimateFunc func(ctx context.Context, tool toolFunc, in input) Estimate

var runners = map[Kind]runFunc{
	KindVideo: runVideo, KindAudio: runAudio, KindImage: runImage, KindGIF: runGIF,
	KindPDF: runPDF, KindOffice: runOffice, KindOther: runOther,
}

var estimators = map[Kind]estimateFunc{
	KindVideo: estimateVideo, KindAudio: estimateAudio, KindImage: estimateImage, KindGIF: estimateGIF,
	KindPDF: estimatePDF, KindOffice: estimateOffice, KindOther: estimateOther,
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := opts.Validate(); err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return core.ValidationError("Choose one file to compress", nil)
	}
	path := job.Inputs[0]
	size, err := fileSize(path)
	if err != nil {
		return core.ValidationError("File not found", nil).WithCause(err)
	}
	job.SetTitle(filepath.Base(path))
	in := input{Path: path, Size: size, Limit: opts.Limit(), Opts: opts}
	kind := KindOf(path)

	var res Result
	if size <= in.Limit {
		job.Progress(core.IndeterminateProgress, "Already fits, copying…")
		out, err := copyOutput(job, path)
		if err != nil {
			return err
		}
		res = Result{Outputs: []string{out}, AlreadyFit: true, Plan: "Unchanged", Parts: 1}
	} else {
		res, err = runners[kind](ctx, job, in)
		if err != nil {
			return err
		}
	}
	res.Input, res.Kind, res.OriginalBytes, res.LimitBytes = path, kind, size, in.Limit
	if res.Outputs == nil {
		res.Outputs = []string{}
	}
	if res.Parts == 0 {
		res.Parts = len(res.Outputs)
	}
	res.Fits = len(res.Outputs) > 0
	for _, o := range res.Outputs {
		n, err := fileSize(o)
		if err != nil {
			return err
		}
		res.TotalBytes += n
		res.FinalBytes = max(res.FinalBytes, n)
		if n > in.Limit {
			res.Fits = false
		}
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	switch {
	case res.AlreadyFit:
		job.Progress(1, "Already fits")
	case res.Parts > 1:
		job.Progress(1, fmt.Sprintf("%d parts, each under %s", res.Parts, FormatBytes(in.Limit)))
	default:
		job.Progress(1, fmt.Sprintf("%s → %s", FormatBytes(size), FormatBytes(res.FinalBytes)))
	}
	return nil
}

// estimate is Service.Estimate for one file.
func (m *Module) estimate(ctx context.Context, path string, opts Options) Estimate {
	e := Estimate{Path: path, Name: filepath.Base(path), Kind: KindOf(path), LimitBytes: opts.Limit()}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		e.Problem = "File not found"
		return e
	}
	e.OriginalBytes = fi.Size()
	if e.OriginalBytes <= e.LimitBytes {
		e.AlreadyFits, e.Possible, e.Plan, e.Parts = true, true, "Already fits", 1
		return e
	}
	tool := m.resolve
	if tool == nil {
		tool = func(string) (string, error) { return "", core.ErrDependencyMissing("ffmpeg", "Install the Media pack") }
	}
	if needsFFmpeg(e.Kind) {
		if _, err := tool("ffmpeg"); err != nil {
			e.Problem = "Needs FFmpeg: install the Media pack"
			return e
		}
	}
	got := estimators[e.Kind](ctx, tool, input{Path: path, Size: e.OriginalBytes, Limit: e.LimitBytes, Opts: opts})
	e.Possible, e.Plan, e.Grade, e.Parts, e.Note, e.Problem = got.Possible, got.Plan, got.Grade, got.Parts, got.Note, got.Problem
	if e.Parts == 0 {
		e.Parts = 1
	}
	return e
}
