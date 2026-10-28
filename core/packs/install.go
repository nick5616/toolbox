package packs

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/deps"
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
	// Byte-weighted progress.
	weights := make([]float64, len(todo))
	var sum float64
	for i, c := range todo {
		sz, _ := s.size(c)
		weights[i] = float64(max(sz.Download, 1))
		sum += weights[i]
	}
	var done float64
	for i, c := range todo {
		if err := ctx.Err(); err != nil {
			return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(err)
		}
		lo, hi := done/sum, (done+weights[i])/sum
		done += weights[i]
		job.Progress(lo, "Installing "+c.Name)
		job.Logf("Installing %s", c.Name)
		if err := s.installComponent(ctx, job.Scoped(lo, hi), c); err != nil {
			s.notify()
			return componentError(c, err)
		}
		job.Progress(hi, c.Name+" installed")
		s.notify()
	}
	job.Progress(1, p.Name+" pack installed")
	return nil
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
