package packs

import (
	"context"
	"encoding/json"
	"slices"
	"sync"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/par"
	"toolbox/core/sidecar"
)

// installerModules maps a dependency to the hidden module that installs it.
var installerModules = map[string]string{
	deps.YtDlp:    deps.UpdateModuleID,
	deps.ExifTool: deps.ExifToolUpdateModuleID,
	deps.Upscayl:  deps.UpscalerInstallModuleID,
	sidecar.DepID: sidecar.SetupModuleID,
	deps.Llama:    deps.LlamaInstallModuleID,
	deps.FFmpeg:   deps.FFmpegInstallModuleID,
	deps.Deno:     deps.DenoInstallModuleID,
	deps.Pandoc:   deps.PandocInstallModuleID,
	deps.Typst:    deps.TypstInstallModuleID,
	deps.Monolith: deps.MonolithInstallModuleID,
}

// installModule is the hidden system-pack-install module: one job installs
// the missing components of one pack (SPEC.md §7.9).
type installModule struct{ s *Service }

func (m *installModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: InstallModuleID, Name: "Install tool pack", Tagline: "Download the tools of a pack",
		Icon: "package", Category: core.CategoryUtility, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 1,
	}
}

func (m *installModule) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) > 0 {
		return core.ValidationError("This task takes no inputs", nil)
	}
	o, err := core.DecodeOptionsJSON[InstallOptions](options)
	if err != nil {
		return err
	}
	p, ok := packByID(o.Pack)
	if !ok {
		return core.ValidationError("Unknown tool pack", map[string]string{"pack": o.Pack})
	}
	for _, id := range o.Only {
		if !slices.Contains(p.Components, id) {
			return core.ValidationError("That component isn't part of this pack", map[string]string{"only": id})
		}
	}
	return nil
}

// pending lists the pack's components that need installing (missing or
// outdated), restricted to only when given, in pack order.
func (s *Service) pending(p PackSpec, only []string) []ComponentSpec {
	st := s.states()
	var out []ComponentSpec
	for _, id := range p.Components {
		if len(only) > 0 && !slices.Contains(only, id) {
			continue
		}
		if v := st[id]; v == core.ComponentMissing || v == core.ComponentOutdated {
			c, _ := componentByID(id)
			out = append(out, c)
		}
	}
	return out
}

func (m *installModule) Run(ctx context.Context, job *core.JobContext) error {
	s := m.s
	o, err := core.DecodeOptions[InstallOptions](job)
	if err != nil {
		return err
	}
	p, ok := packByID(o.Pack)
	if !ok {
		return core.ValidationError("Unknown tool pack", map[string]string{"pack": o.Pack})
	}
	job.SetTitle("Install " + p.Name + " pack")
	if reason := s.unsupportedReason(p.ID); reason != "" {
		return core.ValidationError(p.Name+" isn't available on this computer", nil).WithHint(reason)
	}
	s.ensureMarker()
	todo := s.pending(p, o.Only)
	if len(todo) == 0 {
		job.Progress(1, "Already installed")
		return nil
	}
	// Byte-weighted progress, summed over the components running at once.
	weights := make([]float64, len(todo))
	for i, c := range todo {
		sz, _ := s.size(c)
		weights[i] = float64(max(sz.Download, 1))
	}
	agg := newInstallProgress(job, weights)

	// Tools (different hosts, no dependency on each other) install together,
	// three at a time; model downloads need the AI engine, so they follow,
	// two at a time. The first failure cancels the rest.
	var tools, models []int
	for i, c := range todo {
		if c.Kind == core.ComponentModel {
			models = append(models, i)
		} else {
			tools = append(tools, i)
		}
	}
	runPhase := func(idx []int, limit int) error {
		return par.ForEach(ctx, len(idx), limit, func(ctx context.Context, k int) error {
			i := idx[k]
			c := todo[i]
			agg.log("Installing %s", c.Name)
			agg.update(i, 0, "Installing "+c.Name)
			child := agg.child(job, i, c.Name)
			if err := s.installComponent(ctx, child, c); err != nil {
				s.notify()
				if ctx.Err() != nil && !core.IsCode(err, core.CodeCancelled) {
					// Stopped because a sibling failed or the job was cancelled.
					return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(ctx.Err())
				}
				return componentError(c, err)
			}
			agg.update(i, 1, c.Name+" installed")
			s.notify()
			return nil
		})
	}
	err = runPhase(tools, 3)
	if err == nil {
		err = runPhase(models, 2)
	}
	if err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(cerr)
		}
		return err
	}
	job.Progress(1, p.Name+" pack installed")
	return nil
}

// installProgress folds the progress of components installing at the same
// time into one monotonic 0..1 value and serialises every call into the job.
type installProgress struct {
	mu      sync.Mutex
	job     *core.JobContext
	weights []float64
	sum     float64
	frac    []float64
	last    float64
}

func newInstallProgress(job *core.JobContext, weights []float64) *installProgress {
	a := &installProgress{job: job, weights: weights, frac: make([]float64, len(weights))}
	for _, w := range weights {
		a.sum += w
	}
	return a
}

// update records component i at fraction f (never going backwards) and
// reports the summed progress, which never goes backwards either.
func (a *installProgress) update(i int, f float64, msg string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.set(i, f)
	a.job.Progress(a.last, msg)
}

func (a *installProgress) set(i int, f float64) {
	if f >= 0 {
		a.frac[i] = max(a.frac[i], min(f, 1))
	}
	var t float64
	for j, fj := range a.frac {
		t += a.weights[j] * fj
	}
	a.last = max(a.last, min(t/a.sum, 1))
}

func (a *installProgress) log(format string, args ...any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.job.Logf(format, args...)
}

// child is the job context handed to component i: progress feeds the
// aggregate, log lines are prefixed with the component's name, and every
// call into the parent job is serialised.
func (a *installProgress) child(parent *core.JobContext, i int, name string) *core.JobContext {
	base := *parent
	return core.NewJobContext(base, core.JobHooks{
		Progress: func(pct float64, msg string) {
			if msg != "" {
				msg = name + ": " + msg
			}
			a.mu.Lock()
			defer a.mu.Unlock()
			a.set(i, pct) // indeterminate (< 0) keeps the current position
			a.job.Progress(a.last, msg)
		},
		Log: func(stream core.LogStream, line string) {
			a.mu.Lock()
			defer a.mu.Unlock()
			a.job.Log(stream, "["+name+"] "+line)
		},
		Title: func(title string) {
			a.mu.Lock()
			defer a.mu.Unlock()
			a.job.SetTitle(title)
		},
		Output: func(path string) (core.Output, error) {
			a.mu.Lock()
			defer a.mu.Unlock()
			return a.job.Output(path)
		},
		OutputFrom: func(path string, inputs []string) (core.Output, error) {
			a.mu.Lock()
			defer a.mu.Unlock()
			return a.job.OutputFrom(path, inputs...)
		},
		Tool: func(depID string) (string, error) {
			a.mu.Lock()
			defer a.mu.Unlock()
			return a.job.Tool(depID)
		},
		Result: func(r json.RawMessage) {
			a.mu.Lock()
			defer a.mu.Unlock()
			_ = a.job.SetResult(r)
		},
	})
}

// installComponent installs one component inside the pack job.
func (s *Service) installComponent(ctx context.Context, job *core.JobContext, c ComponentSpec) error {
	switch c.Kind {
	case core.ComponentModel:
		p := s.provider(c.Module)
		if p == nil {
			return core.Errorf(core.CodeInternal, "%s can't be downloaded in this build", c.Name)
		}
		return p.FetchModel(ctx, job, c.Preset)
	case core.ComponentDep:
		id, ok := installerModules[c.DepID]
		if !ok || s.cfg.Reg == nil {
			return core.Errorf(core.CodeInternal, "%s can't be installed in this build", c.Name)
		}
		mod, ok := s.cfg.Reg.Get(id)
		if !ok {
			return core.Errorf(core.CodeInternal, "%s can't be installed in this build", c.Name)
		}
		// Installer modules take no options; give them an empty set.
		inner := *job
		inner.Options = json.RawMessage("{}")
		inner.Inputs = nil
		return mod.Run(ctx, &inner)
	}
	return core.Errorf(core.CodeInternal, "Unknown component %s", c.ID)
}

// componentError names the failing component in an AppError and keeps its
// code and hint. Cancellations pass through untouched.
func componentError(c ComponentSpec, err error) error {
	if core.IsCode(err, core.CodeCancelled) {
		return err
	}
	ae := core.AsAppError(err)
	out := core.Errorf(ae.Code, "%s: %s", c.Name, ae.Message)
	out.Hint, out.Fields, out.Err = ae.Hint, ae.Fields, err
	return out
}
