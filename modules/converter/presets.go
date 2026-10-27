package converter

import "toolbox/core"

// presetSpec is one conversion preset (SPEC.md §5). Args go after "-i <in>".
type presetSpec struct {
	ID      Preset
	Label   string
	Group   string // "Audio" | "Video" | "Image"
	Kind    core.OutputKind
	Ext     string
	Args    []string
	Accepts []core.OutputKind
}

var (
	audioOrVideo = []core.OutputKind{core.KindAudio, core.KindVideo}
	videoOnly    = []core.OutputKind{core.KindVideo}
	imageOnly    = []core.OutputKind{core.KindImage}
)

// presets in UI order.
var presets = []presetSpec{
	{"mp3-320", "MP3 · 320 kbps", "Audio", core.KindAudio, ".mp3", []string{"-vn", "-c:a", "libmp3lame", "-b:a", "320k"}, audioOrVideo},
	{"mp3-v0", "MP3 · V0 (VBR)", "Audio", core.KindAudio, ".mp3", []string{"-vn", "-c:a", "libmp3lame", "-q:a", "0"}, audioOrVideo},
	{"aac-256", "AAC · 256 kbps (.m4a)", "Audio", core.KindAudio, ".m4a", []string{"-vn", "-c:a", "aac", "-b:a", "256k"}, audioOrVideo},
	{"flac", "FLAC (lossless)", "Audio", core.KindAudio, ".flac", []string{"-vn", "-c:a", "flac"}, audioOrVideo},
	{"wav-16-44", "WAV · 16-bit / 44.1 kHz", "Audio", core.KindAudio, ".wav", []string{"-vn", "-c:a", "pcm_s16le", "-ar", "44100"}, audioOrVideo},
	{"wav-24-48", "WAV · 24-bit / 48 kHz", "Audio", core.KindAudio, ".wav", []string{"-vn", "-c:a", "pcm_s24le", "-ar", "48000"}, audioOrVideo},
	{"aiff-16", "AIFF · 16-bit", "Audio", core.KindAudio, ".aiff", []string{"-vn", "-c:a", "pcm_s16be"}, audioOrVideo},
	{"opus-160", "Opus · 160 kbps", "Audio", core.KindAudio, ".opus", []string{"-vn", "-c:a", "libopus", "-b:a", "160k"}, audioOrVideo},
	{"mp4-h264", "MP4 · H.264", "Video", core.KindVideo, ".mp4", []string{"-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"}, videoOnly},
	{"mp4-h265", "MP4 · H.265 / HEVC", "Video", core.KindVideo, ".mp4", []string{"-c:v", "libx265", "-crf", "24", "-preset", "medium", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"}, videoOnly},
	{"webm-vp9", "WebM · VP9", "Video", core.KindVideo, ".webm", []string{"-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-c:a", "libopus", "-b:a", "128k"}, videoOnly},
	{"png", "PNG", "Image", core.KindImage, ".png", nil, imageOnly},
	{"jpeg", "JPEG", "Image", core.KindImage, ".jpg", []string{"-q:v", "2"}, imageOnly},
	{"webp", "WebP", "Image", core.KindImage, ".webp", []string{"-c:v", "libwebp", "-quality", "85"}, imageOnly},
}

// lookup finds a preset by ID.
func lookup(id Preset) (presetSpec, bool) {
	for _, p := range presets {
		if p.ID == id {
			return p, true
		}
	}
	return presetSpec{}, false
}

// PresetInfos lists presets for the UI.
func PresetInfos() []core.PresetInfo {
	out := make([]core.PresetInfo, 0, len(presets))
	for _, p := range presets {
		out = append(out, core.PresetInfo{
			ID: string(p.ID), Label: p.Label, Group: p.Group, Kind: p.Kind, Ext: p.Ext,
			AcceptsKinds: append([]core.OutputKind(nil), p.Accepts...),
		})
	}
	return out
}
