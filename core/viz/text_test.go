package viz

import (
	"reflect"
	"testing"
)

func TestEmotionFor(t *testing.T) {
	tests := []struct {
		v, e float64
		want string
	}{
		{-0.5, 0.1, "sadness"}, {-0.5, 0.5, "fear"}, {-0.5, 0.9, "anger"},
		{0, 0.1, "calm"}, {0, 0.5, "awe"}, {0, 0.9, "anger"},
		{0.5, 0.1, "calm"}, {0.5, 0.5, "hope"}, {0.5, 0.9, "joy"},
		{-0.2, 0.33, "awe"}, {0.2, 0.66, "awe"}, {-0.21, 0.32, "sadness"}, {0.21, 0.67, "joy"},
	}
	for _, tc := range tests {
		if got := emotionFor(tc.v, tc.e); got != tc.want {
			t.Errorf("emotionFor(%v,%v) = %s, want %s", tc.v, tc.e, got, tc.want)
		}
	}
}

func testInfo(minor bool) *featureInfo {
	fi := &featureInfo{Version: 1, DurationMs: 20000, FPS: 10, Frames: 200, Tempo: 120,
		Downbeats: []int64{0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000}}
	fi.Key.Minor = minor
	fi.Sections = []struct {
		StartMs int64   `json:"startMs"`
		EndMs   int64   `json:"endMs"`
		Label   string  `json:"label"`
		Energy  float64 `json:"energy"`
	}{{0, 10000, "intro", 0.2}, {10000, 20000, "chorus", 0.9}}
	return fi
}

func TestMusicMood(t *testing.T) {
	mm := &musicMood{info: testInfo(false), brightness: make4(200, 255)}
	v, e := mm.at(5000)
	// major: 0.5*0.6 + 0.4*(1-0.5)
	if !near(v, 0.5) || !near(e, 0.2) {
		t.Errorf("major = %v %v", v, e)
	}
	mm = &musicMood{info: testInfo(true)}
	v, e = mm.at(15000)
	if !near(v, -0.3) || !near(e, 0.9) {
		t.Errorf("minor = %v %v", v, e)
	}
}

func make4(n int, v byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = v
	}
	return b
}

func TestBuildMoodNoReading(t *testing.T) {
	info := testInfo(true)
	keys := buildMood(info, &musicMood{info: info}, nil)
	if len(keys) != 10 || keys[0].Ms != 0 || keys[9].Ms != 18000 {
		t.Fatalf("keys = %+v", keys)
	}
	// minor, mid brightness: v = -0.3, energy .2 then .9 -> fear? sadness / anger
	if keys[0].Emotion != "sadness" || keys[9].Emotion != "anger" {
		t.Errorf("emotions %s %s", keys[0].Emotion, keys[9].Emotion)
	}
	// Words without readings behave the same.
	keys2 := buildMood(info, &musicMood{info: info}, []textLine{{StartMs: 1000, EndMs: 2000, Text: "hi"}})
	if !reflect.DeepEqual(keys, keys2) {
		t.Error("lines without a reading changed the keyframes")
	}
}

func TestBuildMoodWithReadings(t *testing.T) {
	info := testInfo(false) // music: v = 0.3, e = 0.2 in the first half
	mm := &musicMood{info: info}
	lines := []textLine{
		{StartMs: 3000, EndMs: 4000, Text: "a", Meaning: &meaning{Valence: 0.9, Energy: 0.9, Emotion: "joy", Confidence: 0.9}},
		{StartMs: 5000, EndMs: 6000, Text: "b", Meaning: &meaning{Valence: -0.9, Energy: 0.8, Emotion: "anger", Confidence: 0.1}}, // weak
	}
	keys := buildMood(info, mm, lines)
	byMs := map[int64]moodKey{}
	for i, k := range keys {
		byMs[k.Ms] = k
		if i > 0 && k.Ms <= keys[i-1].Ms {
			t.Fatalf("keyframes not strictly increasing: %+v", keys)
		}
	}
	// Before the first line: bar keyframes from the music alone.
	if k, ok := byMs[0]; !ok || k.Emotion != "calm" {
		t.Errorf("first = %+v", k)
	}
	if _, ok := byMs[2000]; !ok {
		t.Error("no bar keyframe before the first line")
	}
	// Line 1: 70/30.
	k := byMs[3000]
	if !near(k.Valence, 0.7*0.9+0.3*0.3) || !near(k.Energy, 0.7*0.9+0.3*0.2) || k.Emotion != "joy" {
		t.Errorf("line 1 key = %+v", k)
	}
	// The reading holds to the line's end only when the next line is not closer than that end.
	if _, ok := byMs[4000]; !ok {
		t.Error("no hold keyframe at the end of line 1")
	}
	// Line 2 is weak: 35/65, emotion from the table.
	k = byMs[5000]
	wantV, wantE := 0.35*-0.9+0.65*0.3, 0.35*0.8+0.65*0.2
	if !near(k.Valence, wantV) || !near(k.Energy, wantE) || k.Emotion != emotionFor(wantV, wantE) {
		t.Errorf("line 2 key = %+v", k)
	}
	// 4 s after the last line the mood is the music's again: 6000+4000 = 10000.
	k, ok := byMs[10000]
	if !ok || k.Emotion != emotionFor(k.Valence, k.Energy) || !near(k.Energy, 0.9) {
		t.Errorf("ease key = %+v ok=%v", k, ok)
	}
	// Nothing between the last line and the ease end except its own hold.
	for ms := range byMs {
		if ms > 6000 && ms < 10000 {
			t.Errorf("unexpected keyframe at %d", ms)
		}
	}
	// Bars resume after the ease.
	if _, ok := byMs[12000]; !ok {
		t.Error("no bar keyframes after the ease")
	}
}

func TestApplyEmphasis(t *testing.T) {
	// 10 fps; a loud stretch at frames 20..29 (2..3 s).
	ch := make([]byte, 100)
	for i := range ch {
		ch[i] = 20
	}
	for i := 20; i < 30; i++ {
		ch[i] = 250
	}
	mk := func(s, e int64, txt string) textWord { return textWord{StartMs: s, EndMs: e, Text: txt} }
	words := []textWord{
		mk(0, 500, "a"), mk(600, 1000, "b"), mk(2000, 2200, "short"), mk(2000, 3000, "loud"), mk(4000, 4500, "c"),
		mk(5000, 5500, "d"), mk(6000, 6500, "held"), mk(7000, 7500, "e"),
	}
	lines := []textLine{{Words: words}}
	applyEmphasis(lines, ch, 10, [][]float64{{6100, 6200, 60}})
	got := map[string]bool{}
	for _, w := range lines[0].Words {
		got[w.Text] = w.Emphasis
	}
	if !got["loud"] || !got["held"] {
		t.Errorf("emphasis = %v", got)
	}
	if got["short"] || got["a"] || got["b"] || got["c"] {
		t.Errorf("too much emphasis: %v", got)
	}
	// No channel: only held notes count.
	lines = []textLine{{Words: []textWord{mk(0, 1000, "x"), mk(6000, 6500, "held")}}}
	applyEmphasis(lines, nil, 10, [][]float64{{6100, 6200, 60}})
	if lines[0].Words[0].Emphasis || !lines[0].Words[1].Emphasis {
		t.Errorf("no-channel emphasis = %+v", lines[0].Words)
	}
}
