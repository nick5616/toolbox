package lyricvideo

import (
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
)

func TestParseLRC(t *testing.T) {
	t.Run("plain lines, metadata, sorting, repeats", func(t *testing.T) {
		src := "[ar:Someone]\r\n[ti:Song]\r\n[00:12.50]Second\r\n[00:01.00][00:30.25]Chorus\r\n[00:05]\r\n\r\nnot a lyric\r\n"
		got := ParseLRC(src)
		var texts []string
		var starts []int64
		for _, l := range got {
			texts = append(texts, l.Text)
			starts = append(starts, l.StartMs)
		}
		if !reflect.DeepEqual(texts, []string{"Chorus", "Second", "Chorus"}) {
			t.Fatalf("texts = %v", texts)
		}
		if !reflect.DeepEqual(starts, []int64{1000, 12500, 30250}) {
			t.Fatalf("starts = %v", starts)
		}
		// The blank [00:05] line is dropped; the first line ends no later than the next starts.
		if got[0].EndMs > got[1].StartMs {
			t.Errorf("overlap: %+v", got[:2])
		}
		if len(got[0].Words) != 1 || got[0].Words[0].Text != "Chorus" {
			t.Errorf("words = %+v", got[0].Words)
		}
	})
	t.Run("offset shifts earlier", func(t *testing.T) {
		got := ParseLRC("[offset:+500]\n[00:02.00]Hi\n")
		if len(got) != 1 || got[0].StartMs != 1500 {
			t.Fatalf("got %+v", got)
		}
		got = ParseLRC("[offset:-500]\n[00:02.00]Hi\n")
		if got[0].StartMs != 2500 {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("enhanced word tags", func(t *testing.T) {
		got := ParseLRC("[00:10.00]<00:10.00>Hello <00:10.50>big <00:11.25>world\n[00:13.00]Next\n")
		if len(got) != 2 {
			t.Fatalf("got %d lines", len(got))
		}
		w := got[0].Words
		want := []LyricWord{{10000, 10500, "Hello"}, {10500, 11250, "big"}, {11250, 11500, "world"}}
		if !reflect.DeepEqual(w, want) {
			t.Fatalf("words = %+v, want %+v", w, want)
		}
		if got[0].Text != "Hello big world" || got[0].EndMs != 11500 {
			t.Errorf("line = %+v", got[0])
		}
	})
	t.Run("millisecond fractions and BOM", func(t *testing.T) {
		got := ParseLRC(bom + "[01:02.345]Late\n")
		if len(got) != 1 || got[0].StartMs != 62345 {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("last line gets an estimated end", func(t *testing.T) {
		got := ParseLRC("[00:01.00]A short line\n")
		if got[0].EndMs <= got[0].StartMs || got[0].EndMs-got[0].StartMs > 8000 {
			t.Fatalf("end = %d", got[0].EndMs)
		}
	})
}

func TestParseCues(t *testing.T) {
	srt := "1\r\n00:00:01,000 --> 00:00:03,500\r\nHello <i>there</i>\r\nfriend\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n{\\an8}Second\r\n"
	got := ParseCues(srt)
	if len(got) != 2 || got[0].Text != "Hello there friend" || got[0].StartMs != 1000 || got[0].EndMs != 3500 || got[1].Text != "Second" {
		t.Fatalf("srt: %+v", got)
	}
	if len(got[0].Words) != 3 || got[0].Words[0].StartMs != 1000 || got[0].Words[2].EndMs != 3500 {
		t.Errorf("words not spread: %+v", got[0].Words)
	}
	vtt := "WEBVTT\n\nNOTE comment\n\nintro\n00:01.500 --> 00:03.000 align:start\nOne\n\n01:00:00.000 --> 01:00:01.000\nTwo\n"
	got = ParseCues(vtt)
	if len(got) != 2 || got[0].StartMs != 1500 || got[1].StartMs != 3600000 {
		t.Fatalf("vtt: %+v", got)
	}
}

func TestFormatLRCRoundTrip(t *testing.T) {
	lines := []LyricLine{
		{StartMs: 500, EndMs: 2500, Text: "Hello world", Words: []LyricWord{{500, 1500, "Hello"}, {1500, 2500, "world"}}},
		{StartMs: 61230, EndMs: 63000, Text: "Plain line"},
	}
	out := FormatLRC(lines, "My Song", "Artist\nName")
	if !strings.HasPrefix(out, "[ti:My Song]\n[ar:Artist Name]\n[00:00.50]<00:00.50>Hello <00:01.50>world\n[01:01.23]Plain line\n") {
		t.Fatalf("lrc:\n%s", out)
	}
	back := ParseLRC(out)
	if len(back) != 2 || back[0].StartMs != 500 || !reflect.DeepEqual(back[0].Words, lines[0].Words[:1:1]) && len(back[0].Words) != 2 {
		t.Fatalf("round trip: %+v", back)
	}
	if back[0].Words[1].StartMs != 1500 || back[1].StartMs != 61230 || back[1].Text != "Plain line" {
		t.Errorf("round trip: %+v", back)
	}
	if got := FormatLRC(nil, "", ""); got != "" {
		t.Errorf("empty = %q", got)
	}
}

func TestValidateLines(t *testing.T) {
	ok := []LyricLine{{StartMs: 0, EndMs: 10}, {StartMs: 10, EndMs: 20}}
	tests := []struct {
		name  string
		lines []LyricLine
		bad   bool
	}{
		{"ok", ok, false},
		{"empty", nil, true},
		{"too many", make([]LyricLine, 2001), true},
		{"end before start", []LyricLine{{StartMs: 10, EndMs: 5}}, true},
		{"negative", []LyricLine{{StartMs: -1, EndMs: 5}}, true},
		{"out of order", []LyricLine{{StartMs: 10, EndMs: 12}, {StartMs: 5, EndMs: 6}}, true},
		{"overlapping ends are tolerated", []LyricLine{{StartMs: 0, EndMs: 50}, {StartMs: 10, EndMs: 60}}, false},
	}
	for _, tc := range tests {
		err := validateLines(tc.lines)
		if (err != nil) != tc.bad || (err != nil && !core.IsCode(err, core.CodeValidation)) {
			t.Errorf("%s: err = %v", tc.name, err)
		}
	}
}
