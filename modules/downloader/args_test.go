package downloader

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

var testEnv = ArgEnv{OutputDir: "/out", TempDir: "/tmp/j", CacheDir: "/cache", FFmpegPath: "/bin/ffmpeg"}

func argsFor(mut func(*Options), env ArgEnv) []string {
	o := DefaultOptions()
	if mut != nil {
		mut(&o)
	}
	return BuildArgs(o, "https://example.com/v", env)
}

func contains(args []string, seq ...string) bool {
	for i := 0; i+len(seq) <= len(args); i++ {
		if slices.Equal(args[i:i+len(seq)], seq) {
			return true
		}
	}
	return false
}

func indexOf(args []string, s string) int { return slices.Index(args, s) }

func TestBuildArgsPrefixAndSuffix(t *testing.T) {
	env := testEnv
	env.JSRuntime = "deno:/bin/deno"
	a := argsFor(nil, env)
	want := []string{
		"--ignore-config", "--color", "never",
		"--newline", "--progress", "--no-simulate", "--no-mtime",
		"--encoding", "utf-8",
		"--cache-dir", "/cache",
		"--ffmpeg-location", "/bin/ffmpeg",
		"--js-runtimes", "deno:/bin/deno",
		"-P", "home:/out", "-P", "temp:/tmp/j",
		"--progress-template", dlTemplate,
		"--progress-template", ppTemplate,
		"--print", startTemplate,
		"--print", outTemplate,
		"--no-playlist",
		"-o", "%(title).150B [%(id)s].%(ext)s",
	}
	if !reflect.DeepEqual(a[:len(want)], want) {
		t.Fatalf("prefix mismatch\n got  %q\n want %q", a[:len(want)], want)
	}
	if n := len(a); a[n-2] != "--" || a[n-1] != "https://example.com/v" {
		t.Errorf("suffix = %q", a[n-2:])
	}
	if !strings.Contains(dlTemplate, "%(progress.total_bytes_estimate)s") {
		t.Error("template sanity")
	}
}

func TestBuildArgsJSRuntime(t *testing.T) {
	if slices.Contains(argsFor(nil, testEnv), "--js-runtimes") {
		t.Error("--js-runtimes must be omitted when empty")
	}
	env := testEnv
	env.JSRuntime = "node:/usr/bin/node"
	if !contains(argsFor(nil, env), "--js-runtimes", "node:/usr/bin/node") {
		t.Error("node runtime missing")
	}
}

func TestBuildArgsAudio(t *testing.T) {
	tests := []struct {
		name string
		mut  func(*Options)
		want []string
		not  []string
	}{
		{"mp3 320", nil, []string{"-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "320K"}, nil},
		{"mp3 best", func(o *Options) { o.AudioQuality = QualityBest }, []string{"--audio-format", "mp3", "--audio-quality", "0"}, nil},
		{"mp3 128", func(o *Options) { o.AudioQuality = Quality128 }, []string{"--audio-quality", "128K"}, nil},
		{"flac no quality", func(o *Options) { o.AudioFormat = FormatFLAC }, []string{"--audio-format", "flac"}, []string{"--audio-quality"}},
		{"wav no quality", func(o *Options) { o.AudioFormat = FormatWAV }, []string{"--audio-format", "wav"}, []string{"--audio-quality"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := argsFor(tc.mut, testEnv)
			if !contains(a, tc.want...) {
				t.Errorf("missing %q in %q", tc.want, a)
			}
			for _, n := range tc.not {
				if slices.Contains(a, n) {
					t.Errorf("unexpected %q", n)
				}
			}
			if slices.Contains(a, "--merge-output-format") {
				t.Error("video flags in audio mode")
			}
		})
	}
}

func TestBuildArgsVideo(t *testing.T) {
	vid := func(res MaxResolution) func(*Options) {
		return func(o *Options) { o.Mode, o.MaxResolution = ModeVideo, res }
	}
	a := argsFor(vid(Res720), testEnv)
	for _, seq := range [][]string{
		{"-f", "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b"},
		{"-S", "res:720,vcodec:h264,acodec:aac"},
		{"--merge-output-format", "mp4", "--remux-video", "mp4"},
	} {
		if !contains(a, seq...) {
			t.Errorf("missing %q in %q", seq, a)
		}
	}
	if slices.Contains(a, "-x") {
		t.Error("-x in video mode")
	}

	b := argsFor(vid(ResBest), testEnv)
	if !contains(b, "-f", "bv*+ba/b") || !contains(b, "-S", "vcodec:h264,acodec:aac") {
		t.Errorf("best resolution args wrong: %q", b)
	}
	if slices.ContainsFunc(b, func(s string) bool { return strings.Contains(s, "height<=") || strings.Contains(s, "res:") }) {
		t.Errorf("best must drop height filters: %q", b)
	}
}

func TestBuildArgsTrim(t *testing.T) {
	tests := []struct {
		name       string
		mut        func(*Options)
		wantSect   string
		wantTmpl   string
		wantForce  bool
		wantChapts bool
	}{
		{"audio start+end", func(o *Options) { o.TrimEnabled, o.TrimStart, o.TrimEnd = true, "1:05", "2:00" },
			"*65-120", "%(title).150B [%(id)s] [cut 1m05s-2m00s].%(ext)s", false, false},
		{"audio end only", func(o *Options) { o.TrimEnabled, o.TrimEnd = true, "0:12.5" },
			"*0-12.5", "%(title).150B [%(id)s] [cut 0m00s-0m12s].%(ext)s", false, false},
		{"video start only", func(o *Options) { o.Mode, o.TrimEnabled, o.TrimStart = ModeVideo, true, "1:02:03" },
			"*3723-inf", "%(title).150B [%(id)s] [cut 62m03s-end].%(ext)s", true, false},
		{"video both", func(o *Options) { o.Mode, o.TrimEnabled, o.TrimStart, o.TrimEnd = ModeVideo, true, "5", "12" },
			"*5-12", "%(title).150B [%(id)s] [cut 0m05s-0m12s].%(ext)s", true, false},
		{"no trim", nil, "", "%(title).150B [%(id)s].%(ext)s", false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := argsFor(tc.mut, testEnv)
			i := indexOf(a, "--download-sections")
			if tc.wantSect == "" {
				if i >= 0 {
					t.Errorf("unexpected --download-sections")
				}
			} else if i < 0 || a[i+1] != tc.wantSect {
				t.Errorf("sections = %v, want %q", a, tc.wantSect)
			}
			if !contains(a, "-o", tc.wantTmpl) {
				t.Errorf("template: want %q in %q", tc.wantTmpl, a)
			}
			if got := slices.Contains(a, "--force-keyframes-at-cuts"); got != tc.wantForce {
				t.Errorf("force-keyframes = %v, want %v", got, tc.wantForce)
			}
			if got := slices.Contains(a, "--embed-chapters"); got != tc.wantChapts {
				t.Errorf("embed-chapters = %v, want %v", got, tc.wantChapts)
			}
		})
	}
}

func TestBuildArgsEmbed(t *testing.T) {
	tests := []struct {
		name                  string
		mut                   func(*Options)
		meta, chapters, thumb bool
	}{
		{"both on", nil, true, true, true},
		{"both off", func(o *Options) { o.EmbedMetadata, o.EmbedThumbnail = false, false }, false, false, false},
		{"meta only", func(o *Options) { o.EmbedThumbnail = false }, true, true, false},
		{"thumb only", func(o *Options) { o.EmbedMetadata = false }, false, false, true},
		{"wav skips thumbnail", func(o *Options) { o.AudioFormat = FormatWAV }, true, true, false},
		{"flac keeps thumbnail", func(o *Options) { o.AudioFormat = FormatFLAC }, true, true, true},
		{"video wav setting irrelevant", func(o *Options) { o.Mode, o.AudioFormat = ModeVideo, FormatWAV }, true, true, true},
		{"trim drops chapters", func(o *Options) { o.TrimEnabled, o.TrimStart = true, "5" }, true, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := argsFor(tc.mut, testEnv)
			if got := slices.Contains(a, "--embed-metadata"); got != tc.meta {
				t.Errorf("embed-metadata = %v", got)
			}
			if got := slices.Contains(a, "--embed-chapters"); got != tc.chapters {
				t.Errorf("embed-chapters = %v", got)
			}
			if got := contains(a, "--embed-thumbnail", "--convert-thumbnails", "jpg"); got != tc.thumb {
				t.Errorf("embed-thumbnail = %v", got)
			}
		})
	}
}

func TestBuildArgsPlaylist(t *testing.T) {
	a := argsFor(func(o *Options) { o.Playlist = true; o.TrimEnabled = true; o.TrimStart = "5" }, testEnv)
	if !slices.Contains(a, "--yes-playlist") || slices.Contains(a, "--no-playlist") {
		t.Errorf("playlist flags: %q", a)
	}
	want := "%(playlist_title,playlist_id).80B/%(playlist_index)03d - %(title).150B [%(id)s] [cut 0m05s-end].%(ext)s"
	if !contains(a, "-o", want) {
		t.Errorf("playlist template missing: %q", a)
	}
	if i, j := indexOf(a, "--yes-playlist"), indexOf(a, "-o"); i > j {
		t.Error("playlist flag must precede -o")
	}
}
