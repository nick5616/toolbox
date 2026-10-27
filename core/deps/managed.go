package deps

import (
	"context"
	"errors"
	"fmt"

	"toolbox/core"
)

// Phase 2 contract (SPEC.md §3.3).

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

var errUnsupportedPlatform = errors.New("unsupported platform")

// YtDlpBinary and UVBinary are the two managed binaries.
func YtDlpBinary() BinarySpec {
	return BinarySpec{
		DepID: YtDlp, Repo: "yt-dlp/yt-dlp",
		Asset: func(goos, goarch string) (string, error) {
			if n := assetName(goos, goarch); n != "" {
				return n, nil
			}
			return "", errUnsupportedPlatform
		},
		Checksum: ChecksumSumsFile, SumsFile: sumsAsset,
		MaxBytes: maxDownload,
	}
}

func UVBinary() BinarySpec {
	return BinarySpec{
		DepID: UV, Repo: "astral-sh/uv",
		Asset:        uvAsset,
		Checksum:     ChecksumPerAsset,
		ArchiveEntry: "uv",
		MaxBytes:     maxDownload,
	}
}

func uvAsset(goos, goarch string) (string, error) {
	arch := ""
	switch goarch {
	case "arm64":
		arch = "aarch64"
	case "amd64":
		arch = "x86_64"
	default:
		return "", errUnsupportedPlatform
	}
	switch goos {
	case "darwin":
		return "uv-" + arch + "-apple-darwin.tar.gz", nil
	case "windows":
		return "uv-" + arch + "-pc-windows-msvc.zip", nil
	case "linux":
		return "uv-" + arch + "-unknown-linux-gnu.tar.gz", nil
	}
	return "", errUnsupportedPlatform
}

// InstallManagedBinary downloads the latest release of b into the managed bin
// dir with checksum verification, reporting progress through job, then
// re-detects. A no-op (message "Already up to date (<tag>)") when current.
func (s *Service) InstallManagedBinary(ctx context.Context, job *core.JobContext, b BinarySpec) error {
	base := s.githubBase
	if base == "" {
		base = githubAPI
	}
	return newUpdater(s, base).install(ctx, job, b)
}

// RegisterUVUpdater registers the hidden uv install/update module.
func RegisterUVUpdater(reg *core.Registry, s *Service) error {
	u := newUpdater(s, githubAPI)
	u.spec = UVBinary()
	return reg.Register(u)
}

func (b BinarySpec) String() string { return fmt.Sprintf("%s (%s)", b.DepID, b.Repo) }
