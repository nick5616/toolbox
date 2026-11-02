package visualizer

import (
	"context"
	"fmt"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// The auto action (SPEC.md §6.4): analyze with Options.Analyze, then render
// with the new analysis. Progress: 0–40 % analyze (it may be cached), then
// 40–100 % render.
const autoAnalyzeEnd = 0.4

func (m *Module) runAuto(ctx context.Context, job *core.JobContext, o Options) error {
	input := job.Inputs[0]
	job.SetTitle("Visualizing — " + filepath.Base(input))
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	ref, err := analyzeFn(ctx, m.an, job.Scoped(0, autoAnalyzeEnd), input, o.Analyze)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return fmt.Errorf("render cancelled: %w", ctx.Err())
	}
	job.Progress(autoAnalyzeEnd, "Analysis ready")

	ro := o
	ro.Action, ro.AnalysisKey = ActionRender, ref.Key
	if err := validateAudio(ro.Audio, ref.Instrumental != ""); err != nil {
		return err
	}
	var rendered Result
	err = m.render(ctx, job.Scoped(autoAnalyzeEnd, 1), ro, ref, func(v any) error {
		r, ok := v.(Result)
		if !ok {
			return fmt.Errorf("unexpected render result %T", v)
		}
		rendered = r
		return nil
	})
	if err != nil {
		return err
	}
	if rendered.Outputs == nil {
		rendered.Outputs = []string{}
	}
	return job.SetResult(Result{
		Action: ActionAuto, Analysis: &ref, Outputs: rendered.Outputs,
		Encoder: rendered.Encoder, Speed: rendered.Speed,
	})
}
