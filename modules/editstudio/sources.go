package editstudio

import (
	"context"

	"toolbox/core"
)

// Edit streams, prepare jobs and source state (SPEC.md §7.1, §7.6). WP-ES4.

// notBuilt is what a Wave 0 stub returns until its work package lands.
func notBuilt(what string) error {
	return core.Errorf(core.CodeInternal, "%s isn't built yet", what)
}

// Tier is which copy of a source a stream is.
type Tier string

const (
	TierPreview Tier = "preview" // short side ≤ 540, for the live preview
	TierExport  Tier = "export"  // short side ≤ the output's long side
)

// PreviewShort is the preview tier's short side for an upright source of w×h.
func PreviewShort(w, h int) int { return 0 }

// ExportShort is the export tier's short side for a source of w×h and an
// output of outW×outH.
func ExportShort(w, h, outW, outH int) int { return 0 }

// EnsureStream makes (or reuses) the edit stream of path at a short side and
// fps, reporting 0..1 progress. Concurrent calls for one stream wait for one
// transcode.
func (m *Module) EnsureStream(ctx context.Context, job *core.JobContext, path string, short, fps int, onProgress func(float64)) (EditStream, error) {
	return EditStream{}, notBuilt("Edit sources")
}

// StreamFor returns an existing edit stream, or nil.
func (m *Module) StreamFor(path string, short, fps int) *EditStream { return nil }

// runPrepare is the prepare action: preview streams and shots for videos,
// preview images for photos; per-file failures go into the result.
func (m *Module) runPrepare(ctx context.Context, job *core.JobContext, req PrepareRequest) error {
	return notBuilt("Preparing sources")
}

// sourceStates reports what exists for paths at fps without doing work
// (Preparing is filled in by the service from the running jobs).
func (m *Module) sourceStates(ctx context.Context, paths []string, fps int) ([]SourceState, error) {
	out := make([]SourceState, 0, len(paths))
	for _, p := range paths {
		out = append(out, SourceState{Path: p})
	}
	return out, nil
}
