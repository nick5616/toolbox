package paint

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// CONTRACT STUBS (Wave 0). Each package deletes its stubs from this file as
// it implements them in its own files:
//   P3: projects.go, export.go, run.go (create … exportAs, validate, run)
//   P4: ai.go (submitAI, aiResult, aiStatus, warm, AIModule.Run/Validate)
//   B1: brushes.go, brushimport/ (brushSets … exportBrushSet)
// The file is gone once every stub is implemented.

// ---- P3 ----

func (m *Module) create(ctx context.Context, name string, w, h int, background string) (string, error) {
	return "", core.NotImplemented("New canvas")
}

func (m *Module) createFromImage(ctx context.Context, path, name string, fit bool) (string, error) {
	return "", core.NotImplemented("Open image")
}

func (m *Module) load(ctx context.Context, id string) (PaintDoc, error) {
	return PaintDoc{}, core.NotImplemented("Open project")
}

func (m *Module) tiles(id, layerID string, keys []string) (map[string]string, error) {
	return map[string]string{}, core.NotImplemented("Load tiles")
}

func (m *Module) saveTiles(id, layerID string, tiles map[string]string, removed []string) error {
	return core.NotImplemented("Save tiles")
}

func (m *Module) saveDoc(ctx context.Context, id, name string, doc PaintDoc) error {
	return core.NotImplemented("Save")
}

func (m *Module) saveThumb(id, jpegDataURL, renderPNGDataURL string) error {
	return core.NotImplemented("Save thumbnail")
}

func (m *Module) rename(ctx context.Context, id, name string) error {
	return core.NotImplemented("Rename")
}

func (m *Module) duplicate(ctx context.Context, id string) (string, error) {
	return "", core.NotImplemented("Duplicate")
}

func (m *Module) importLayer(ctx context.Context, id, path string) (PaintLayer, error) {
	return PaintLayer{}, core.NotImplemented("Import layer")
}

func (m *Module) importORA(ctx context.Context, path string) (string, error) {
	return "", core.NotImplemented("Open OpenRaster")
}

func (m *Module) submitExport(jobs *core.Jobs, opts ExportOptions) (core.Job, error) {
	return core.Job{}, core.NotImplemented("Export")
}

func (m *Module) exportAs(ctx context.Context, opts ExportOptions) (string, error) {
	return "", core.NotImplemented("Export as")
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	return core.NotImplemented("Paint+ jobs")
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("Paint+ jobs")
}

// ---- P4 ----

func (m *Module) submitAI(jobs *core.Jobs, projectID string, req AIRequest) (core.Job, error) {
	return core.Job{}, core.NotImplemented("Lab perception tools")
}

func (m *Module) aiResult(jobID string, index int) (string, error) {
	return "", core.NotImplemented("Lab perception tools")
}

func (m *Module) aiStatus() []AIModelInfo {
	reason := "Coming in this phase"
	return []AIModelInfo{
		{Tool: string(OpFill), Needs: []string{}, Reason: reason},
		{Tool: string(OpCutout), Needs: []string{}, Reason: reason},
		{Tool: string(OpSegment), Needs: []string{}, Reason: reason},
		{Tool: string(OpEnhance), Needs: []string{}, Reason: reason},
	}
}

func (m *Module) warm(ctx context.Context) error { return nil }

func (a *AIModule) validate(inputs []string, options json.RawMessage) error {
	return core.NotImplemented("Lab perception tools")
}

func (a *AIModule) run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("Lab perception tools")
}

// ---- B1 ----

func (m *Module) brushSets() ([]BrushSet, error) { return []BrushSet{}, nil }

func (m *Module) brush(set, id string) (string, error) {
	return "", core.NotImplemented("Brushes")
}

func (m *Module) saveBrush(set, brushJSON string) (BrushInfo, error) {
	return BrushInfo{}, core.NotImplemented("Save brush")
}

func (m *Module) saveBrushAsset(set, kind, pngDataURL string) (string, error) {
	return "", core.NotImplemented("Save brush")
}

func (m *Module) deleteBrush(set, id string) error { return core.NotImplemented("Delete brush") }

func (m *Module) brushAsset(set, file string) (string, error) {
	return "", core.NotImplemented("Brushes")
}

func (m *Module) pickBrushFiles() ([]string, error) {
	return []string{}, core.NotImplemented("Import brushes")
}

func (m *Module) importBrushes(ctx context.Context, paths []string) ([]BrushImportResult, error) {
	return []BrushImportResult{}, core.NotImplemented("Import brushes")
}

func (m *Module) exportBrushSet(set string) (string, error) {
	return "", core.NotImplemented("Export brushes")
}

func (m *Module) prepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Paint+ pipeline step")
}
