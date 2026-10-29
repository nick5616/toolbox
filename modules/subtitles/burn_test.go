package subtitles

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite golden files")

func renderASS(t *testing.T, o Options, w, h int) string {
	t.Helper()
	var b bytes.Buffer
	cues := []Cue{{StartMs: 1000, EndMs: 2500, Text: "Hello\nworld {x}"}}
	if _, err := buildASS(cues, o, w, h).WriteTo(&b); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestBurnASSGolden(t *testing.T) {
	for _, style := range []Style{StyleClassic, StyleBoxed, StyleYellow, StyleMinimal} {
		o := DefaultOptions()
		o.Style = style
		got := renderASS(t, o, 1920, 1080)
		golden := filepath.Join("testdata", "burn_"+string(style)+".ass")
		if *update {
			if err := os.MkdirAll("testdata", 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		want, err := os.ReadFile(golden)
		if err != nil {
			t.Fatal(err)
		}
		if strings.ReplaceAll(string(want), "\r\n", "\n") != strings.ReplaceAll(got, "\r\n", "\n") {
			t.Errorf("%s differs from golden:\n%s", style, got)
		}
	}
}

func TestBurnGeometry(t *testing.T) {
	o := DefaultOptions()
	o.Size = "l"
	o.Position = "top"
	doc := buildASS(nil, o, 1080, 1920) // portrait
	st := doc.Styles[0]
	if want := 6.5 * 0.01 * 1080 * 1.25; st.Size < want-0.1 || st.Size > want+0.1 {
		t.Errorf("portrait size %v, want about %v", st.Size, want)
	}
	if st.Alignment != 8 {
		t.Errorf("alignment %d", st.Alignment)
	}
	if st.MarginV != 115 { // 6% of 1920
		t.Errorf("marginV %d", st.MarginV)
	}
	land := buildASS(nil, DefaultOptions(), 1920, 1080).Styles[0]
	if land.Size < 59 || land.Size > 60 || land.Alignment != 2 { // 5.5% of 1080 = 59.4
		t.Errorf("landscape %+v", land)
	}
	box := buildASS(nil, Options{Style: StyleBoxed, Size: "m", Position: "bottom"}, 1280, 720).Styles[0]
	if box.BorderStyle != 3 || box.BackAlpha != 115 {
		t.Errorf("boxed %+v", box)
	}
}

func TestBurnArgs(t *testing.T) {
	a := burnArgs("in.mkv", "out.mp4", "aac")
	joined := strings.Join(a, " ")
	for _, want := range []string{"-vf ass=subs.ass", "-c:v libx264", "-preset medium", "-crf 18", "-pix_fmt yuv420p", "-c:a copy", "-movflags +faststart"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %s", want, joined)
		}
	}
	if j := strings.Join(burnArgs("in.mkv", "out.mp4", "opus"), " "); !strings.Contains(j, "-c:a aac -b:a 192k") {
		t.Errorf("non-copyable audio: %s", j)
	}
	if j := strings.Join(burnArgs("in.mkv", "out.mp4", "mp3"), " "); !strings.Contains(j, "-c:a copy") {
		t.Errorf("mp3 should copy: %s", j)
	}
}

func TestEmbedPlan(t *testing.T) {
	tests := []struct {
		ext, codec, out string
		remux           bool
	}{
		{".mp4", "mov_text", ".mp4", false},
		{".MOV", "mov_text", ".mov", false},
		{".m4v", "mov_text", ".m4v", false},
		{".mkv", "srt", ".mkv", false},
		{".webm", "webvtt", ".webm", false},
		{".avi", "srt", ".mkv", true},
		{".ts", "srt", ".mkv", true},
	}
	for _, tt := range tests {
		c, o, r := embedPlan(tt.ext)
		if c != tt.codec || o != tt.out || r != tt.remux {
			t.Errorf("%s: got %s %s %v", tt.ext, c, o, r)
		}
	}
}

func TestEmbedArgs(t *testing.T) {
	got := embedArgs("in.mp4", "subs.srt", "out.mp4", "mov_text", "es", 2)
	want := []string{"-hide_banner", "-nostdin", "-y", "-i", "in.mp4", "-i", "subs.srt",
		"-map", "0", "-map", "1", "-c", "copy", "-c:s:2", "mov_text", "-metadata:s:s:2", "language=spa",
		"-progress", "pipe:1", "-nostats", "out.mp4"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v", got)
	}
	if j := strings.Join(embedArgs("a", "b", "c", "srt", "", 0), " "); !strings.Contains(j, "language=und") {
		t.Errorf("unknown language: %s", j)
	}
}
