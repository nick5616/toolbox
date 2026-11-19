// Package mediaindex holds Smart search's job modules (Phase 20, SPEC.md
// Part A): the hidden quiet "media-index" (one batch: pictures + text) and
// "media-speech" (one file: speech) jobs, and the "Keep files that show…"
// pipeline step ("search-filter"). The index itself is core/mediaindex.
//
// CONTRACT STUB (Wave 0): Descriptors, Register and the option types are
// final. S3 implements the two jobs (prepare.go, ocr.go, speech.go), S1 the
// models (models.go), S6 the step (pipeline.go, filter.go).
package mediaindex

import (
	"context"
	"encoding/json"
	"image"

	"toolbox/core"
	"toolbox/core/deps"
	ix "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
)

// Renderer renders PDF pages and reads their text layer
// (core/pdfium.Renderer implements it).
type Renderer interface {
	PageCount(ctx context.Context, doc []byte, password string) (int, error)
	Render(ctx context.Context, doc []byte, password string, page, dpi int) (image.Image, error)
	PageText(ctx context.Context, doc []byte, password string, page int) (string, error)
}

// Deps are what the job modules share.
type Deps struct {
	Writer    ix.Writer
	Caller    sidecar.Caller
	PDF       Renderer
	ModelsDir string // the vision model goes in <ModelsDir>/search/<model id>/
}

// IndexModule is the "media-index" job module (and the search-default
// model's core.ModelProvider).
type IndexModule struct{ d Deps }

// SpeechModule is the "media-speech" job module.
type SpeechModule struct{ d Deps }

// FilterModule is the "search-filter" step module.
type FilterModule struct{ d Deps }

// Register adds the three modules and returns the index module (the model
// provider packs need).
func Register(reg *core.Registry, d Deps) (*IndexModule, error) {
	im := &IndexModule{d: d}
	for _, m := range []core.Module{im, &SpeechModule{d: d}, &FilterModule{d: d}} {
		if err := reg.Register(m); err != nil {
			return nil, err
		}
	}
	return im, nil
}

// PictureExts are the image and video extensions the index reads.
func PictureExts() []string {
	return []string{
		".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif",
		".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi",
		".pdf",
	}
}

// SpeechExts are the video and audio extensions speech is read from.
func SpeechExts() []string {
	return []string{
		".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi",
		".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac",
	}
}

// Descriptor implements core.Module.
func (m *IndexModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ix.IndexModuleID, Name: "Smart search indexing", Icon: "scan-eye", Category: core.CategoryUtility,
		Tagline: "Reads what's in library files for Smart search",
		Status:  core.StatusReady, Hidden: true, Quiet: true,
		Accepts:  core.Accepts{Extensions: PictureExts()},
		Requires: []string{sidecar.DepID}, Recommends: []string{deps.FFmpeg},
		MaxConcurrent: 1, MaxInputs: ix.BatchMaxFiles,
	}
}

// Validate implements core.Module.
func (m *IndexModule) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) == 0 {
		return core.ValidationError("Nothing to index", nil)
	}
	_, err := core.DecodeOptionsJSON[ix.BatchOptions](options)
	return err
}

// Run implements core.Module: one batch (SPEC.md §3.3).
func (m *IndexModule) Run(ctx context.Context, job *core.JobContext) error {
	return m.run(ctx, job)
}

// Descriptor implements core.Module.
func (m *SpeechModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ix.SpeechModuleID, Name: "Smart search listening", Icon: "scan-eye", Category: core.CategoryUtility,
		Tagline: "Transcribes speech in library files for Smart search",
		Status:  core.StatusReady, Hidden: true, Quiet: true,
		Accepts:       core.Accepts{Extensions: SpeechExts()},
		Requires:      []string{sidecar.DepID, deps.FFmpeg},
		MaxConcurrent: 1, MaxInputs: 1,
	}
}

// Validate implements core.Module.
func (m *SpeechModule) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) != 1 {
		return core.ValidationError("Speech is read one file at a time", nil)
	}
	_, err := core.DecodeOptionsJSON[ix.SpeechOptions](options)
	return err
}

// Run implements core.Module (SPEC.md §3.5).
func (m *SpeechModule) Run(ctx context.Context, job *core.JobContext) error {
	return m.run(ctx, job)
}
