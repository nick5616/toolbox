package paint

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// CONTRACT STUBS (Wave 0) owned by P3 (projects.go, export.go, run.go, pipeline step): implement each function in your
// own files and delete it here; delete this file when it is empty.

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

func (m *Module) prepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Paint+ pipeline step")
}
