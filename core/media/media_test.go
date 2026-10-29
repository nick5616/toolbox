package media

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain turns the test binary into a fake ffprobe when FAKE_PROBE_MODE
// is set (the re-exec pattern).
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_PROBE_MODE") == "1" {
		fmt.Print(os.Getenv("FAKE_PROBE_STDOUT"))
		if os.Getenv("FAKE_PROBE_FAIL") == "1" {
			fmt.Fprintln(os.Stderr, "Invalid data found when processing input")
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "probe", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseProbe(t *testing.T) {
	cases := []struct {
		name          string
		w, h, rot     int
		startMs       int64
		hasVideo      bool
		cover         bool
		audio, subs   int
		textSubs      bool
		title, artist string
	}{
		{name: "plain", w: 320, h: 240, hasVideo: true, audio: 1},
		{name: "rotated", w: 240, h: 320, rot: 90, hasVideo: true, audio: 1},
		{name: "subs", w: 320, h: 240, startMs: 1500, hasVideo: true, audio: 1, subs: 1, textSubs: true},
		{name: "cover", audio: 1, cover: true, startMs: 25, title: "Song Title", artist: "Some Artist"},
		{name: "sar", w: 768, h: 576, hasVideo: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			info, err := parseProbe(fixture(t, c.name))
			if err != nil {
				t.Fatal(err)
			}
			if (info.Video != nil) != c.hasVideo {
				t.Fatalf("video = %+v", info.Video)
			}
			if info.Video != nil {
				v := info.Video
				if v.Width != c.w || v.Height != c.h || v.Rotation != c.rot {
					t.Errorf("video %dx%d rot %d, want %dx%d rot %d", v.Width, v.Height, v.Rotation, c.w, c.h, c.rot)
				}
				if v.FPS != 25 || v.Codec != "h264" {
					t.Errorf("fps %v codec %q", v.FPS, v.Codec)
				}
			}
			if info.StartMs != c.startMs || info.HasCover != c.cover {
				t.Errorf("start %d cover %v", info.StartMs, info.HasCover)
			}
			if len(info.Audio) != c.audio || len(info.Subtitles) != c.subs {
				t.Errorf("audio %d subs %d", len(info.Audio), len(info.Subtitles))
			}
			if c.subs > 0 && (info.Subtitles[0].Text != c.textSubs || info.Subtitles[0].Language != "eng") {
				t.Errorf("subtitle %+v", info.Subtitles[0])
			}
			if info.Tags["title"] != c.title || info.Tags["artist"] != c.artist {
				t.Errorf("tags %v", info.Tags)
			}
			if info.DurationMs <= 0 || info.Container == "" {
				t.Errorf("duration %d container %q", info.DurationMs, info.Container)
			}
		})
	}
}

func TestRotationNormalised(t *testing.T) {
	for in, want := range map[float64]int{-90: 270, 90: 90, 180: -180 + 360, -180: 180, 270: 270, 0: 0, 89.6: 90} {
		if got := rotationOf([]map[string]any{{"rotation": in}}, nil); got != want {
			t.Errorf("rotation %v = %d, want %d", in, got, want)
		}
	}
	if got := rotationOf(nil, map[string]string{"rotate": "90"}); got != 90 {
		t.Errorf("legacy tag = %d", got)
	}
}

func fakeProbe(t *testing.T, stdout string, fail bool) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_PROBE_MODE", "1")
	t.Setenv("FAKE_PROBE_STDOUT", stdout)
	if fail {
		t.Setenv("FAKE_PROBE_FAIL", "1")
	}
	return exe
}

func TestProbeCachesAndErrors(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "a.mp4")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	exe := fakeProbe(t, string(fixture(t, "plain")), false)
	info, err := Probe(context.Background(), exe, f)
	if err != nil || info.Video == nil {
		t.Fatalf("probe: %v %+v", err, info)
	}
	// Cached: a failing probe isn't consulted for the same file.
	t.Setenv("FAKE_PROBE_FAIL", "1")
	if _, err := Probe(context.Background(), exe, f); err != nil {
		t.Errorf("cache miss: %v", err)
	}
	g := filepath.Join(dir, "b.mp4")
	if err := os.WriteFile(g, []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Probe(context.Background(), exe, g); err == nil || !strings.Contains(err.Error(), "Couldn't read") {
		t.Errorf("err = %v", err)
	}
	if _, err := Probe(context.Background(), exe, filepath.Join(dir, "missing.mp4")); err == nil {
		t.Error("missing file should fail")
	}
}

func TestKeyframes(t *testing.T) {
	exe := fakeProbe(t, "2.000000,\n0.000000,\n1.000000\n", false)
	got, err := Keyframes(context.Background(), exe, "x.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) != "[0 1000 2000]" {
		t.Errorf("keyframes = %v", got)
	}
}

func TestPlayable(t *testing.T) {
	h264 := Info{Video: &VideoStream{Codec: "h264"}, Audio: []AudioStream{{Codec: "aac"}}}
	hevc := Info{Video: &VideoStream{Codec: "hevc"}, Audio: []AudioStream{{Codec: "aac"}}}
	alac := Info{Audio: []AudioStream{{Codec: "alac"}}}
	vp9 := Info{Video: &VideoStream{Codec: "vp9"}, Audio: []AudioStream{{Codec: "opus"}}}
	cases := []struct {
		info      Info
		ext, goos string
		want      bool
	}{
		{h264, ".mp4", "windows", true},
		{h264, ".MP4", "darwin", true},
		{h264, ".mkv", "windows", false},
		{hevc, ".mp4", "windows", false},
		{hevc, ".mov", "darwin", true},
		{alac, ".m4a", "windows", false},
		{alac, ".m4a", "darwin", true},
		{vp9, ".webm", "windows", true},
		{vp9, ".webm", "darwin", false},
		{h264, ".mp4", "linux", false},
		{Info{}, ".mp4", "windows", false},
	}
	for _, c := range cases {
		if got := Playable(c.info, c.ext, c.goos); got != c.want {
			t.Errorf("Playable(%+v, %s, %s) = %v", c.info.Video, c.ext, c.goos, got)
		}
	}
}

func TestASSHelpers(t *testing.T) {
	if got := ASSColor("#ff8000", 0x40); got != "&H400080FF" {
		t.Errorf("ASSColor = %s", got)
	}
	if got := ASSColor("nope", 0); got != "&H00FFFFFF" {
		t.Errorf("invalid colour = %s", got)
	}
	for ms, want := range map[int64]string{0: "0:00:00.00", 1234: "0:00:01.23", 3_723_450: "1:02:03.45", -5: "0:00:00.00"} {
		if got := ASSTime(ms); got != want {
			t.Errorf("ASSTime(%d) = %s, want %s", ms, got, want)
		}
	}
	if got := ASSEscape("a{b}\\c\r\nd"); got != "a｛b｝＼c\\Nd" {
		t.Errorf("ASSEscape = %q", got)
	}
}

func TestASSGolden(t *testing.T) {
	doc := ASSDoc{
		PlayResX: 1920, PlayResY: 1080,
		Styles: []ASSStyle{{
			Name: "Lyric", Font: "Arial", Size: 70.2, Primary: "#ffe14d", Secondary: "#ffffff", Outline: "#000000", Back: "#000000",
			BackAlpha: 0x8C, Bold: true, OutlineWidth: 2.1, Alignment: 5, MarginL: 120, MarginR: 120, MarginV: 80,
		}},
		Events: []ASSEvent{
			{StartMs: 500, EndMs: 5000, Style: "Lyric", Text: `{\kf60}Hello {\kf80}world`},
			{Layer: 1, StartMs: 5200, EndMs: 9000, Style: "Lyric", Text: ASSEscape("two\nlines")},
		},
	}
	var buf bytes.Buffer
	if _, err := doc.WriteTo(&buf); err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "golden.ass")
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(golden, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Errorf("ASS differs from golden:\n%s", buf.String())
	}
}

func TestFonts(t *testing.T) {
	if !ValidFont(DefaultFont) || ValidFont("Comic Sans MS") || len(Fonts()) != 6 {
		t.Error("font list")
	}
}
