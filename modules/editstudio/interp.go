package editstudio

import (
	"context"

	"toolbox/core"
)

// Interpolated slow motion with FFmpeg minterpolate (SPEC.md §7.5). WP-ES4.

// InterpRange rounds a source range out to whole seconds.
func InterpRange(fromMs, toMs int64) (fromS, toS int64) {
	return fromMs / 1000, (toMs + 999) / 1000
}

// EnsureInterp makes (or reuses) the 4×-fps streams for a source range.
func (m *Module) EnsureInterp(ctx context.Context, job *core.JobContext, path string, fromMs, toMs int64, fps int, onProgress func(float64)) (preview, export EditStream, err error) {
	return EditStream{}, EditStream{}, notBuilt("Slow motion")
}

// InterpFor returns an existing interp stream of a tier, or nil.
func (m *Module) InterpFor(path string, fromMs, toMs int64, fps int, tier Tier) *EditStream {
	return nil
}

// runInterp is the interp action.
func (m *Module) runInterp(ctx context.Context, job *core.JobContext, req InterpRequest) error {
	return notBuilt("Slow motion")
}
