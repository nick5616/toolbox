package paint

import (
	"context"

	"toolbox/core"
)

// Service is Paint+'s Wails service (SPEC.md §2.2). Every method returns
// *core.AppError for user-facing failures.
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

func bg() context.Context { return context.Background() }

// ---- projects (P3: projects.go) ----

// Projects lists Paint+ projects, newest first.
func (s *Service) Projects() ([]core.ProjectInfo, error) { return s.m.docs.List(bg()) }

// Create makes a blank canvas and returns its project ID.
func (s *Service) Create(name string, width, height int, background string) (string, error) {
	return s.m.create(bg(), name, width, height, background)
}

// CreateFromImage makes a project whose first layer is the image at path
// (EXIF-oriented, HEIC through the engine; scaled down to fit the limits
// only when the user chose that: fit=true). The file is never modified.
func (s *Service) CreateFromImage(path, name string, fit bool) (string, error) {
	return s.m.createFromImage(bg(), path, name, fit)
}

// Load returns a project's document.
func (s *Service) Load(id string) (PaintDoc, error) { return s.m.load(bg(), id) }

// Tiles returns PNG data URLs for a layer's tile keys (≤ MaxTilesPerGet);
// missing tiles are absent from the map.
func (s *Service) Tiles(id, layerID string, keys []string) (map[string]string, error) {
	return s.m.tiles(id, layerID, keys)
}

// SaveTiles writes dirty tiles (PNG data URLs, ≤ MaxTileBytes each)
// atomically and removes the keys in removed.
func (s *Service) SaveTiles(id, layerID string, tiles map[string]string, removed []string) error {
	return s.m.saveTiles(id, layerID, tiles, removed)
}

// SaveDoc validates and saves the document (after its tiles), and deletes
// the tile folders of layers no longer in it.
func (s *Service) SaveDoc(id, name string, doc PaintDoc) error {
	return s.m.saveDoc(bg(), id, name, doc)
}

// SaveThumb stores thumb.jpg (≤ 512 px) and render.png (≤ 4096 px long
// side, ≤ MaxRenderBytes) for the gallery, the Library and the step.
func (s *Service) SaveThumb(id, jpegDataURL, renderPNGDataURL string) error {
	return s.m.saveThumb(id, jpegDataURL, renderPNGDataURL)
}

// Rename renames a project.
func (s *Service) Rename(id, name string) error { return s.m.rename(bg(), id, name) }

// Duplicate copies a project (document and tiles) and returns the new ID.
func (s *Service) Duplicate(id string) (string, error) { return s.m.duplicate(bg(), id) }

// Delete removes a project and its files.
func (s *Service) Delete(id string) error { return s.m.docs.Delete(bg(), id) }

// ImportLayer turns an image file into a new layer's tiles (scaled to fit
// the canvas when larger) and returns the layer; the caller adds it to the
// document and saves.
func (s *Service) ImportLayer(id, path string) (PaintLayer, error) {
	return s.m.importLayer(bg(), id, path)
}

// ImportORA makes a project from an OpenRaster file.
func (s *Service) ImportORA(path string) (string, error) { return s.m.importORA(bg(), path) }

// ---- export (P3: export.go) ----

// DefaultExport is the export dialog's starting point.
func (s *Service) DefaultExport() ExportOptions { return DefaultExportOptions() }

// Export submits an export job: <library>/Paintings/<name>.<ext>, never
// overwriting, registered with lineage [Source] when set.
func (s *Service) Export(opts ExportOptions) (core.Job, error) { return s.m.submitExport(s.jobs, opts) }

// ExportAs asks where to save and writes the export there directly (not
// registered). Cancelling returns "".
func (s *Service) ExportAs(opts ExportOptions) (string, error) { return s.m.exportAs(bg(), opts) }

// ---- the Lab: perception tools (P4: ai.go) ----

// AI submits one perception tool call as a quiet paint-ai job.
func (s *Service) AI(projectID string, req AIRequest) (core.Job, error) {
	return s.m.submitAI(s.jobs, projectID, req)
}

// AIResult returns a finished paint-ai job's result PNG as a data URL:
// index 0 is the final result, 1..Passes the intermediate fill passes. The
// files are deleted when the job is removed or at start.
func (s *Service) AIResult(jobID string, index int) (string, error) {
	return s.m.aiResult(jobID, index)
}

// AIStatus says which perception tools can run here.
func (s *Service) AIStatus() []AIModelInfo { return s.m.aiStatus() }

// Warm starts the engine and loads the fast inpaint model if installed (no
// download). Errors are reported, never fatal.
func (s *Service) Warm() error { return s.m.warm(bg()) }

// Origins are the Lab's model origin cards (SPEC.md §1.4.3).
func (s *Service) Origins() []Origin { return Origins() }

// ---- brushes (B1: brushes.go, brushimport/) ----

// BrushSets lists the user's brush sets (imported or made here).
func (s *Service) BrushSets() ([]BrushSet, error) { return s.m.brushSets() }

// Brush returns one brush's JSON (frontend schema).
func (s *Service) Brush(set, id string) (string, error) { return s.m.brush(set, id) }

// SaveBrush stores a brush's JSON in a user set (creating the set if
// needed) and returns its info.
func (s *Service) SaveBrush(set, brushJSON string) (BrushInfo, error) {
	return s.m.saveBrush(set, brushJSON)
}

// SaveBrushAsset stores a tip or grain PNG (data URL) for a user brush and
// returns its file name.
func (s *Service) SaveBrushAsset(set, kind, pngDataURL string) (string, error) {
	return s.m.saveBrushAsset(set, kind, pngDataURL)
}

// DeleteBrush removes a brush ("" id = the whole set).
func (s *Service) DeleteBrush(set, id string) error { return s.m.deleteBrush(set, id) }

// BrushAsset returns a tip or grain PNG as a data URL.
func (s *Service) BrushAsset(set, file string) (string, error) { return s.m.brushAsset(set, file) }

// PickBrushFiles shows a file dialog for brush files to import.
func (s *Service) PickBrushFiles() ([]string, error) { return s.m.pickBrushFiles() }

// ImportBrushes imports Procreate .brushset/.brush, MyPaint .myb, Photoshop
// .abr (sampled tips) and Krita .bundle files.
func (s *Service) ImportBrushes(paths []string) ([]BrushImportResult, error) {
	return s.m.importBrushes(bg(), paths)
}

// ExportBrushSet asks where to save a set as a .paintplus-brushes zip.
// Cancelling returns "".
func (s *Service) ExportBrushSet(set string) (string, error) { return s.m.exportBrushSet(set) }

// ---- shapes for the bindings ----

// StepShape keeps the step options type in the bindings.
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }

// AIResultShape keeps the AI result type in the bindings.
func (s *Service) AIResultShape() AIResultInfo { return AIResultInfo{} }
