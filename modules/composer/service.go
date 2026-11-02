package composer

import (
	"context"

	"toolbox/core"
)

// Service is the Photo Composer's typed Wails service (SPEC.md §B5.4).
type Service struct{ m *Module }

// NewService builds the service.
func NewService(m *Module) *Service { return &Service{m: m} }

// List returns the compositions, most recently updated first.
func (s *Service) List() ([]core.ProjectInfo, error) { return s.m.docs.List(context.Background()) }

// Get returns a composition document.
func (s *Service) Get(id string) (Composition, error) { return s.m.Get(context.Background(), id) }

// Create makes a new composition at aspect, optionally with a background
// photo.
func (s *Service) Create(name, aspect, backgroundPath string) (core.ProjectInfo, error) {
	return s.m.Create(context.Background(), name, aspect, backgroundPath)
}

// Save validates and stores a composition.
func (s *Service) Save(id, name string, doc Composition) (core.ProjectInfo, error) {
	return s.m.Save(context.Background(), id, name, doc)
}

// SaveRender stores the latest render (format "jpg" | "png", base64) and a
// thumbnail.
func (s *Service) SaveRender(id, format, base64Data string) error {
	return s.m.SaveRender(context.Background(), id, format, base64Data)
}

// Export copies the latest render into <library>/Compositions.
func (s *Service) Export(id string) (core.Output, error) {
	return s.m.Export(context.Background(), id)
}

// Duplicate copies a composition.
func (s *Service) Duplicate(id string) (core.ProjectInfo, error) {
	return s.m.docs.Duplicate(context.Background(), id)
}

// Delete removes a composition and its renders.
func (s *Service) Delete(id string) error { return s.m.docs.Delete(context.Background(), id) }

// LoadImage returns an image as a data URL scaled to maxDim (≤ 4096), with
// EXIF orientation applied; HEIC is converted by the AI engine.
func (s *Service) LoadImage(path string, maxDim int) (string, error) {
	return s.m.LoadImage(context.Background(), path, maxDim)
}

// RemoveBackground submits a Background Remover job for path (balanced,
// transparent, cropped to the subject).
func (s *Service) RemoveBackground(path string) (core.Job, error) {
	return s.m.RemoveBackground(context.Background(), path)
}

// Aspects lists the canvas shapes with their 1× sizes.
func (s *Service) Aspects() []AspectInfo { return Aspects() }

// AspectInfo is a canvas shape.
type AspectInfo struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// Aspects lists the canvas shapes (1080 wide; 16:9 is 1920×1080).
func Aspects() []AspectInfo {
	return []AspectInfo{
		{ID: "4:5", Label: "Portrait 4:5", Width: 1080, Height: 1350},
		{ID: "1:1", Label: "Square 1:1", Width: 1080, Height: 1080},
		{ID: "3:4", Label: "Tall 3:4", Width: 1080, Height: 1440},
		{ID: "1.91:1", Label: "Landscape 1.91:1", Width: 1080, Height: 566},
		{ID: "9:16", Label: "Story 9:16", Width: 1080, Height: 1920},
		{ID: "16:9", Label: "Wide 16:9", Width: 1920, Height: 1080},
	}
}
