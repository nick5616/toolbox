package lyricvideo

import (
	"bytes"
	"strings"
	"testing"

	"toolbox/core/media"
)

func assOptions() Options {
	o := normalize(DefaultOptions())
	o.Action = ActionRender
	o.Look.ShowNext = false
	o.Look.TitleCard = false
	o.Lines = []LyricLine{
		{StartMs: 1000, EndMs: 4000, Text: "Hello big world", Words: []LyricWord{
			{StartMs: 1000, EndMs: 1600, Text: "Hello"}, {StartMs: 1800, EndMs: 2500, Text: "big"}, {StartMs: 2500, EndMs: 4000, Text: "world"},
		}},
		{StartMs: 5000, EndMs: 7000, Text: "Second {line}", Words: []LyricWord{}},
	}
	return o
}

func events(t *testing.T, doc media.ASSDoc) []string {
	t.Helper()
	var buf bytes.Buffer
	if _, err := doc.WriteTo(&buf); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, l := range strings.Split(buf.String(), "\n") {
		if strings.HasPrefix(l, "Dialogue:") {
			out = append(out, l)
		}
	}
	return out
}

func TestBuildASSKaraokeGolden(t *testing.T) {
	o := assOptions()
	lay := computeLayout(o, 1920, 1080)
	doc := buildASS(o, lay, 0, 0)
	got := events(t, doc)
	if len(got) != 2 {
		t.Fatalf("events = %v", got)
	}
	// Line 1: Hello ends 600 ms after the start, big ends at 1500, world at 3000.
	if got[0] != `Dialogue: 0,0:00:01.00,0:00:04.00,Lyric,,0,0,0,,{\an5\pos(960,540)}{\kf60}Hello {\kf90}big {\kf150}world` {
		t.Errorf("line 1:\n%s", got[0])
	}
	// Line 2 has no words: spread by character share, braces escaped.
	if !strings.HasPrefix(got[1], `Dialogue: 0,0:00:05.00,0:00:07.00,Lyric,,0,0,0,,{\an5\pos(960,540)}{\kf`) || !strings.Contains(got[1], "Second ") || !strings.Contains(got[1], "｛line｝") {
		t.Errorf("line 2:\n%s", got[1])
	}
	st := doc.Styles[0]
	if st.Name != "Lyric" || st.Font != "Arial" || st.Primary != "#ffd166" || st.Secondary != "#ffffff" || !st.Bold || st.Alignment != 5 {
		t.Errorf("style = %+v", st)
	}
	if st.Size != lay.Base || st.Size != 70.2 {
		t.Errorf("size = %v, want 6.5%% of 1080", st.Size)
	}
	if st.OutlineWidth != 2.1 {
		t.Errorf("outline = %v, want 3%% of the size", st.OutlineWidth)
	}
}

func TestKaraokeTextSumsToTheLine(t *testing.T) {
	words := []LyricWord{{StartMs: 1000, EndMs: 1333, Text: "a"}, {StartMs: 1333, EndMs: 1999, Text: "b"}, {StartMs: 1999, EndMs: 3001, Text: "c"}}
	got := karaokeText(words, 1000)
	if got != `{\kf33}a {\kf67}b {\kf100}c` && got != `{\kf33}a {\kf67}b {\kf101}c` {
		t.Errorf("got %s", got)
	}
	// Words that ended before the visible start (a preview cut) get 0.
	got = karaokeText([]LyricWord{{StartMs: 0, EndMs: 500, Text: "x"}, {StartMs: 500, EndMs: 2000, Text: "y"}}, 1000)
	if got != `{\kf0}x {\kf100}y` {
		t.Errorf("cut = %s", got)
	}
}

func TestBuildASSPlainFadeAndNext(t *testing.T) {
	o := assOptions()
	o.Look.Karaoke = false
	o.Look.ShowNext = true
	lay := computeLayout(o, 1920, 1080)
	doc := buildASS(o, lay, 0, 0)
	got := events(t, doc)
	if len(got) != 3 {
		t.Fatalf("events = %v", got)
	}
	if got[0] != `Dialogue: 0,0:00:01.00,0:00:04.00,Lyric,,0,0,0,,{\an5\pos(960,540)\fad(150,150)}Hello big world` {
		t.Errorf("plain: %s", got[0])
	}
	// The next line is shown during the current one, below it, in the dimmer style.
	if !strings.HasPrefix(got[1], `Dialogue: 0,0:00:01.00,0:00:04.00,Next,,0,0,0,,{\an5\pos(960,`) || !strings.HasSuffix(got[1], "Second ｛line｝") {
		t.Errorf("next: %s", got[1])
	}
	if doc.Styles[0].Primary != "#ffffff" {
		t.Errorf("non-karaoke fill colour = %s, want the text colour", doc.Styles[0].Primary)
	}
	next := doc.Styles[1]
	if next.PrimaryAlpha != 115 || next.Size != lay.Base*0.8 {
		t.Errorf("next style = %+v", next)
	}
	// The last line has no next line.
	if strings.Contains(got[2], "Next") {
		t.Errorf("last: %s", got[2])
	}
}

func TestBuildASSTitleCard(t *testing.T) {
	o := assOptions()
	o.Look.TitleCard = true
	o.Look.Title, o.Look.Artist = "My {Song}", "The Band"
	lay := computeLayout(o, 1920, 1080)
	got := events(t, buildASS(o, lay, 0, 0))
	// first line at 1.0 s: the card runs 0 .. min(3 s, 0.8 s)
	if len(got) != 4 || !strings.Contains(got[0], "0:00:00.00,0:00:00.80,Title") || !strings.Contains(got[0], `\fad(300,300)}My ｛Song｝`) ||
		!strings.Contains(got[1], "Artist") || !strings.Contains(got[1], "The Band") {
		t.Fatalf("events = %v", got)
	}
	// A first line that starts within 200 ms leaves no room for the card.
	o.Lines[0].StartMs = 150
	for _, e := range events(t, buildASS(o, lay, 0, 0)) {
		if strings.Contains(e, ",Title,") {
			t.Errorf("unexpected card: %s", e)
		}
	}
	// Late first lines cap the card at 3 s.
	o.Lines[0].StartMs = 20000
	o.Lines[0].EndMs = 22000
	o.Lines[0].Words = nil
	o.Lines[1].StartMs, o.Lines[1].EndMs = 23000, 24000
	got = events(t, buildASS(o, lay, 0, 0))
	if !strings.Contains(got[0], "0:00:00.00,0:00:03.00,Title") {
		t.Errorf("long card: %s", got[0])
	}
	// No title and no artist: no card.
	o.Look.Title, o.Look.Artist = "", ""
	for _, e := range events(t, buildASS(o, lay, 0, 0)) {
		if strings.Contains(e, ",Title,") || strings.Contains(e, ",Artist,") {
			t.Errorf("unexpected card: %s", e)
		}
	}
}

func TestBuildASSLongLineAndWindow(t *testing.T) {
	o := assOptions()
	o.Lines = []LyricLine{
		{StartMs: 0, EndMs: 2000, Text: "This line is definitely longer than thirty characters"},
		{StartMs: 2000, EndMs: 4000, Text: "Short"},
		{StartMs: 4000, EndMs: 6000, Text: "Tail"},
	}
	lay := computeLayout(o, 1280, 720)
	got := events(t, buildASS(o, lay, 0, 0))
	if !strings.Contains(got[0], `\fs40}`) { // 5.5% of 720 = 39.6
		t.Errorf("long line size: %s", got[0])
	}
	if strings.Contains(got[1], `\fs`) {
		t.Errorf("short line has a size override: %s", got[1])
	}

	// Preview window 1500..3500 ms: times shift by -1500, lines cut to the window.
	got = events(t, buildASS(o, lay, 1500, 3500))
	if len(got) != 2 {
		t.Fatalf("window events = %v", got)
	}
	if !strings.HasPrefix(got[0], "Dialogue: 0,0:00:00.00,0:00:00.50,Lyric") || !strings.HasPrefix(got[1], "Dialogue: 0,0:00:00.50,0:00:02.00,Lyric") {
		t.Errorf("window events = %v", got)
	}
}

func TestBuildASSSkipsBlankAndFixesZeroLength(t *testing.T) {
	o := assOptions()
	o.Lines = []LyricLine{
		{StartMs: 0, EndMs: 1000, Text: "  "},
		{StartMs: 1000, EndMs: 1000, Text: "Blink"},
	}
	got := events(t, buildASS(o, computeLayout(o, 1920, 1080), 0, 0))
	if len(got) != 1 || !strings.Contains(got[0], "0:00:01.00,0:00:01.30,") {
		t.Fatalf("events = %v", got)
	}
}

func TestComputeLayout(t *testing.T) {
	cover := assOptions()
	cover.Look.Background = "cover"
	tests := []struct {
		name string
		o    Options
		w, h int
		chk  func(l layout) string
	}{
		{"centred 16:9", assOptions(), 1920, 1080, func(l layout) string {
			if l.CX != 960 || l.CY != 540 || l.Cover || l.VisH != 194 || l.VisY != 1080-194 {
				return "centre layout wrong"
			}
			return ""
		}},
		{"cover 16:9: left third, text right", cover, 1920, 1080, func(l layout) string {
			if !l.Cover || l.CoverX < 0 || l.CoverX+l.CoverS > 640 || l.CoverS > 648 || l.BoxX0 != 640 || l.CX <= 1000 {
				return "landscape cover layout wrong"
			}
			return ""
		}},
		{"cover 9:16: cover on top, text below it", cover, 1080, 1920, func(l layout) string {
			if l.CoverS != 486 || l.CoverY+l.CoverS >= l.CY-int(l.Base) {
				return "portrait cover layout wrong"
			}
			return ""
		}},
		{"cover 1:1", cover, 1080, 1080, func(l layout) string {
			if l.CoverY+l.CoverS >= l.CY-int(l.Base) {
				return "square cover collides with the text"
			}
			return ""
		}},
	}
	for _, tc := range tests {
		if msg := tc.chk(computeLayout(tc.o, tc.w, tc.h)); msg != "" {
			t.Errorf("%s: %s: %+v", tc.name, msg, computeLayout(tc.o, tc.w, tc.h))
		}
	}
	lower := assOptions()
	lower.Look.Position = "lower"
	lower.Look.Visualizer = "wave"
	l := computeLayout(lower, 1920, 1080)
	if l.CY != 928 || l.VisY+l.VisH > l.CY {
		t.Errorf("lower layout: %+v", l)
	}
}

func TestCanvasSize(t *testing.T) {
	tests := []struct {
		aspect string
		height int
		w, h   int
	}{
		{"16:9", 1080, 1920, 1080}, {"16:9", 720, 1280, 720},
		{"9:16", 1080, 1080, 1920}, {"9:16", 720, 720, 1280},
		{"1:1", 1080, 1080, 1080}, {"1:1", 720, 720, 720},
		{"", 0, 1920, 1080},
	}
	for _, tc := range tests {
		if w, h := canvasSize(tc.aspect, tc.height); w != tc.w || h != tc.h {
			t.Errorf("%s@%d = %dx%d, want %dx%d", tc.aspect, tc.height, w, h, tc.w, tc.h)
		}
	}
}
