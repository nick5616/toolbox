package viz

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
)

func linesOf(n int) []textLine {
	out := make([]textLine, n)
	for i := range out {
		out[i] = textLine{StartMs: int64(i) * 1000, EndMs: int64(i)*1000 + 800, Text: fmt.Sprintf("line number %d", i)}
	}
	return out
}

func TestDeepReadBatching(t *testing.T) {
	chat := &fakeChat{reply: func(req core.CompletionRequest, _ int) (string, error) {
		return chatJSON(schemaCount(req), 0.1, 0.2, "calm", nil, nil), nil
	}}
	a := NewAnalyzer("", "", nil, chat)
	lines := linesOf(65)
	lines[3].Text = "♪" // no letters: never sent
	rs, err := a.deepRead(context.Background(), newJob(t, &jobRec{}), lines)
	if err != nil {
		t.Fatal(err)
	}
	if len(chat.reqs) != 3 {
		t.Fatalf("%d requests, want 3 (30+30+4)", len(chat.reqs))
	}
	if n := schemaCount(chat.reqs[0]); n != 30 {
		t.Errorf("first batch %d lines", n)
	}
	if strings.Contains(chat.reqs[0].Prompt, "Previous lines") {
		t.Error("the first batch has no context")
	}
	// The second batch carries the last 3 lines of the first as context.
	p := chat.reqs[1].Prompt
	// (Line 3 has no letters, so the first batch ends at line 30.)
	if !strings.Contains(p, "- line number 28\n- line number 29\n- line number 30\n") || strings.Contains(p, "- line number 27\n") {
		t.Errorf("context wrong: %s", p)
	}
	for _, r := range chat.reqs {
		if r.Temperature != 0.2 || r.Purpose != "Reading the mood of the words" || r.System != deepSystem || len(r.JSONSchema) == 0 {
			t.Errorf("request = %+v", r)
		}
	}
	if rs[3].ok || !rs[0].ok || !rs[64].ok {
		t.Errorf("ok flags wrong: %v %v %v", rs[3].ok, rs[0].ok, rs[64].ok)
	}
}

func TestDeepReadCharBatches(t *testing.T) {
	chat := &fakeChat{reply: func(req core.CompletionRequest, _ int) (string, error) {
		return chatJSON(schemaCount(req), 0, 0.5, "calm", nil, nil), nil
	}}
	a := NewAnalyzer("", "", nil, chat)
	lines := linesOf(10)
	for i := range lines {
		lines[i].Text = strings.Repeat("a", 900)
	}
	if _, err := a.deepRead(context.Background(), newJob(t, &jobRec{}), lines); err != nil {
		t.Fatal(err)
	}
	var sizes []int
	for _, r := range chat.reqs {
		sizes = append(sizes, schemaCount(r))
	}
	if !reflect.DeepEqual(sizes, []int{2, 2, 2, 2, 2}) {
		t.Errorf("batch sizes = %v", sizes)
	}
}

func TestDeepReadRecovery(t *testing.T) {
	good := func(n int) string { return chatJSON(n, 0.3, 0.4, "love", []string{"hearts"}, nil) }
	tests := []struct {
		name     string
		reply    func(req core.CompletionRequest, call int) (string, error)
		wantReqs int
		wantOK   []bool
	}{
		{"retry once then fine", func(r core.CompletionRequest, call int) (string, error) {
			if call == 1 {
				return "not json", nil
			}
			return good(schemaCount(r)), nil
		}, 2, []bool{true, true, true}},
		{"wrong count twice, then line by line", func(r core.CompletionRequest, call int) (string, error) {
			if schemaCount(r) == 3 {
				return good(2), nil
			}
			return good(1), nil
		}, 5, []bool{true, true, true}},
		{"a line that still fails is neutral", func(r core.CompletionRequest, call int) (string, error) {
			if schemaCount(r) == 3 {
				return "[]", nil
			}
			if strings.Contains(r.Prompt, "line number 1") {
				return `[{"valence":9,"energy":0.5,"emotion":"joy","motifs":[],"emphasis":[]}]`, nil
			}
			return good(1), nil
		}, 5, []bool{true, false, true}},
		{"bad enum", func(r core.CompletionRequest, call int) (string, error) {
			return `[{"valence":0,"energy":0.5,"emotion":"rage","motifs":[],"emphasis":[]}]`, nil
		}, 5, []bool{false, false, false}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			chat := &fakeChat{reply: tc.reply}
			a := NewAnalyzer("", "", nil, chat)
			rs, err := a.deepRead(context.Background(), newJob(t, &jobRec{}), linesOf(3))
			if err != nil {
				t.Fatal(err)
			}
			if len(chat.reqs) != tc.wantReqs {
				t.Errorf("%d requests, want %d", len(chat.reqs), tc.wantReqs)
			}
			var ok []bool
			for _, r := range rs {
				ok = append(ok, r.ok)
				if !r.ok && (r.m.Emotion != "calm" || r.m.Energy != 0.5 || r.m.Valence != 0 || len(r.m.Motifs) != 0) {
					t.Errorf("neutral reading = %+v", r.m)
				}
			}
			if !reflect.DeepEqual(ok, tc.wantOK) {
				t.Errorf("ok = %v, want %v", ok, tc.wantOK)
			}
		})
	}
}

func TestDeepReadCallFailureAndCancel(t *testing.T) {
	chat := &fakeChat{reply: func(core.CompletionRequest, int) (string, error) { return "", errors.New("server down") }}
	a := NewAnalyzer("", "", nil, chat)
	if _, err := a.deepRead(context.Background(), newJob(t, &jobRec{}), linesOf(5)); err == nil {
		t.Fatal("expected an error")
	}
	if len(chat.reqs) != 1 {
		t.Errorf("kept calling a dead model: %d requests", len(chat.reqs))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.deepRead(ctx, newJob(t, &jobRec{}), linesOf(2)); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v", err)
	}
}

func TestParseDeepFence(t *testing.T) {
	rs, err := parseDeep("```json\n"+chatJSON(2, 1, 1, "joy", []string{"sun", "sun", "city"}, []string{"a"})+"\n```", 2)
	if err != nil || len(rs) != 2 || !reflect.DeepEqual(rs[0].m.Motifs, []string{"sun", "city"}) {
		t.Fatalf("rs=%+v err=%v", rs, err)
	}
	for _, bad := range []string{
		chatJSON(2, 1, 1, "joy", []string{"unknownmotif"}, nil),
		chatJSON(2, 1, 1, "joy", []string{"sun", "city", "fire", "rain"}, nil),
		chatJSON(2, 1, 1, "joy", nil, []string{"a", "b", "c"}),
		chatJSON(2, 1.5, 1, "joy", nil, nil),
		chatJSON(2, 1, -1, "joy", nil, nil),
		`[{"energy":1,"emotion":"joy"}]`,
	} {
		if _, err := parseDeep(bad, 2); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

func TestMergeReading(t *testing.T) {
	reader := func(conf float64) *meaning {
		return &meaning{Valence: 0.8, Energy: 0.4, Emotion: "joy", Confidence: conf, Motifs: []string{"fire", "sun"}}
	}
	chat := chatReading{ok: true, m: meaning{Valence: -0.4, Energy: 0.8, Emotion: "sadness", Confidence: chatConfidence, Motifs: []string{"rain", "fire", "night"}}}
	tests := []struct {
		name   string
		reader *meaning
		chat   chatReading
		want   meaning
	}{
		{"weak reader is replaced", reader(0.3), chat,
			meaning{Valence: -0.4, Energy: 0.8, Emotion: "sadness", Confidence: chatConfidence, Motifs: []string{"fire", "sun", "rain"}}},
		{"just under 0.5 is replaced", reader(0.49), chat,
			meaning{Valence: -0.4, Energy: 0.8, Emotion: "sadness", Confidence: chatConfidence, Motifs: []string{"fire", "sun", "rain"}}},
		{"confident reader is averaged", reader(0.5), chat,
			meaning{Valence: 0.2, Energy: 0.6, Emotion: "joy", Confidence: 0.5, Motifs: []string{"fire", "sun", "rain"}}},
		{"no reader uses the chat", nil, chat, chat.m},
		{"failed chat keeps the reader", reader(0.1), chatReading{m: neutralMeaning()}, *reader(0.1)},
		{"nothing at all is neutral", nil, chatReading{}, neutralMeaning()},
	}
	for _, tc := range tests {
		got := mergeReading(tc.reader, tc.chat)
		if got.Emotion != tc.want.Emotion || !near(got.Valence, tc.want.Valence) || !near(got.Energy, tc.want.Energy) ||
			!near(got.Confidence, tc.want.Confidence) || !reflect.DeepEqual(got.Motifs, tc.want.Motifs) {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func near(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }

func TestEmphasiseWords(t *testing.T) {
	l := textLine{Words: []textWord{{Text: "Don't"}, {Text: "STOP,"}, {Text: "believin'"}, {Text: "Ｓtop"}}}
	emphasiseWords(&l, []string{"stop", "nothere", "", "dont"})
	var got []bool
	for _, w := range l.Words {
		got = append(got, w.Emphasis)
	}
	if !reflect.DeepEqual(got, []bool{true, true, false, true}) {
		t.Errorf("emphasis = %v", got)
	}
}
