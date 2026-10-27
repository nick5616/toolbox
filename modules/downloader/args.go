package downloader

import (
	"fmt"
	"strconv"
	"strings"
)

// ArgEnv carries the environment-specific values BuildArgs needs.
type ArgEnv struct {
	OutputDir  string
	TempDir    string
	CacheDir   string
	FFmpegPath string
	// JSRuntime is "deno:<path>", "node:<path>" or "" (omit the flag).
	JSRuntime string
}

const (
	dlTemplate    = "download:[tbx:dl] %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|%(info.n_entries)s"
	ppTemplate    = "postprocess:[tbx:pp] %(progress.status)s|%(progress.postprocessor)s"
	startTemplate = "before_dl:[tbx:start] %(id)s|%(format_id)s|%(playlist_index)s|%(n_entries)s|%(title)s"
	outTemplate   = "after_move:[tbx:out] %(filepath)s"
)

// BuildArgs builds the yt-dlp argument list for one input. It is pure.
func BuildArgs(opts Options, input string, env ArgEnv) []string {
	args := []string{
		"--ignore-config", "--color", "never",
		"--newline", "--progress", "--no-simulate", "--no-mtime",
		"--encoding", "utf-8",
		"--cache-dir", env.CacheDir,
		"--ffmpeg-location", env.FFmpegPath,
	}
	if env.JSRuntime != "" {
		args = append(args, "--js-runtimes", env.JSRuntime)
	}
	args = append(args,
		"-P", "home:"+env.OutputDir,
		"-P", "temp:"+env.TempDir,
		"--progress-template", dlTemplate,
		"--progress-template", ppTemplate,
		"--print", startTemplate,
		"--print", outTemplate,
	)

	if opts.Playlist {
		args = append(args, "--yes-playlist")
	} else {
		args = append(args, "--no-playlist")
	}

	start, end, hasEnd := trimBounds(opts)
	cut := ""
	if opts.TrimEnabled {
		endLabel := "end"
		if hasEnd {
			endLabel = cutLabel(end)
		}
		cut = fmt.Sprintf(" [cut %s-%s]", cutLabel(start), endLabel)
	}
	tmpl := "%(title).150B [%(id)s]" + cut + ".%(ext)s"
	if opts.Playlist {
		tmpl = "%(playlist_title,playlist_id).80B/%(playlist_index)03d - " + tmpl
	}
	args = append(args, "-o", tmpl)

	isWAV := false
	switch opts.Mode {
	case ModeVideo:
		args = append(args, videoArgs(opts.MaxResolution)...)
	default:
		isWAV = opts.AudioFormat == FormatWAV
		args = append(args, "-f", "ba/b", "-x", "--audio-format", string(opts.AudioFormat))
		if opts.AudioFormat == FormatMP3 {
			args = append(args, "--audio-quality", mp3Quality(opts.AudioQuality))
		}
	}

	if opts.TrimEnabled {
		endStr := "inf"
		if hasEnd {
			endStr = fmtSeconds(end)
		}
		args = append(args, "--download-sections", "*"+fmtSeconds(start)+"-"+endStr)
		if opts.Mode == ModeVideo {
			args = append(args, "--force-keyframes-at-cuts")
		}
	}

	if opts.EmbedMetadata {
		args = append(args, "--embed-metadata")
		if !opts.TrimEnabled {
			args = append(args, "--embed-chapters")
		}
	}
	if opts.EmbedThumbnail && !isWAV {
		args = append(args, "--embed-thumbnail", "--convert-thumbnails", "jpg")
	}

	return append(args, "--", input)
}

func videoArgs(res MaxResolution) []string {
	format := "bv*+ba/b"
	sort := "vcodec:h264,acodec:aac"
	if res != ResBest && res != "" {
		n := string(res)
		format = fmt.Sprintf("bv*[height<=%s]+ba/b[height<=%s]/bv*+ba/b", n, n)
		sort = "res:" + n + "," + sort
	}
	return []string{"-f", format, "-S", sort, "--merge-output-format", "mp4", "--remux-video", "mp4"}
}

func mp3Quality(q AudioQuality) string {
	switch q {
	case Quality320, Quality256, Quality192, Quality128:
		return string(q) + "K"
	}
	return "0"
}

// trimBounds returns start/end seconds; unparseable values fall back to
// 0 / unset (Validate rejects them before Run).
func trimBounds(opts Options) (start, end float64, hasEnd bool) {
	if !opts.TrimEnabled {
		return 0, 0, false
	}
	if s := strings.TrimSpace(opts.TrimStart); s != "" {
		if v, err := ParseTimecode(s); err == nil {
			start = v
		}
	}
	if e := strings.TrimSpace(opts.TrimEnd); e != "" {
		if v, err := ParseTimecode(e); err == nil {
			end, hasEnd = v, true
		}
	}
	return
}

// cutLabel formats seconds as e.g. "1m05s" (filename safe, no colons).
func cutLabel(sec float64) string {
	total := int(sec)
	return fmt.Sprintf("%dm%02ds", total/60, total%60)
}

func fmtSeconds(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
