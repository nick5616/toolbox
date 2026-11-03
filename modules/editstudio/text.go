package editstudio

import (
	"context"

	"toolbox/core"
)

// Markers and captions files (SPEC.md §5.6, §11.7). WP-ES1 owns the markers
// kinds; the srt kind is writeSRT in srt.go (WP-ES9). Keep the dispatch.

// runText is the text action.
func (m *Module) runText(ctx context.Context, job *core.JobContext, req TextRequest) error {
	job.SetTitle("Saving " + req.Name)
	if req.Kind == TextSRT {
		return m.writeSRT(ctx, job, req)
	}
	return m.writeMarkers(ctx, job, req)
}

// writeMarkers writes markers CSV or JSON into the Library (job.OutputDir).
func (m *Module) writeMarkers(ctx context.Context, job *core.JobContext, req TextRequest) error {
	return notBuilt("Markers export")
}
