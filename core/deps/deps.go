// Package deps detects external tools (yt-dlp, ffmpeg, …) and manages the
// app-installed yt-dlp. See SPEC.md §6.3.
//
// CONTRACT STUB (foundation). WP-C replaces the bodies and adds detect.go,
// catalog details and ytdlp_update.go; exported signatures are frozen.
package deps

import (
	"context"
	"regexp"

	"toolbox/core"
)

// Dependency IDs.
const (
	YtDlp    = "yt-dlp"
	FFmpeg   = "ffmpeg"
	FFprobe  = "ffprobe"
	Deno     = "deno"
	Node     = "node"
	ExifTool = "exiftool"
)

// UpdateModuleID is the hidden system module that installs/updates yt-dlp.
const UpdateModuleID = "system-ytdlp-update"

// Spec describes one external tool.
type Spec struct {
	ID, Name, Purpose string
	Binary            string   // base name without .exe
	VersionArgs       []string // e.g. ["--version"]
	VersionRegex      *regexp.Regexp
	Managed           bool              // app can install/update it
	InstallHint       map[string]string // GOOS → hint
}

// Catalog returns the Phase 1 dependency catalog.
func Catalog() []Spec { return nil }

// Service detects and resolves dependencies. Safe for concurrent use.
type Service struct {
	binDir string
	specs  []Spec
	reg    *core.Registry
	em     core.Emitter
}

// New builds a service. binDir is the managed bin dir (<support>/bin).
func New(binDir string, specs []Spec, reg *core.Registry, em core.Emitter) *Service {
	return &Service{binDir: binDir, specs: specs, reg: reg, em: em}
}

// Resolve returns the absolute path of a dependency or an *AppError with
// CodeDependencyMissing (with the OS install hint). Uses cached detection and
// re-detects a missing dep once on demand.
func (s *Service) Resolve(depID string) (string, error) {
	return "", core.ErrDependencyMissing(depID, "")
}

// List returns the cached statuses in catalog order.
func (s *Service) List() []core.DepStatus { return []core.DepStatus{} }

// Detect re-checks every dependency in parallel (5 s timeout each) and emits
// deps:changed.
func (s *Service) Detect(ctx context.Context) []core.DepStatus { return []core.DepStatus{} }

// BinDir is the managed bin dir.
func (s *Service) BinDir() string { return s.binDir }

// RegisterUpdater registers the hidden yt-dlp install/update module.
func RegisterUpdater(reg *core.Registry, s *Service) error { return nil }
