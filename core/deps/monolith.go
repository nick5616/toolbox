package deps

import (
	"errors"
	"path/filepath"
	"runtime"

	"toolbox/core"
)

const (
	monolithBase     = "https://github.com/Y2Z/monolith/releases/download/v" + MonolithVersion + "/"
	monolithWinAsset = "monolith-cli.exe"
	monolithMacAsset = "monolith-cli-macos-aarch64-apple-darwin"
)

var monolithSHA256 = map[string]string{
	monolithWinAsset: "ed21a1062e3c07f4bed05e4bfccaa872aa2a36ac07aa0eb0de807ea956953eed",
	monolithMacAsset: "2dc89a796d9c6932e7c7c7a6d58011ec7d99b9c6f454619283664e2aeb0148a9",
}

// monolithSizes are the exact asset sizes (GitHub release API).
var monolithSizes = map[string]int64{
	monolithWinAsset: 5_539_328,
	monolithMacAsset: 6_227_984,
}

// monolithAsset names the raw binary: windows/amd64 (arm64 runs it under
// emulation) and darwin/arm64.
func monolithAsset(goos, goarch, _ string) (string, error) {
	switch {
	case goos == "windows" && (goarch == "amd64" || goarch == "arm64"):
		return monolithWinAsset, nil
	case goos == "darwin" && goarch == "arm64":
		return monolithMacAsset, nil
	}
	return "", errUnsupportedPlatform
}

// MonolithArchive is the pinned Monolith spec: one raw executable.
func MonolithArchive() ArchiveSpec {
	asset, _ := monolithAsset(runtime.GOOS, runtime.GOARCH, "")
	return ArchiveSpec{
		DepID:      Monolith,
		InstallDir: "monolith",
		Version:    MonolithVersion,
		Parts: []ArchivePart{{
			Name:   "main",
			Asset:  monolithAsset,
			URL:    func(asset string) string { return monolithBase + asset },
			SHA256: func(asset string) string { return monolithSHA256[asset] },
			Size:   monolithSizes[asset],
			Raw:    true,
		}},
		Layout: func(roots map[string]string, dir string) error {
			return monolithLayout(runtime.GOOS, runtime.GOARCH, roots["main"], dir)
		},
		MaxBytes:   maxDownload,
		ModuleID:   MonolithInstallModuleID,
		ModuleName: "Monolith installer",
		Tagline:    "Install or update Monolith",
	}
}

// monolithLayout renames the raw asset in root to monolith[.exe].
func monolithLayout(goos, goarch, root, dir string) error {
	asset, err := monolithAsset(goos, goarch, "")
	if err != nil {
		return core.Errorf(core.CodeToolFailed, "Monolith isn't available for this platform").WithCause(err)
	}
	name := "monolith"
	if goos == "windows" {
		name += ".exe"
	}
	if !isFile(filepath.Join(root, asset)) {
		return core.Errorf(core.CodeToolFailed, "The download didn't contain %s", asset).WithCause(errors.New(asset + " missing"))
	}
	if err := moveFile(filepath.Join(root, asset), filepath.Join(dir, name), 0o755); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't set up Monolith").WithCause(err)
	}
	return nil
}

// RegisterMonolithInstaller registers the hidden Monolith install module.
func RegisterMonolithInstaller(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: MonolithArchive()})
}
