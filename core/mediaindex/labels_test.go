package mediaindex

import (
	"strings"
	"testing"
)

const testVocab = `# comment
# id	category	display	prompts	parent	threshold

food	food	food	a photo of food
fruit	food	fruit	a photo of fruit|{}	food
apple	food	apple	a photo of an apple|an {}	fruit
pie	food	pie	a pie		0.5
dog	animals	dog	a photo of a dog
`

func TestParseVocabulary(t *testing.T) {
	es, err := ParseVocabulary([]byte(testVocab))
	if err != nil {
		t.Fatal(err)
	}
	if len(es) != 5 {
		t.Fatalf("entries: %d", len(es))
	}
	apple := es[2]
	if apple.Parent != "fruit" || len(apple.Prompts) != 2 || apple.Prompts[1] != "an apple" {
		t.Errorf("apple: %+v", apple)
	}
	if es[3].Threshold != 0.5 || es[0].Threshold != 0 {
		t.Errorf("thresholds: %+v %+v", es[3], es[0])
	}
	// no prompts → a default prompt
	es, _ = ParseVocabulary([]byte("x\tthings\tmug\t\t\t\n"))
	if len(es) != 1 || es[0].Prompts[0] != "a photo of mug" {
		t.Errorf("default prompt: %+v", es)
	}
	for _, bad := range []string{"a\tfood\n", "\tfood\tx\ty\n", "a\tfood\tx\ty\t\t\na\tfood\tx\ty\t\t\n", "a\tfood\tx\ty\t\t2\n", "a\tfood\tx\ty\t\tabc\n"} {
		if _, err := ParseVocabulary([]byte(bad)); err == nil {
			t.Errorf("%q should fail", bad)
		}
	}
}

// axes: a toy model whose prompts and pictures are unit vectors on 4 axes.
func axisVec(i int) []float32 {
	v := make([]float32, 4)
	v[i] = 1
	return v
}

func toySet(t *testing.T) *LabelSet {
	t.Helper()
	es, _ := ParseVocabulary([]byte(testVocab))
	m := Model{ID: "toy", Dim: 4, Scale: 20, Bias: -10}
	axes := map[string]int{"a photo of food": 3, "a photo of fruit": 0, "fruit": 0, "a photo of an apple": 1, "an apple": 1, "a pie": 2, "a photo of a dog": 3}
	axes["a screenshot"] = 2
	return BuildLabelSet(m, es, func(text string) ([]float32, bool) {
		if i, ok := axes[text]; ok {
			return axisVec(i), true
		}
		return nil, false
	})
}

func TestScoreLabelsParentsThresholdsAndMax(t *testing.T) {
	set := toySet(t)
	rows := set.Score([]VectorAt{{Pos: -1, Vec: axisVec(1)}}) // looks like an apple
	got := map[string]LabelRow{}
	for _, r := range rows {
		got[r.Label] = r
		if r.Source != "auto" {
			t.Errorf("source %q", r.Source)
		}
	}
	if _, ok := got["apple"]; !ok {
		t.Fatalf("apple missing: %v", rows)
	}
	if _, ok := got["fruit"]; !ok {
		t.Fatalf("parent fruit missing: %v", rows)
	}
	if _, ok := got["food"]; !ok {
		t.Fatalf("grandparent food missing: %v", rows)
	}
	if _, ok := got["dog"]; ok {
		t.Errorf("dog should be below its threshold: %v", rows)
	}
	if got["fruit"].Score != got["apple"].Score {
		t.Errorf("a parent takes its child's score: %v", rows)
	}
	// a video: max over frames, remembering where
	rows = set.Score([]VectorAt{{Pos: 0, Vec: axisVec(2)}, {Pos: 4000, Vec: axisVec(3)}, {Pos: 8000, Vec: axisVec(1)}})
	pos := map[string]int64{}
	for _, r := range rows {
		pos[r.Label] = r.Pos
	}
	if pos["apple"] != 8000 || pos["dog"] != 4000 {
		t.Errorf("positions: %v", pos)
	}
	// the pie threshold (0.5) is its own: cos 0 on axis 2? pie is on axis 2
	if _, ok := pos["pie"]; !ok {
		t.Errorf("pie at frame 0 expected: %v", pos)
	}
	if rows := set.Score(nil); len(rows) != 0 {
		t.Errorf("no vectors, no labels: %v", rows)
	}
}

func TestScoreLabelsCapAndOrder(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 20; i++ {
		b.WriteString("l")
		b.WriteString(string(rune('a' + i)))
		b.WriteString("\tthings\tL\tp\t\t\n")
	}
	es, err := ParseVocabulary([]byte(b.String()))
	if err != nil {
		t.Fatal(err)
	}
	m := Model{ID: "toy", Dim: 4, Scale: 20, Bias: -10}
	set := BuildLabelSet(m, es, func(string) ([]float32, bool) { return axisVec(0), true })
	rows := set.Score([]VectorAt{{Pos: -1, Vec: axisVec(0)}})
	if len(rows) != MaxLabels {
		t.Fatalf("kept %d labels, want %d", len(rows), MaxLabels)
	}
}

func TestTextGate(t *testing.T) {
	set := toySet(t)
	if p := set.GateP(axisVec(2)); p < TextGateP {
		t.Errorf("a screenshot-like picture must pass the gate: %g", p)
	}
	if p := set.GateP(axisVec(0)); p >= TextGateP {
		t.Errorf("a plain picture must not pass: %g", p)
	}
	ix := New(Config{})
	if !ix.NeedsOCR(axisVec(0)) {
		t.Error("without label vectors NeedsOCR answers true")
	}
	ix.labels.put(set.ls)
	if ix.NeedsOCR(axisVec(0)) || !ix.NeedsOCR(axisVec(2)) {
		t.Error("NeedsOCR follows the gate")
	}
}

func TestNormalizeUserLabel(t *testing.T) {
	ix := New(Config{Vocabulary: []byte(testVocab)})
	cases := map[string]string{"  Lunch  ": "lunch", "Max  the DOG": "max the dog", "Apple": "apple", "FRUIT": "fruit"}
	for in, want := range cases {
		if got, err := ix.normalizeUserLabel(in); err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
	if _, err := ix.normalizeUserLabel("   "); err == nil {
		t.Error("empty label")
	}
	if _, err := ix.normalizeUserLabel(strings.Repeat("x", 41)); err == nil {
		t.Error("41 characters is too long")
	}
	if _, err := ix.normalizeUserLabel(strings.Repeat("é", 40)); err != nil {
		t.Errorf("40 characters (runes) are fine: %v", err)
	}
}
