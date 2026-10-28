package deps

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"

	"toolbox/core"
)

// Managed llama.cpp runtime for Local Chat (SPEC §3.3, §0.1).

const llamaBase = "https://github.com/ggml-org/llama.cpp/releases/download/" + LlamaVersion + "/"

const (
	llamaWindowsAsset = "llama-" + LlamaVersion + "-bin-win-vulkan-x64.zip"
	llamaMacAsset     = "llama-" + LlamaVersion + "-bin-macos-arm64.tar.gz"
)

// Pinned sha256 values of the release assets (SPEC §0.1).
var llamaSHA256 = map[string]string{
	llamaWindowsAsset: "9ecd072c6e785fa2b932229c86f845695198195c4f29b99b85ed42dccb022aa6",
	llamaMacAsset:     "b1ed33aacd0927eaa69644e6b15e3206115f7f80dfc7501de86df89dab853e9f",
}

// llamaLicenseName is the licence file written beside the runtime.
const llamaLicenseName = "LICENSE-llama.cpp"

// llamaLicense is the llama.cpp MIT licence (the Windows zip lacks it).
const llamaLicense = `MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

// llamaAsset names the runtime archive: Windows amd64 (and arm64 under
// emulation) uses the Vulkan zip; darwin/arm64 the macOS tarball.
func llamaAsset(goos, goarch, _ string) (string, error) {
	switch goos {
	case "windows":
		if goarch == "amd64" || goarch == "arm64" {
			return llamaWindowsAsset, nil
		}
	case "darwin":
		if goarch == "arm64" {
			return llamaMacAsset, nil
		}
	}
	return "", errUnsupportedPlatform
}

// LlamaArchive is the llama.cpp runtime's archive spec.
func LlamaArchive() ArchiveSpec {
	return ArchiveSpec{
		DepID:      Llama,
		InstallDir: "llama",
		Version:    LlamaVersion,
		Parts: []ArchivePart{{
			Name:   "main",
			Asset:  llamaAsset,
			URL:    func(asset string) string { return llamaBase + asset },
			SHA256: func(asset string) string { return llamaSHA256[asset] },
			Size:   37 << 20,
		}},
		Layout: func(roots map[string]string, dir string) error {
			return llamaLayout(runtime.GOOS, roots["main"], dir)
		},
		MaxBytes:   maxDownload,
		ModuleID:   LlamaInstallModuleID,
		ModuleName: "Chat engine installer",
		Tagline:    "Install the chat engine",
	}
}

// llamaLayout installs the whole top folder of the archive as dir, writes the
// licence and makes llama-server executable on unix.
func llamaLayout(goos, extractedRoot, dir string) error {
	root := archiveRoot(extractedRoot)
	bad := func(msg string, err error) error {
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
	}
	exeName := "llama-server"
	if goos == "windows" {
		exeName += ".exe"
	}
	exe := filepath.Join(root, exeName)
	if !isFile(exe) {
		return bad("The download didn't contain "+exeName, errors.New(exeName+" missing"))
	}
	if goos != "windows" {
		if err := os.Chmod(exe, 0o755); err != nil {
			return bad("Couldn't make the chat engine executable", err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, llamaLicenseName), []byte(llamaLicense), 0o644); err != nil {
		return bad("Couldn't set up the chat engine", err)
	}
	if err := os.Rename(root, dir); err != nil {
		return bad("Couldn't set up the chat engine", err)
	}
	return nil
}

// RegisterLlamaInstaller registers the hidden chat-engine install module.
func RegisterLlamaInstaller(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: LlamaArchive()})
}
