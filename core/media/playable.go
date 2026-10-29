package media

import "strings"

// playTable is what the webview on one OS plays directly (SPEC.md §3.3).
// Deliberately conservative: anything else gets a preview copy.
type playTable struct {
	exts, video, audio map[string]bool
}

func set(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, s := range items {
		m[s] = true
	}
	return m
}

var playTables = map[string]playTable{
	"windows": {
		exts:  set(".mp4", ".m4v", ".mov", ".webm", ".ogg", ".oga", ".mp3", ".m4a", ".wav", ".flac", ".opus"),
		video: set("h264", "vp8", "vp9", "av1"),
		audio: set("aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8"),
	},
	"darwin": {
		exts:  set(".mp4", ".m4v", ".mov", ".mp3", ".m4a", ".wav", ".flac", ".aif", ".aiff"),
		video: set("h264", "hevc"),
		audio: set("aac", "mp3", "alac", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_s16be", "pcm_s24be", "pcm_u8"),
	},
}

// Playable reports whether the webview on goos can play the file directly:
// its extension, video codec and first audio codec must all be in the
// table. Unknown OSes play nothing directly.
func Playable(info Info, ext, goos string) bool {
	t, ok := playTables[goos]
	if !ok || !t.exts[strings.ToLower(ext)] {
		return false
	}
	if info.Video != nil && !t.video[info.Video.Codec] {
		return false
	}
	if len(info.Audio) > 0 && !t.audio[info.Audio[0].Codec] {
		return false
	}
	return info.Video != nil || len(info.Audio) > 0
}

// Fonts lists the fonts offered for rendered text. All ship with both
// Windows and macOS; libass falls back through DirectWrite/CoreText for
// scripts they lack (SPEC.md §3.6).
func Fonts() []string {
	return []string{"Arial", "Verdana", "Georgia", "Trebuchet MS", "Impact", "Courier New"}
}

// DefaultFont is the default of Fonts().
const DefaultFont = "Arial"

// ValidFont reports whether name is in Fonts().
func ValidFont(name string) bool {
	for _, f := range Fonts() {
		if f == name {
			return true
		}
	}
	return false
}

// VideoExtensions are the video inputs the Phase 6 tools accept.
func VideoExtensions() []string {
	return []string{".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts", ".mts", ".m2ts", ".wmv", ".flv", ".3gp"}
}

// AudioExtensions are the audio inputs the Phase 6 tools accept.
func AudioExtensions() []string {
	return []string{".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma", ".aiff", ".aif"}
}

// ImageExtensions are the image inputs Redact and Object Eraser accept.
func ImageExtensions() []string {
	return []string{".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"}
}
