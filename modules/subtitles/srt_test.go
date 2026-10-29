package subtitles

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestFormatSRTAndVTT(t *testing.T) {
	cues := []Cue{
		{StartMs: 1500, EndMs: 3250, Text: "Hello\nworld"},
		{StartMs: 3_600_000 + 61_001, EndMs: 3_600_000 + 62_000, Text: "A & B <i>"},
	}
	wantSRT := "1\n00:00:01,500 --> 00:00:03,250\nHello\nworld\n\n2\n01:01:01,001 --> 01:01:02,000\nA & B <i>\n\n"
	if got := formatSRT(cues); got != wantSRT {
		t.Errorf("srt = %q", got)
	}
	wantVTT := "WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nHello\nworld\n\n01:01:01.001 --> 01:01:02.000\nA &amp; B &lt;i&gt;\n\n"
	if got := formatVTT(cues); got != wantVTT {
		t.Errorf("vtt = %q", got)
	}
}

func TestCueBodyDropsBlankLines(t *testing.T) {
	if got := cueBody("a\r\n\r\n  \nb  "); got != "a\nb" {
		t.Errorf("got %q", got)
	}
}

func TestParseCues(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []Cue
	}{
		{"srt crlf", "1\r\n00:00:01,000 --> 00:00:02,500\r\nHi\r\nthere\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n",
			[]Cue{{1000, 2500, "Hi\nthere"}, {3000, 4000, "Bye"}}},
		{"bom", bomStr + "1\n00:00:01,000 --> 00:00:02,000\nX\n", []Cue{{1000, 2000, "X"}}},
		{"vtt tags and settings", "WEBVTT\n\nNOTE hi\n\nintro\n00:01.000 --> 00:02.000 align:start position:10%\n<v Bob><i>Hello</i> &amp; <c.yellow>you</c>\n",
			[]Cue{{1000, 2000, "Hello & you"}}},
		{"hours over 99 minutes", "1\n100:00:01,000 --> 100:00:02,000\nLong\n", []Cue{{360_001_000, 360_002_000, "Long"}}},
		{"hours over 99 minutes vtt", "WEBVTT\n\n120:30:00.500 --> 120:30:01.000\nLong\n", []Cue{{433_800_500, 433_801_000, "Long"}}},
		{"bad and unordered", "1\n00:00:05,000 --> 00:00:06,000\nB\n\n2\n00:00:09,000 --> 00:00:08,000\nbad\n\n3\n00:00:01,000 --> 00:00:02,000\nA\n",
			[]Cue{{1000, 2000, "A"}, {5000, 6000, "B"}}},
		{"short fraction", "1\n00:00:01,5 --> 00:00:02,25\nX\n", []Cue{{1500, 2250, "X"}}},
		{"empty", "", []Cue{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseCues(decodeText([]byte(tt.in))); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestDecodeWindows1252(t *testing.T) {
	// "café – “ok”" in Windows-1252.
	b := []byte{'c', 'a', 'f', 0xE9, ' ', 0x96, ' ', 0x93, 'o', 'k', 0x94}
	if got := decodeText(b); got != "café – “ok”" {
		t.Errorf("got %q", got)
	}
	if got := decodeText([]byte("\xef\xbb\xbfplain")); got != "plain" {
		t.Errorf("bom: %q", got)
	}
	if got := decodeText([]byte("日本語")); got != "日本語" {
		t.Errorf("utf8: %q", got)
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.srt")
	if err := os.WriteFile(p, []byte("1\n00:00:01,000 --> 00:00:02,000\nna\xefve\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cues, err := load(p)
	if err != nil || len(cues) != 1 || cues[0].Text != "naïve" {
		t.Fatalf("got %+v, %v", cues, err)
	}
	if _, err := load(filepath.Join(dir, "x.txt")); err == nil {
		t.Error("expected an error for .txt")
	}
	if _, err := load(filepath.Join(dir, "missing.srt")); err == nil {
		t.Error("expected an error for a missing file")
	}
}

func TestRoundTrip(t *testing.T) {
	cues := []Cue{{0, 1200, "one\ntwo"}, {1300, 2000, "three"}}
	for name, f := range map[string]func([]Cue) string{"srt": formatSRT, "vtt": formatVTT} {
		if got := parseCues(f(cues)); !reflect.DeepEqual(got, cues) {
			t.Errorf("%s: got %+v", name, got)
		}
	}
	if !strings.HasPrefix(formatVTT(cues), "WEBVTT") {
		t.Error("missing header")
	}
}
