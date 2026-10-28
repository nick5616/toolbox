package deps

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Managed archive tools (Phase 3 SPEC.md §3.5).
//
// FOUNDATION STUB: WP-EX1 implements InstallManagedArchive, the ExifTool
// asset/layout functions, the updater module and the resolution-order change.
// Exported names and signatures here are frozen.

// ExifToolUpdateModuleID is the hidden ExifTool install/update module.
const ExifToolUpdateModuleID = "system-exiftool-update"

// ArchiveSpec describes an app-managed tool installed from a versioned
// archive (a folder, not a single binary).
type ArchiveSpec struct {
	DepID        string
	VersionURL   string // returns the latest version as plain text
	ChecksumsURL string // lines "SHA2-256(<asset>)= <hex>"
	Asset        func(goos, goarch, version string) (string, error)
	DownloadURL  func(asset string) string // may redirect (e.g. SourceForge /download)
	InstallDir   string                    // relative to BinDir, e.g. "exiftool"
	// Layout moves/renames the extracted files into installDir (which does
	// not exist yet) so that the tool's executable ends up where detection
	// looks for it.
	Layout   func(extractedRoot, installDir string) error
	MaxBytes int64
}

// ExifToolArchive is the ExifTool archive spec.
func ExifToolArchive() ArchiveSpec {
	return ArchiveSpec{
		DepID:        ExifTool,
		VersionURL:   "https://exiftool.org/ver.txt",
		ChecksumsURL: "https://exiftool.org/checksums.txt",
		Asset: func(goos, goarch, version string) (string, error) {
			return "", errUnsupportedPlatform
		},
		DownloadURL: func(asset string) string {
			return "https://sourceforge.net/projects/exiftool/files/" + asset + "/download"
		},
		InstallDir: "exiftool",
		Layout:     func(string, string) error { return errArchiveTODO },
		MaxBytes:   maxDownload,
	}
}

var errArchiveTODO = core.Errorf(core.CodeInternal, "Managed ExifTool install isn't implemented yet")

// InstallManagedArchive downloads the latest version of a with checksum
// verification, lays it out in <bin>/<InstallDir> (atomic swap; the old
// install survives a failure), verifies it and re-detects. A no-op when the
// installed version is current.
func (s *Service) InstallManagedArchive(ctx context.Context, job *core.JobContext, a ArchiveSpec) error {
	return errArchiveTODO
}

// RegisterExifToolUpdater registers the hidden ExifTool install/update module.
func RegisterExifToolUpdater(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: ExifToolArchive()})
}

type archiveUpdater struct {
	svc  *Service
	spec ArchiveSpec
}

func (u *archiveUpdater) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ExifToolUpdateModuleID, Name: "ExifTool updater", Tagline: "Install or update ExifTool",
		Icon: "refresh-cw", Category: core.CategoryUtility, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 1,
	}
}

func (u *archiveUpdater) Validate(inputs []string, _ json.RawMessage) error {
	if len(inputs) > 0 {
		return core.ValidationError("This task takes no inputs", nil)
	}
	return nil
}

func (u *archiveUpdater) Run(ctx context.Context, job *core.JobContext) error {
	return u.svc.InstallManagedArchive(ctx, job, u.spec)
}
