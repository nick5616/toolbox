// Package packs groups dependencies and models into installable tool packs
// (SPEC.md §7). The catalog is frozen data; sizes are measured on the pinned
// versions (SPEC.md §0.4) and must change whenever a pin changes.
package packs

import (
	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/sidecar"
)

// Size is a component's download and on-disk size on one platform.
type Size struct {
	Download int64
	Disk     int64
}

// ComponentSpec is one installable part of one or more packs.
type ComponentSpec struct {
	ID, Name, Href, License string
	Kind                    core.PackComponentKind
	DepID                   string // Kind == dep
	Module, Preset          string // Kind == model: a core.ModelProvider module and its preset
	// Sizes by PlatformKey; a missing key means unsupported on that platform.
	Sizes map[string]Size
	// Version is the pinned version the sizes belong to (tests check pins
	// and sizes move together).
	Version string
}

// Unlock is a tool a pack unlocks, with the components that tool needs.
type Unlock struct {
	Module string
	Needs  []string
}

// PackSpec is one pack.
type PackSpec struct {
	ID, Name, Icon, Description string
	Components                  []string // component IDs
	Unlocks                     []Unlock
}

// Platform keys.
const (
	Windows  = "windows"      // amd64, and arm64 under emulation
	MacARM   = "darwin/arm64" // Apple Silicon
	MacIntel = "darwin/amd64"
)

// PlatformKey maps GOOS/GOARCH to a Sizes key ("" = unsupported platform).
func PlatformKey(goos, goarch string) string {
	switch goos {
	case "windows":
		if goarch == "amd64" || goarch == "arm64" {
			return Windows
		}
	case "darwin":
		return goos + "/" + goarch
	}
	return ""
}

// BuiltIn are module IDs that need no download (shown, never packed).
var BuiltIn = []string{"clipboard", "pdf", "vault", "dev-utils", "organize", "lan-share", "focus"}

const mb = 1_000_000

// Components returns every component in catalog order.
func Components() []ComponentSpec {
	same := func(s Size) map[string]Size { return map[string]Size{Windows: s, MacARM: s, MacIntel: s} }
	return []ComponentSpec{
		{
			ID: "ffmpeg", Name: "FFmpeg", Href: "https://ffmpeg.org", License: "GPL-3.0",
			Kind: core.ComponentDep, DepID: deps.FFmpeg, Version: deps.FFmpegVersion,
			Sizes: map[string]Size{
				Windows: {Download: 114_768_076, Disk: 210_680_000},
				MacARM:  {Download: 56_713_400, Disk: 132_490_944},
			},
		},
		{
			ID: "yt-dlp", Name: "yt-dlp", Href: "https://github.com/yt-dlp/yt-dlp", License: "Unlicense",
			Kind: core.ComponentDep, DepID: deps.YtDlp,
			// Mac size: yt-dlp_macos, measured by the builder (estimate until then).
			Sizes: map[string]Size{
				Windows:  {Download: 23_575_744, Disk: 23_575_744},
				MacARM:   {Download: 36 * mb, Disk: 36 * mb},
				MacIntel: {Download: 36 * mb, Disk: 36 * mb},
			},
		},
		{
			ID: "deno", Name: "Deno", Href: "https://deno.com", License: "MIT",
			Kind: core.ComponentDep, DepID: deps.Deno, Version: deps.DenoVersion,
			Sizes: map[string]Size{
				Windows: {Download: 42_917_472, Disk: 98_081_568},
				MacARM:  {Download: 38_770_795, Disk: 81_512_928},
			},
		},
		{
			ID: "pandoc", Name: "Pandoc", Href: "https://pandoc.org", License: "GPL-2.0-or-later",
			Kind: core.ComponentDep, DepID: deps.Pandoc, Version: deps.PandocVersion,
			// Disk is the executable alone (the layout drops pandoc-lua/-server and docs).
			Sizes: map[string]Size{
				Windows: {Download: 42_983_200, Disk: 239_168_264},
				MacARM:  {Download: 43_148_194, Disk: 195_370_176},
			},
		},
		{
			ID: "typst", Name: "Typst", Href: "https://typst.app", License: "Apache-2.0",
			Kind: core.ComponentDep, DepID: deps.Typst, Version: deps.TypstVersion,
			// Mac disk is an estimate (the tar.xz can't be sized without unpacking it).
			Sizes: map[string]Size{
				Windows: {Download: 22_463_684, Disk: 52_487_680},
				MacARM:  {Download: 14_438_168, Disk: 48 * mb},
			},
		},
		{
			ID: "monolith", Name: "Monolith", Href: "https://github.com/Y2Z/monolith", License: "CC0-1.0",
			Kind: core.ComponentDep, DepID: deps.Monolith, Version: deps.MonolithVersion,
			Sizes: map[string]Size{
				Windows: {Download: 5_539_328, Disk: 5_539_328},
				MacARM:  {Download: 6_227_984, Disk: 6_227_984},
			},
		},
		{
			ID: "engine", Name: "AI engine", Href: "https://github.com/astral-sh/uv", License: "BSD/MIT/Apache",
			Kind: core.ComponentDep, DepID: sidecar.DepID,
			// uv (31.8 MB) + CPython 3.12 (65.4 MB) + the 0.5.0 venv (1,310 MB),
			// measured on Windows on 2026-10-28. The download is mostly the
			// torch CPU wheel; Mac numbers use Windows until measured there.
			Sizes: map[string]Size{
				Windows: {Download: 1_001 * mb, Disk: 1_407_624_938 + 1_655_069}, // + sam-2 and its deps (Phase 9)
				MacARM:  {Download: 1_001 * mb, Disk: 1_407_624_938 + 1_655_069},
			},
		},
		{
			ID: "stems-default", Name: "Demucs 4-stem", Href: "https://github.com/facebookresearch/demucs", License: "MIT",
			Kind: core.ComponentModel, Module: "stems", Preset: "four-fast",
			Sizes: map[string]Size{Windows: {Download: 84_170_199, Disk: 84_170_199}, MacARM: {Download: 84_170_199, Disk: 84_170_199}},
		},
		{
			ID: "stems-vocals", Name: "UVR MDX vocals", Href: "https://github.com/TRvlvr/model_repo", License: "MIT",
			Kind: core.ComponentModel, Module: "stems", Preset: "vocals-fast",
			Sizes: same(Size{Download: 66_759_214, Disk: 66_759_214}),
		},
		{
			// Model + tokenizer, sizes from the pinned files (SPEC.md §0.3).
			ID: "mood-reader", Name: "Mood reader", Href: "https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", License: "Apache-2.0",
			Kind: core.ComponentModel, Module: "visualizer", Preset: "mood",
			Sizes: map[string]Size{Windows: {Download: 127_535_388, Disk: 127_535_388}, MacARM: {Download: 127_493_916, Disk: 127_493_916}},
		},
		{
			ID: "kokoro-voices", Name: "Kokoro voices", Href: "https://huggingface.co/hexgrad/Kokoro-82M", License: "Apache-2.0",
			Kind: core.ComponentModel, Module: "tts", Preset: "kokoro",
			Sizes: same(Size{Download: 120_575_669, Disk: 120_575_669}),
		},
		{
			ID: "whisper-default", Name: "Whisper small", Href: "https://huggingface.co/Systran/faster-whisper-small", License: "MIT",
			Kind: core.ComponentModel, Module: "transcribe", Preset: "small",
			Sizes: map[string]Size{Windows: {Download: 486_217_556, Disk: 486_217_556}, MacARM: {Download: 486_217_556, Disk: 486_217_556}},
		},
		{
			ID: "voice-denoise", Name: "DeepFilterNet3", Href: "https://github.com/Rikorose/DeepFilterNet", License: "MIT/Apache-2.0",
			Kind: core.ComponentModel, Module: "audio-cleanup", Preset: "voice",
			Sizes: same(Size{Download: 7_983_136, Disk: 8_587_242}),
		},
		{
			ID: "bg-default", Name: "BiRefNet lite", Href: "https://github.com/ZhengPeng7/BiRefNet", License: "MIT",
			Kind: core.ComponentModel, Module: "bg-remover", Preset: "balanced",
			Sizes: map[string]Size{Windows: {Download: 224_005_088, Disk: 224_005_088}, MacARM: {Download: 224_005_088, Disk: 224_005_088}},
		},
		{
			ID: "face-detect", Name: "YuNet face detector", Href: "https://huggingface.co/opencv/face_detection_yunet", License: "MIT",
			Kind: core.ComponentModel, Module: "redact", Preset: "faces",
			Sizes: same(Size{Download: 232_589, Disk: 232_589}),
		},
		{
			ID: "plate-detect", Name: "YOLOv9 plate detector", Href: "https://github.com/ankandrew/open-image-models", License: "MIT (code; weights unstated)",
			Kind: core.ComponentModel, Module: "redact", Preset: "plates",
			Sizes: same(Size{Download: 7_835_770, Disk: 7_835_770}),
		},
		{
			// Phase 9 (Edit Studio): pinned files, sizes from the downloads (2026-11-03).
			ID: "matte-people", Name: "Robust Video Matting", Href: "https://github.com/PeterL1n/RobustVideoMatting", License: "GPL-3.0",
			Kind: core.ComponentModel, Module: "edit-studio", Preset: "people",
			Sizes: same(Size{Download: 14_975_696, Disk: 14_975_696}),
		},
		{
			// The checkpoint; the sam-2 package itself adds ≈1.7 MB to the engine's venv.
			ID: "matte-select", Name: "SAM 2.1 tiny", Href: "https://github.com/facebookresearch/sam2", License: "Apache-2.0",
			Kind: core.ComponentModel, Module: "edit-studio", Preset: "select",
			Sizes: same(Size{Download: 156_008_466, Disk: 156_008_466}),
		},
		{
			ID: "inpaint", Name: "LaMa inpainting", Href: "https://github.com/advimman/lama", License: "Apache-2.0",
			Kind: core.ComponentModel, Module: "object-eraser", Preset: "best",
			Sizes: same(Size{Download: 208_044_816, Disk: 208_044_816}),
		},
		{
			ID: "upscaler", Name: "Real-ESRGAN upscaler", Href: "https://github.com/upscayl/upscayl-ncnn", License: "AGPL-3.0 (models BSD-3)",
			Kind: core.ComponentDep, DepID: deps.Upscayl, Version: deps.UpscaylVersion,
			Sizes: map[string]Size{
				Windows:  {Download: 47_920_000, Disk: 54_247_123},
				MacARM:   {Download: 54_840_000, Disk: 62 * mb},
				MacIntel: {Download: 54_840_000, Disk: 62 * mb},
			},
		},
		{
			ID: "exiftool", Name: "ExifTool", Href: "https://exiftool.org", License: "Artistic/GPL",
			Kind: core.ComponentDep, DepID: deps.ExifTool,
			Sizes: map[string]Size{
				Windows:  {Download: 11 * mb, Disk: 34_532_543},
				MacARM:   {Download: 6 * mb, Disk: 25 * mb},
				MacIntel: {Download: 6 * mb, Disk: 25 * mb},
			},
		},
		{
			ID: "chat-engine", Name: "llama.cpp", Href: "https://github.com/ggml-org/llama.cpp", License: "MIT",
			Kind: core.ComponentDep, DepID: deps.Llama, Version: deps.LlamaVersion,
			Sizes: map[string]Size{
				Windows: {Download: 37_184_647, Disk: 104 * mb},
				MacARM:  {Download: 16_341_137, Disk: 40 * mb},
			},
		},
		{
			ID: "chat-default", Name: "Qwen3 4B Instruct", Href: "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507", License: "Apache-2.0",
			Kind: core.ComponentModel, Module: "llm-chat", Preset: "qwen3-4b",
			Sizes: same(Size{Download: 2_497_281_120, Disk: 2_497_281_120}),
		},
	}
}

// Catalog returns every pack in display order.
func Catalog() []PackSpec {
	return []PackSpec{
		{
			ID: "media", Name: "Media", Icon: "film",
			Description: "Download, convert and trim audio and video",
			Components:  []string{"ffmpeg", "yt-dlp", "deno"},
			Unlocks: []Unlock{
				{Module: "downloader", Needs: []string{"ffmpeg", "yt-dlp", "deno"}},
				{Module: "converter", Needs: []string{"ffmpeg"}},
				{Module: "trimmer", Needs: []string{"ffmpeg"}},
				{Module: "scenes", Needs: []string{"ffmpeg"}},
				{Module: "gif", Needs: []string{"ffmpeg"}},
				{Module: "silence", Needs: []string{"ffmpeg"}},
				{Module: "compress", Needs: []string{"ffmpeg"}},
				{Module: "video-studio", Needs: []string{"ffmpeg"}},
			},
		},
		{
			ID: "music", Name: "Music", Icon: "audio-lines",
			Description: "Split songs into stems, find tempo and key, turn melodies into MIDI, make lyric videos and reactive visuals",
			Components:  []string{"engine", "ffmpeg", "stems-default", "stems-vocals", "whisper-default", "mood-reader"},
			Unlocks: []Unlock{
				{Module: "stems", Needs: []string{"engine", "ffmpeg", "stems-default"}},
				{Module: "bpm-key", Needs: []string{"engine"}},
				{Module: "audio-to-midi", Needs: []string{"engine"}},
				{Module: "lyric-video", Needs: []string{"engine", "ffmpeg", "whisper-default", "stems-vocals"}},
				{Module: "visualizer", Needs: []string{"engine", "ffmpeg"}},
			},
		},
		{
			ID: "image", Name: "Image", Icon: "wand-sparkles",
			Description: "Paint+ with the Lab, cut out backgrounds, upscale, erase objects, blur faces and plates, edit metadata",
			Components:  []string{"engine", "ffmpeg", "bg-default", "upscaler", "exiftool", "face-detect", "plate-detect", "inpaint", "matte-select"},
			Unlocks: []Unlock{
				{Module: "bg-remover", Needs: []string{"engine", "bg-default"}},
				{Module: "upscaler", Needs: []string{"upscaler"}},
				{Module: "imagebatch", Needs: []string{}},
				{Module: "exif", Needs: []string{"exiftool"}},
				{Module: "redact", Needs: []string{"engine", "ffmpeg", "face-detect", "plate-detect"}},
				{Module: "object-eraser", Needs: []string{"engine", "inpaint"}},
				{Module: "paint", Needs: []string{}}, // the Lab's perception tools gate on engine, inpaint, bg-default, matte-select, upscaler per tool
			},
		},
		{
			ID: "edit", Name: "Music edits", Icon: "audio-waveform",
			Description: "Cut clips and photos to a song's beats with Edit Studio, with people and subject cut-outs",
			Components:  []string{"engine", "ffmpeg", "stems-default", "whisper-default", "matte-people", "matte-select"},
			Unlocks: []Unlock{
				{Module: "edit-studio", Needs: []string{"engine", "ffmpeg", "stems-default"}},
			},
		},
		{
			ID: "speech", Name: "Speech", Icon: "captions",
			Description: "Transcribe and subtitle recordings, clean up voices, fully offline",
			Components:  []string{"engine", "ffmpeg", "whisper-default", "voice-denoise", "mood-reader", "kokoro-voices"},
			Unlocks: []Unlock{
				{Module: "transcribe", Needs: []string{"engine", "whisper-default"}},
				{Module: "subtitles", Needs: []string{"engine", "ffmpeg", "whisper-default"}},
				{Module: "audio-cleanup", Needs: []string{"ffmpeg", "engine", "voice-denoise"}},
				{Module: "tts", Needs: []string{"engine", "ffmpeg", "kokoro-voices"}},
			},
		},
		{
			ID: "documents", Name: "Text recognition", Icon: "scan-text",
			Description: "Read text from scans and photos; other scripts download ≈13 MB on first use",
			Components:  []string{"engine"},
			Unlocks:     []Unlock{{Module: "ocr", Needs: []string{"engine"}}},
		},
		{
			ID: "docs", Name: "Documents", Icon: "file-text",
			Description: "Convert documents between Markdown, Word, HTML, EPUB and PDF, and save web pages as one file",
			Components:  []string{"pandoc", "typst", "monolith"},
			Unlocks: []Unlock{
				{Module: "documents", Needs: []string{"pandoc", "typst"}},
				{Module: "archiver", Needs: []string{"monolith"}},
			},
		},
		{
			ID: "chat", Name: "Local Chat", Icon: "message-square",
			Description: "A private assistant that runs on your GPU · needs about 4 GB of free memory",
			Components:  []string{"chat-engine", "chat-default"},
			Unlocks:     []Unlock{{Module: "llm-chat", Needs: []string{"chat-engine", "chat-default"}}},
		},
	}
}
