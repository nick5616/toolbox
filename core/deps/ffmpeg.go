package deps

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"

	"toolbox/core"
)

// Pinned FFmpeg assets (SPEC.md §0.4, §7.6).
const (
	ffmpegWinAsset = "ffmpeg-" + FFmpegVersion + "-essentials_build.zip"
	ffmpegWinURL   = "https://github.com/GyanD/codexffmpeg/releases/download/" + FFmpegVersion + "/" + ffmpegWinAsset
	ffmpegMacBase  = "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_" + FFmpegVersion + "/"
)

var ffmpegSHA256 = map[string]string{
	ffmpegWinAsset: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
	"ffmpeg.zip":   "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
	"ffprobe.zip":  "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
}

// FFmpegArchive is the FFmpeg (+ffprobe) archive spec for the running
// platform: one Gyan zip on Windows, two Martin Riedl zips on darwin/arm64.
// Elsewhere the single part reports an unsupported platform.
func FFmpegArchive() ArchiveSpec {
	pinned := func(asset string) string { return ffmpegSHA256[asset] }
	var parts []ArchivePart
	switch {
	case runtime.GOOS == "windows" && (runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64"):
		parts = []ArchivePart{{
			Name:   "main",
			Asset:  func(_, _, _ string) (string, error) { return ffmpegWinAsset, nil },
			URL:    func(string) string { return ffmpegWinURL },
			SHA256: pinned,
			Size:   114_768_076,
		}}
	case runtime.GOOS == "darwin" && runtime.GOARCH == "arm64":
		for _, n := range []string{"ffmpeg", "ffprobe"} {
			asset := n + ".zip"
			size := int64(28_395_699)
			if n == "ffprobe" {
				size = 28_317_701
			}
			parts = append(parts, ArchivePart{
				Name:   n,
				Asset:  func(_, _, _ string) (string, error) { return asset, nil },
				URL:    func(a string) string { return ffmpegMacBase + a },
				SHA256: pinned,
				Size:   size,
			})
		}
	default:
		parts = []ArchivePart{{
			Name:  "main",
			Asset: func(_, _, _ string) (string, error) { return "", errUnsupportedPlatform },
			URL:   func(string) string { return "" },
		}}
	}
	return ArchiveSpec{
		DepID:      FFmpeg,
		InstallDir: "ffmpeg",
		Version:    FFmpegVersion,
		Parts:      parts,
		Layout: func(roots map[string]string, dir string) error {
			return ffmpegLayout(runtime.GOOS, roots, dir)
		},
		MaxBytes:   maxDownload,
		ModuleID:   FFmpegInstallModuleID,
		ModuleName: "FFmpeg installer",
		Tagline:    "Install or update FFmpeg",
	}
}

// ffmpegLayout builds the flat install folder: ffmpeg, ffprobe and, on
// Windows, LICENSE (only these are kept from the Gyan zip).
func ffmpegLayout(goos string, roots map[string]string, dir string) error {
	bad := func(msg string, err error) error {
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
	}
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	type move struct{ src, dst string }
	var moves []move
	if goos == "windows" {
		root := roots["main"]
		for _, n := range []string{"ffmpeg", "ffprobe"} {
			moves = append(moves, move{filepath.Join(root, "bin", n+ext), n + ext})
		}
		moves = append(moves, move{filepath.Join(root, "LICENSE"), "LICENSE"})
	} else {
		for _, n := range []string{"ffmpeg", "ffprobe"} {
			moves = append(moves, move{filepath.Join(roots[n], n), n})
		}
	}
	for _, m := range moves {
		if !isFile(m.src) {
			return bad("The download didn't contain "+m.dst, errors.New(m.dst+" missing"))
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return bad("Couldn't set up FFmpeg", err)
	}
	for _, m := range moves {
		mode := os.FileMode(0o755)
		if m.dst == "LICENSE" {
			mode = 0o644
		}
		if err := moveFile(m.src, filepath.Join(dir, m.dst), mode); err != nil {
			return bad("Couldn't set up FFmpeg", err)
		}
	}
	return nil
}

// RegisterFFmpegInstaller registers the hidden FFmpeg install module.
func RegisterFFmpegInstaller(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: FFmpegArchive()})
}
