package deps

import (
	"errors"
	"path/filepath"
	"runtime"

	"toolbox/core"
)

const denoBase = "https://github.com/denoland/deno/releases/download/v" + DenoVersion + "/"

var denoSHA256 = map[string]string{
	"deno-x86_64-pc-windows-msvc.zip": "cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf",
	"deno-aarch64-apple-darwin.zip":   "9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e",
}

// denoAsset names the Deno zip: windows/amd64 (arm64 runs it under
// emulation) and darwin/arm64.
func denoAsset(goos, goarch, _ string) (string, error) {
	switch {
	case goos == "windows" && (goarch == "amd64" || goarch == "arm64"):
		return "deno-x86_64-pc-windows-msvc.zip", nil
	case goos == "darwin" && goarch == "arm64":
		return "deno-aarch64-apple-darwin.zip", nil
	}
	return "", errUnsupportedPlatform
}

// DenoArchive is the pinned Deno archive spec.
func DenoArchive() ArchiveSpec {
	return ArchiveSpec{
		DepID:      Deno,
		InstallDir: "deno",
		Version:    DenoVersion,
		Parts: []ArchivePart{{
			Name:   "main",
			Asset:  denoAsset,
			URL:    func(asset string) string { return denoBase + asset },
			SHA256: func(asset string) string { return denoSHA256[asset] },
			Size:   42_917_472,
		}},
		Layout: func(roots map[string]string, dir string) error {
			return denoLayout(runtime.GOOS, roots["main"], dir)
		},
		MaxBytes:   maxDownload,
		ModuleID:   DenoInstallModuleID,
		ModuleName: "Deno installer",
		Tagline:    "Install or update Deno",
	}
}

func denoLayout(goos, root, dir string) error {
	name := "deno"
	if goos == "windows" {
		name += ".exe"
	}
	if !isFile(filepath.Join(root, name)) {
		return core.Errorf(core.CodeToolFailed, "The download didn't contain %s", name).WithCause(errors.New(name + " missing"))
	}
	if err := moveFile(filepath.Join(root, name), filepath.Join(dir, name), 0o755); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't set up Deno").WithCause(err)
	}
	return nil
}

// RegisterDenoInstaller registers the hidden Deno install module.
func RegisterDenoInstaller(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: DenoArchive()})
}
