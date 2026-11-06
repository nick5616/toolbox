package paint

import (
	"context"

	"toolbox/core"
)

// CONTRACT STUBS (Wave 0) owned by B1 (brushes.go, brushimport/): implement each function in your
// own files and delete it here; delete this file when it is empty.

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
