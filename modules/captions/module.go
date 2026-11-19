// Package captions is Caption Writer (Phase 20, SPEC.md Part B): alt text,
// descriptions, social captions, hashtags, titles, keywords and file names
// for photos and videos, written by a local vision model through Local
// Chat's engine (core.VisionGenerator).
//
// CONTRACT STUB (Wave 0): options.go, module.go, service.go and the
// Chainable's StepDefaults/DescribeStep are final. C2 implements the rest.
package captions

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/trash"
)

// ModuleID is Caption Writer's module ID.
const ModuleID = "captions"

// OutputSubdir is where batches go: <library>/Captions/<batch name> <date>/.
const OutputSubdir = "Captions"

// Config wires the module (main.go).
type Config struct {
	Vision     core.VisionGenerator
	Hints      core.MediaHints    // Smart search (core.NopMediaIndex when absent)
	Sink       core.MediaTextSink // Smart search (core.NopMediaIndex when absent)
	Emitter    core.Emitter
	Resolve    func(depID string) (string, error) // ExifTool / FFmpeg presence for Status
	LibraryDir func() string
	// SearchInstalled reports whether Smart search can give hints.
	SearchInstalled func() bool
}

// Module implements core.Module.
type Module struct {
	cfg Config

	// seams for tests
	probeDuration func(ctx context.Context, ffprobe, path string) (int64, error)
	now           func() time.Time
	trasher       trash.Trasher

	batchMu sync.Mutex // serialises read-modify-write of captions.json
}

// New makes the module.
func New(cfg Config) *Module {
	if cfg.Hints == nil {
		cfg.Hints = core.NopMediaIndex{}
	}
	if cfg.Sink == nil {
		cfg.Sink = core.NopMediaIndex{}
	}
	if cfg.Emitter == nil {
		cfg.Emitter = core.NopEmitter{}
	}
	return &Module{cfg: cfg, probeDuration: defaultProbeDuration, now: time.Now, trasher: trash.Default()}
}

// Register adds the module to the registry.
func Register(reg *core.Registry, m *Module) error { return reg.Register(m) }

// ImageExts are the picture extensions Caption Writer reads.
func ImageExts() []string {
	return []string{".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"}
}

// VideoExts are the video extensions Caption Writer reads.
func VideoExts() []string { return []string{".mp4", ".mov", ".m4v", ".mkv", ".webm"} }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Caption Writer", Icon: "message-square-quote", Category: core.CategoryAI,
		Tagline:     "Alt text, captions, keywords and names for your photos and videos",
		Description: "A local vision model looks at your photos and videos and writes alt text, descriptions, social captions with hashtags, titles, keywords and file names. Edit them, save them, write them into copies or rename copies.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: append(ImageExts(), VideoExts()...)},
		Requires:    []string{deps.Llama},
		Recommends:  []string{deps.ExifTool, deps.FFmpeg},
		Order:       196, OutputSubdir: OutputSubdir,
		MaxConcurrent: 1, MaxInputs: MaxInputs,
	}
}

// IsInteractive implements core.InteractiveJobs: regenerating one item is.
func (m *Module) IsInteractive(options json.RawMessage) bool {
	o, err := core.DecodeOptionsJSON[Options](options)
	return err == nil && o.Action == ActionRegenerate && o.Index >= 0
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	return m.run(ctx, job)
}
