package editstudio

import (
	"context"

	"toolbox/core"
)

// Captions as SubRip (SPEC.md §14.9). WP-ES9.

// writeSRT writes req.Cues (timeline ms) as <name>.srt into the Library
// (job.OutputDir) with subtitles.FormatSRT.
func (m *Module) writeSRT(ctx context.Context, job *core.JobContext, req TextRequest) error {
	return notBuilt("SRT export")
}
