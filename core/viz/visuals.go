package viz

import (
	"context"

	"toolbox/core"
	"toolbox/core/lyrics"
)

// RenderVisuals analyses input (cached), then renders spec's design without
// text at w×h/fps (SPEC.md §4.3). Progress is mapped into [p0, p1]. AN2's.
func RenderVisuals(ctx context.Context, job *core.JobContext, a *Analyzer, b *RenderBroker,
	input string, spec VisualsSpec, lines []lyrics.Line, w, h, fps int, mode RenderMode, p0, p1 float64) (RenderOutput, error) {
	return RenderOutput{}, core.Errorf(core.CodeInternal, "not built yet")
}
