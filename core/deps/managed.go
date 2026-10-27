package deps

import (
	"context"

	"toolbox/core"
)

// Phase 2 contract (SPEC.md §3.3). CONTRACT STUB (foundation): WP-S1
// implements these and refactors the yt-dlp updater onto InstallManagedBinary.
// Exported names and signatures are frozen.

// UV is the uv dependency ID; UVUpdateModuleID its hidden install/update module.
const (
	UV               = "uv"
	UVUpdateModuleID = "system-uv-update"
)

// ChecksumKind says how a release publishes checksums.
type ChecksumKind string

const (
	// ChecksumSumsFile: one file (e.g. yt-dlp's SHA2-256SUMS) with "<hash>  <name>" lines.
	ChecksumSumsFile ChecksumKind = "sums-file"
	// ChecksumPerAsset: "<asset>.sha256" next to each asset (e.g. uv).
	ChecksumPerAsset ChecksumKind = "per-asset"
)

// BinarySpec describes an app-managed binary installed from GitHub releases.
type BinarySpec struct {
	DepID        string                                    // e.g. "yt-dlp", "uv"
	Repo         string                                    // "owner/name"
	Asset        func(goos, goarch string) (string, error) // release asset name
	Checksum     ChecksumKind
	SumsFile     string // for ChecksumSumsFile, e.g. "SHA2-256SUMS"
	ArchiveEntry string // binary name inside a .zip/.tar.gz asset ("" = asset is the binary)
	MaxBytes     int64
}

// YtDlpBinary and UVBinary are the two managed binaries.
func YtDlpBinary() BinarySpec { return BinarySpec{DepID: YtDlp, Repo: "yt-dlp/yt-dlp"} }
func UVBinary() BinarySpec    { return BinarySpec{DepID: UV, Repo: "astral-sh/uv"} }

// InstallManagedBinary downloads the latest release of b into the managed bin
// dir with checksum verification, reporting progress through job, then
// re-detects. A no-op (message "Already up to date (<tag>)") when current.
func (s *Service) InstallManagedBinary(ctx context.Context, job *core.JobContext, b BinarySpec) error {
	return core.NotImplemented("managed binary install")
}

// RegisterUVUpdater registers the hidden uv install/update module.
func RegisterUVUpdater(reg *core.Registry, s *Service) error { return nil }

// RegisterVirtual adds a dependency detected by a function instead of by
// running a binary (e.g. the audio engine). spec supplies ID, Name, Purpose,
// Managed and InstallHint; detect returns its status (Path is what Resolve
// returns when OK). It participates in List, Detect, Resolve and deps:changed.
func (s *Service) RegisterVirtual(spec Spec, detect func(ctx context.Context) core.DepStatus) {}
