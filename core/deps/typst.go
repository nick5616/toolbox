package deps

import (
	"errors"
	"path/filepath"
	"runtime"

	"toolbox/core"
)

// TypstMinVersion is the oldest Typst Pandoc's PDF templates work with.
const TypstMinVersion = "0.12"

const (
	typstBase     = "https://github.com/typst/typst/releases/download/v" + TypstVersion + "/"
	typstWinAsset = "typst-x86_64-pc-windows-msvc.zip"
	typstMacAsset = "typst-aarch64-apple-darwin.tar.xz"
)

var typstSHA256 = map[string]string{
	typstWinAsset: "19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736",
	typstMacAsset: "48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a",
}

// typstSizes are the exact asset sizes (GitHub release API).
var typstSizes = map[string]int64{
	typstWinAsset: 22_463_684,
	typstMacAsset: 14_438_168,
}

// typstAsset names the Typst archive: windows/amd64 (arm64 runs it under
// emulation) and darwin/arm64.
func typstAsset(goos, goarch, _ string) (string, error) {
	switch {
	case goos == "windows" && (goarch == "amd64" || goarch == "arm64"):
		return typstWinAsset, nil
	case goos == "darwin" && goarch == "arm64":
		return typstMacAsset, nil
	}
	return "", errUnsupportedPlatform
}

// TypstArchive is the pinned Typst archive spec.
func TypstArchive() ArchiveSpec {
	asset, _ := typstAsset(runtime.GOOS, runtime.GOARCH, "")
	return ArchiveSpec{
		DepID:      Typst,
		InstallDir: "typst",
		Version:    TypstVersion,
		Parts: []ArchivePart{{
			Name:   "main",
			Asset:  typstAsset,
			URL:    func(asset string) string { return typstBase + asset },
			SHA256: func(asset string) string { return typstSHA256[asset] },
			Size:   typstSizes[asset],
		}},
		Layout: func(roots map[string]string, dir string) error {
			return typstLayout(runtime.GOOS, roots["main"], dir)
		},
		MaxBytes:   maxDownload,
		ModuleID:   TypstInstallModuleID,
		ModuleName: "Typst installer",
		Tagline:    "Install or update Typst",
	}
}

// typstLayout keeps only the typst executable (root is typst-<target>/).
func typstLayout(goos, root, dir string) error {
	name := "typst"
	if goos == "windows" {
		name += ".exe"
	}
	if !isFile(filepath.Join(root, name)) {
		return core.Errorf(core.CodeToolFailed, "The download didn't contain %s", name).WithCause(errors.New(name + " missing"))
	}
	if err := moveFile(filepath.Join(root, name), filepath.Join(dir, name), 0o755); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't set up Typst").WithCause(err)
	}
	return nil
}

// RegisterTypstInstaller registers the hidden Typst install module.
func RegisterTypstInstaller(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: TypstArchive()})
}
