package deps

import (
	"errors"
	"path/filepath"
	"runtime"

	"toolbox/core"
)

const (
	pandocBase     = "https://github.com/jgm/pandoc/releases/download/" + PandocVersion + "/"
	pandocWinAsset = "pandoc-" + PandocVersion + "-windows-x86_64.zip"
	pandocMacAsset = "pandoc-" + PandocVersion + "-arm64-macOS.zip"
)

var pandocSHA256 = map[string]string{
	pandocWinAsset: "23e1f2e978a3df80db8bf65c9c59534f41a23140480cfb4f783a882ab7dc6a4e",
	pandocMacAsset: "f436d18bebbfb3ddd326597686dacab9fac5dc23bd060495020f35a28a43a7c3",
}

// pandocSizes are the exact asset sizes (GitHub release API).
var pandocSizes = map[string]int64{
	pandocWinAsset: 42_983_200,
	pandocMacAsset: 43_148_194,
}

// pandocAsset names the Pandoc zip: windows/amd64 (arm64 runs it under
// emulation) and darwin/arm64.
func pandocAsset(goos, goarch, _ string) (string, error) {
	switch {
	case goos == "windows" && (goarch == "amd64" || goarch == "arm64"):
		return pandocWinAsset, nil
	case goos == "darwin" && goarch == "arm64":
		return pandocMacAsset, nil
	}
	return "", errUnsupportedPlatform
}

// PandocArchive is the pinned Pandoc archive spec.
func PandocArchive() ArchiveSpec {
	asset, _ := pandocAsset(runtime.GOOS, runtime.GOARCH, "")
	return ArchiveSpec{
		DepID:      Pandoc,
		InstallDir: "pandoc",
		Version:    PandocVersion,
		Parts: []ArchivePart{{
			Name:   "main",
			Asset:  pandocAsset,
			URL:    func(asset string) string { return pandocBase + asset },
			SHA256: func(asset string) string { return pandocSHA256[asset] },
			Size:   pandocSizes[asset],
		}},
		Layout: func(roots map[string]string, dir string) error {
			return pandocLayout(runtime.GOOS, roots["main"], dir)
		},
		MaxBytes:   400 << 20, // the unpacked binary alone is ≈240 MB
		ModuleID:   PandocInstallModuleID,
		ModuleName: "Pandoc installer",
		Tagline:    "Install or update Pandoc",
	}
}

// pandocLayout keeps only the pandoc executable. The zip root is
// pandoc-<v>/pandoc.exe (Windows) or pandoc-<v>-arm64/bin/pandoc (macOS);
// pandoc-server and pandoc-lua (symlinks to pandoc) are never installed.
func pandocLayout(goos, root, dir string) error {
	name := "pandoc"
	src := filepath.Join(root, "bin", name)
	if goos == "windows" {
		name += ".exe"
		src = filepath.Join(root, name)
	}
	if !isFile(src) {
		return core.Errorf(core.CodeToolFailed, "The download didn't contain %s", name).WithCause(errors.New(name + " missing"))
	}
	if err := moveFile(src, filepath.Join(dir, name), 0o755); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't set up Pandoc").WithCause(err)
	}
	return nil
}

// RegisterPandocInstaller registers the hidden Pandoc install module.
func RegisterPandocInstaller(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: PandocArchive()})
}
