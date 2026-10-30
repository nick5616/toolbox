package subtitles

import (
	"context"
	"strings"
	"testing"
)

func TestGenerateFillsCueWords(t *testing.T) {
	ws := words(1000, 50, "Hello", "there", "my", "friend.", "How", "are", "you")
	cues := buildCues([]rawSegment{seg(ws)}, 42, 2)
	if len(cues) == 0 {
		t.Fatal("no cues")
	}
	var got []string
	for _, c := range cues {
		if len(c.Words) == 0 {
			t.Fatalf("cue %q has no words", c.Text)
		}
		for _, w := range c.Words {
			if w.Text != strings.TrimSpace(w.Text) || w.Text == "" {
				t.Errorf("bad word text %q", w.Text)
			}
			if w.StartMs < c.StartMs || w.StartMs > c.EndMs {
				t.Errorf("word %+v outside cue %d-%d", w, c.StartMs, c.EndMs)
			}
			got = append(got, w.Text)
		}
	}
	if strings.Join(got, " ") != "Hello there my friend. How are you" {
		t.Errorf("words = %v", got)
	}
	if cues[0].Words[0].StartMs != 1000 || cues[0].Words[0].EndMs != 1300 {
		t.Errorf("first word times = %+v", cues[0].Words[0])
	}
}

func TestGenerateCJKWordsPerCharacter(t *testing.T) {
	s := rawSegment{StartMs: 0, EndMs: 900, Text: "今日は", Words: []rawWord{{0, 900, "今日は"}}}
	cues := buildCues([]rawSegment{s}, 42, 2)
	if len(cues) != 1 || len(cues[0].Words) != 3 {
		t.Fatalf("cues = %+v", cues)
	}
	if cues[0].Words[1].Text != "日" || cues[0].Words[1].StartMs != 300 {
		t.Errorf("word 1 = %+v", cues[0].Words[1])
	}
}

func TestSegmentsWithoutWordsGetNone(t *testing.T) {
	s := rawSegment{StartMs: 0, EndMs: 3000, Text: "No word timings here."}
	for _, c := range buildCues([]rawSegment{s}, 42, 2) {
		if len(c.Words) != 0 {
			t.Errorf("cue %q has words %v", c.Text, c.Words)
		}
	}
}

func TestSaveIgnoresWordsAndLoadHasNone(t *testing.T) {
	withWords := []Cue{{StartMs: 0, EndMs: 1000, Text: "Hi there", Words: []CueWord{{0, 500, "Hi"}, {500, 1000, "there"}}}}
	without := []Cue{{StartMs: 0, EndMs: 1000, Text: "Hi there"}}
	if formatSRT(withWords) != formatSRT(without) || formatVTT(withWords) != formatVTT(without) {
		t.Error("words changed the file output")
	}
	for _, c := range parseCues(formatSRT(withWords)) {
		if len(c.Words) != 0 {
			t.Errorf("parsed cue has words: %+v", c)
		}
	}
}

func TestTranslateDropsWords(t *testing.T) {
	tg := &fakeTG{reply: echoUpper}
	cues := makeCues(2, "hello")
	for i := range cues {
		cues[i].Words = []CueWord{{cues[i].StartMs, cues[i].EndMs, "hello"}}
	}
	out, err := translateCues(context.Background(), tg, cues, "en", "es", 42, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range out {
		if len(c.Words) != 0 {
			t.Errorf("cue %d kept words", i)
		}
	}
}
