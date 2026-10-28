package deps

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"toolbox/core"
)

// UpscaylVersion is the pinned upscaler install: upscayl-ncnn release tag +
// Real-ESRGAN ncnn model release (SPEC §3.3).
const UpscaylVersion = "20251207-174704+models-0.2.5.0"

// UpscalerInstallModuleID is the hidden module that installs the upscaler.
const UpscalerInstallModuleID = "system-upscaler-install"

const (
	upscaylTag     = "20251207-174704"
	upscaylModels  = "v0.2.5.0"
	upscaylBase    = "https://github.com/upscayl/upscayl-ncnn/releases/download/" + upscaylTag + "/"
	esrganBase     = "https://github.com/xinntao/Real-ESRGAN/releases/download/" + upscaylModels + "/"
	upscaylModelsZ = "realesrgan-ncnn-vulkan-20220424-windows.zip"
)

// Pinned sha256 values of the release assets (SPEC §0).
var upscaylSHA256 = map[string]string{
	"upscayl-bin-" + upscaylTag + "-windows.zip": "1f0f65c5d2ade866555e2ac467d35952c35a47080a4060fe56a1ab028f67258a",
	"upscayl-bin-" + upscaylTag + "-macos.zip":   "277419791281a56eae0c739c70120b974d7267cf7c2de8e86dc09798d4b314db",
	upscaylModelsZ: "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d",
}

// UpscaylModelNames are the only models kept from the Real-ESRGAN archive.
var UpscaylModelNames = []string{
	"realesrgan-x4plus", "realesrgan-x4plus-anime",
	"realesr-animevideov3-x2", "realesr-animevideov3-x3", "realesr-animevideov3-x4",
}

// upscaylAsset names the upscayl-bin archive: windows/amd64, windows/arm64
// (x64 emulation) and darwin (universal binary).
func upscaylAsset(goos, goarch, _ string) (string, error) {
	switch goos {
	case "windows":
		if goarch == "amd64" || goarch == "arm64" {
			return "upscayl-bin-" + upscaylTag + "-windows.zip", nil
		}
	case "darwin":
		return "upscayl-bin-" + upscaylTag + "-macos.zip", nil
	}
	return "", errUnsupportedPlatform
}

// UpscaylArchive is the upscaler's archive spec: upscayl-bin plus the
// Real-ESRGAN models, both with pinned checksums.
func UpscaylArchive() ArchiveSpec {
	pinned := func(asset string) string { return upscaylSHA256[asset] }
	return ArchiveSpec{
		DepID:      Upscayl,
		InstallDir: "upscaler",
		Version:    UpscaylVersion,
		Parts: []ArchivePart{
			{
				Name:   "main",
				Asset:  upscaylAsset,
				URL:    func(asset string) string { return upscaylBase + asset },
				SHA256: pinned,
				Size:   6 << 20,
			},
			{
				Name:   "models",
				Asset:  func(_, _, _ string) (string, error) { return upscaylModelsZ, nil },
				URL:    func(asset string) string { return esrganBase + asset },
				SHA256: pinned,
				Size:   46 << 20,
			},
		},
		Layout: func(roots map[string]string, dir string) error {
			return upscaylLayout(runtime.GOOS, roots, dir)
		},
		MaxBytes:   maxDownload,
		ModuleID:   UpscalerInstallModuleID,
		ModuleName: "Upscaler installer",
		Tagline:    "Install or update the upscaler",
	}
}

// moveFile renames src to dst, falling back to a copy across volumes.
func moveFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return os.Chmod(dst, mode)
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// upscaylLayout builds the install folder: the binary (0755 on unix),
// LICENSE-upscayl, exactly the five models (.param + .bin) and, on Windows
// only, vcomp140.dll from the models archive.
func upscaylLayout(goos string, roots map[string]string, dir string) error {
	bad := func(msg string, err error) error {
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
	}
	exeName := "upscayl-bin"
	if goos == "windows" {
		exeName += ".exe"
	}
	main, models := roots["main"], roots["models"]
	if !isFile(filepath.Join(main, exeName)) {
		return bad("The download didn't contain "+exeName, errors.New(exeName+" missing"))
	}
	if err := moveFile(filepath.Join(main, exeName), filepath.Join(dir, exeName), 0o755); err != nil {
		return bad("Couldn't set up the upscaler", err)
	}
	if lic := filepath.Join(main, "LICENSE"); isFile(lic) {
		if err := moveFile(lic, filepath.Join(dir, "LICENSE-upscayl"), 0o644); err != nil {
			return bad("Couldn't set up the upscaler", err)
		}
	} else {
		return bad("The download didn't contain the upscaler license", errors.New("LICENSE missing"))
	}
	for _, name := range UpscaylModelNames {
		for _, ext := range []string{".param", ".bin"} {
			src := filepath.Join(models, "models", name+ext)
			if !isFile(src) {
				return bad("The download didn't contain the "+name+" model", errors.New(name+ext+" missing"))
			}
			if err := moveFile(src, filepath.Join(dir, "models", name+ext), 0o644); err != nil {
				return bad("Couldn't set up the upscaler models", err)
			}
		}
	}
	if goos == "windows" {
		src := filepath.Join(models, "vcomp140.dll")
		if !isFile(src) {
			return bad("The download didn't contain vcomp140.dll", errors.New("vcomp140.dll missing"))
		}
		if err := moveFile(src, filepath.Join(dir, "vcomp140.dll"), 0o644); err != nil {
			return bad("Couldn't set up the upscaler", err)
		}
	}
	return nil
}

// RegisterUpscalerInstaller registers the hidden upscaler install module.
func RegisterUpscalerInstaller(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: UpscaylArchive()})
}
