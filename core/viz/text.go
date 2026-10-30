package viz

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"unicode"
)

// The t-….json file (SPEC.md §5.5) and the pure logic that fills it:
// emphasis (§5.1 step 6) and mood keyframes (§5.4).

type textFile struct {
	Version    int        `json:"version"`
	Source     string     `json:"source"`
	Language   string     `json:"language"`
	Matched    float64    `json:"matched"`
	MoodSource string     `json:"moodSource"`
	Lines      []textLine `json:"lines"`
	Mood       []moodKey  `json:"mood"`
	Warnings   []string   `json:"warnings"`
}

type textLine struct {
	StartMs int64      `json:"startMs"`
	EndMs   int64      `json:"endMs"`
	Text    string     `json:"text"`
	Words   []textWord `json:"words"`
	Meaning *meaning   `json:"meaning,omitempty"`
}

type textWord struct {
	StartMs  int64  `json:"startMs"`
	EndMs    int64  `json:"endMs"`
	Text     string `json:"text"`
	Emphasis bool   `json:"emphasis"`
}

type meaning struct {
	Valence    float64  `json:"valence"`
	Energy     float64  `json:"energy"`
	Emotion    string   `json:"emotion"`
	Confidence float64  `json:"confidence"`
	Motifs     []string `json:"motifs"`
}

type moodKey struct {
	Ms      int64   `json:"ms"`
	Valence float64 `json:"valence"`
	Energy  float64 `json:"energy"`
	Emotion string  `json:"emotion"`
}

// featureInfo is the part of s<0|1>.json the Go side reads.
type featureInfo struct {
	Version    int     `json:"version"`
	DurationMs int64   `json:"durationMs"`
	FPS        float64 `json:"fps"`
	Frames     int     `json:"frames"`
	Tempo      float64 `json:"tempo"`
	Downbeats  []int64 `json:"downbeats"`
	Key        struct {
		Name  string `json:"name"`
		Minor bool   `json:"minor"`
	} `json:"key"`
	Sections []struct {
		StartMs int64   `json:"startMs"`
		EndMs   int64   `json:"endMs"`
		Label   string  `json:"label"`
		Energy  float64 `json:"energy"`
	} `json:"sections"`
	Events struct {
		Held [][]float64 `json:"held"`
	} `json:"events"`
	Blocks []struct {
		ID     string `json:"id"`
		Kind   string `json:"kind"`
		Offset int64  `json:"offset"`
		Width  int    `json:"width"`
	} `json:"blocks"`
	Features string `json:"features"`
}

func readFeatureInfo(path string) (*featureInfo, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading the song features: %w", err)
	}
	var fi featureInfo
	if err := json.Unmarshal(b, &fi); err != nil {
		return nil, fmt.Errorf("decoding the song features: %w", err)
	}
	if fi.Version != 1 || fi.FPS <= 0 {
		return nil, fmt.Errorf("the song features have an unknown format")
	}
	return &fi, nil
}

// channel reads one scalar block from the .bin ("" id or a missing block gives nil).
func (fi *featureInfo) channel(bin, id string) []byte {
	for _, b := range fi.Blocks {
		if b.ID != id || b.Kind != "scalar" || fi.Frames <= 0 {
			continue
		}
		f, err := os.Open(bin)
		if err != nil {
			return nil
		}
		defer f.Close()
		buf := make([]byte, fi.Frames)
		if n, _ := f.ReadAt(buf, b.Offset); n != len(buf) {
			return nil
		}
		return buf
	}
	return nil
}

// ---- emphasis -------------------------------------------------------------

const (
	emphasisTopShare = 0.12
	emphasisMinMs    = 280
	emphasisFloor    = 0.35 // a word this quiet is never emphasised
)

// meanLevel is the mean of ch (0..1) over [startMs, endMs].
func meanLevel(ch []byte, fps float64, startMs, endMs int64) float64 {
	if len(ch) == 0 {
		return 0
	}
	a := int(float64(startMs) * fps / 1000)
	b := int(math.Ceil(float64(endMs) * fps / 1000)) // exclusive
	a = min(max(a, 0), len(ch)-1)
	b = min(max(b, a+1), len(ch))
	sum := 0
	for _, v := range ch[a:b] {
		sum += int(v)
	}
	return float64(sum) / float64(b-a) / 255
}

// applyEmphasis marks the loudest sustained words and the words that overlap a
// held note: a word is emphasised when its mean level is in the top 12% of the
// song's words and it lasts at least 280 ms.
func applyEmphasis(lines []textLine, ch []byte, fps float64, held [][]float64) {
	var means []float64
	for _, l := range lines {
		for _, w := range l.Words {
			means = append(means, meanLevel(ch, fps, w.StartMs, w.EndMs))
		}
	}
	thr := 2.0
	if len(means) > 0 && len(ch) > 0 {
		s := append([]float64(nil), means...)
		sort.Float64s(s)
		thr = max(s[min(int(float64(len(s))*(1-emphasisTopShare)), len(s)-1)], emphasisFloor)
	}
	i := 0
	for li := range lines {
		for wi := range lines[li].Words {
			w := &lines[li].Words[wi]
			m := means[i]
			i++
			if m >= thr && w.EndMs-w.StartMs >= emphasisMinMs {
				w.Emphasis = true
			}
			for _, h := range held {
				if len(h) >= 2 && float64(w.StartMs) < h[1] && float64(w.EndMs) > h[0] {
					w.Emphasis = true
				}
			}
		}
	}
}

// normWord folds a word for matching: lowercase, only letters, digits and marks.
func normWord(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0xFF01 && r <= 0xFF5E {
			r -= 0xFEE0
		}
		r = unicode.ToLower(r)
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// emphasiseWords marks the words of l that match one of the given words.
func emphasiseWords(l *textLine, words []string) {
	for _, e := range words {
		ne := normWord(e)
		if ne == "" {
			continue
		}
		for i := range l.Words {
			if normWord(l.Words[i].Text) == ne {
				l.Words[i].Emphasis = true
			}
		}
	}
}

// ---- mood -----------------------------------------------------------------

const (
	easeMs       = 4000
	readerWeight = 0.7 // a reading's share of the blended mood
	weakConf     = 0.2
)

// emotionFor is the no-reading lookup of §5.4.
func emotionFor(valence, energy float64) string {
	row := 1
	switch {
	case valence < -0.2:
		row = 0
	case valence > 0.2:
		row = 2
	}
	col := 1
	switch {
	case energy < 0.33:
		col = 0
	case energy > 0.66:
		col = 2
	}
	return [3][3]string{
		{"sadness", "fear", "anger"},
		{"calm", "awe", "anger"},
		{"calm", "hope", "joy"},
	}[row][col]
}

// musicMood is the mood of the music alone at a time.
type musicMood struct {
	info       *featureInfo
	brightness []byte
}

func newMusicMood(info *featureInfo, bin string) *musicMood {
	return &musicMood{info: info, brightness: info.channel(bin, "mix.brightness")}
}

func (m *musicMood) at(ms int64) (valence, energy float64) {
	mode := 1.0
	if m.info.Key.Minor {
		mode = -1
	}
	br := 0.5
	if len(m.brightness) > 0 {
		br = meanLevel(m.brightness, m.info.FPS, ms, ms)
	}
	valence = 0.5*mode*0.6 + 0.4*(br-0.5)
	energy = 0.5
	secs := m.info.Sections
	for i, s := range secs {
		if ms >= s.StartMs && (ms < s.EndMs || i == len(secs)-1) {
			energy = s.Energy
			break
		}
	}
	return min(max(valence, -1), 1), min(max(energy, 0), 1)
}

// barTimes are the bar starts from 0 (downbeats, or a fixed step without them).
func barTimes(info *featureInfo) []int64 {
	out := []int64{0}
	for _, d := range info.Downbeats {
		if d > out[len(out)-1] {
			out = append(out, d)
		}
	}
	if len(out) == 1 {
		step := int64(2000)
		if info.Tempo > 0 {
			step = max(int64(4*60000/info.Tempo), 500)
		}
		for t := step; t <= info.DurationMs; t += step {
			out = append(out, t)
		}
	}
	return out
}

// buildMood makes the mood keyframes: one per line start (blended with the
// music), easing to the music over 4 s between lines; bar keyframes from the
// music alone elsewhere, or throughout when no line has a reading.
func buildMood(info *featureInfo, mm *musicMood, lines []textLine) []moodKey {
	dur := info.DurationMs
	bars := barTimes(info)
	var keys []moodKey
	musicKey := func(ms int64) {
		v, e := mm.at(ms)
		keys = append(keys, moodKey{ms, v, e, emotionFor(v, e)})
	}
	musicRange := func(from, to int64) {
		for _, b := range bars {
			if b >= from && b < to {
				musicKey(b)
			}
		}
	}
	var read []textLine
	for _, l := range lines {
		if l.Meaning != nil {
			read = append(read, l)
		}
	}
	sort.SliceStable(read, func(i, j int) bool { return read[i].StartMs < read[j].StartMs })
	if len(read) == 0 {
		musicRange(0, dur+1)
		return finishKeys(keys)
	}
	prevEnd := int64(-1)
	for i, l := range read {
		if i == 0 {
			musicRange(0, l.StartMs)
		} else if ease := prevEnd + easeMs; ease < l.StartMs {
			musicKey(ease)
			musicRange(ease+1, l.StartMs)
		}
		mv, me := mm.at(l.StartMs)
		w := readerWeight
		if l.Meaning.Confidence < weakConf {
			w /= 2
		}
		v := w*l.Meaning.Valence + (1-w)*mv
		e := w*l.Meaning.Energy + (1-w)*me
		emo := l.Meaning.Emotion
		if l.Meaning.Confidence < weakConf || emo == "" {
			emo = emotionFor(v, e)
		}
		k := moodKey{l.StartMs, v, e, emo}
		keys = append(keys, k)
		if l.EndMs > l.StartMs && (i == len(read)-1 || l.EndMs < read[i+1].StartMs) {
			k.Ms = l.EndMs
			keys = append(keys, k)
		}
		prevEnd = max(l.EndMs, l.StartMs)
	}
	if ease := prevEnd + easeMs; ease <= dur {
		musicKey(ease)
		musicRange(ease+1, dur+1)
	}
	return finishKeys(keys)
}

// finishKeys sorts keyframes by time, keeping the last of equal times.
func finishKeys(keys []moodKey) []moodKey {
	sort.SliceStable(keys, func(i, j int) bool { return keys[i].Ms < keys[j].Ms })
	out := make([]moodKey, 0, len(keys))
	for _, k := range keys {
		if k.Ms < 0 {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Ms == k.Ms {
			out[n-1] = k
			continue
		}
		out = append(out, k)
	}
	return out
}
