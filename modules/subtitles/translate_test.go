package subtitles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"toolbox/core"
)

// fakeTG answers with a scripted function and records requests.
type fakeTG struct {
	reqs     []core.CompletionRequest
	reply    func(n int, req core.CompletionRequest) (string, error)
	readyErr error
}

func (f *fakeTG) Ready() (string, error) { return "fake-model", f.readyErr }
func (f *fakeTG) Complete(ctx context.Context, req core.CompletionRequest) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	f.reqs = append(f.reqs, req)
	return f.reply(len(f.reqs), req)
}

// echoUpper replies with an upper-cased array for array prompts and a string for single ones.
func echoUpper(_ int, req core.CompletionRequest) (string, error) {
	var items []string
	prompt := req.Prompt
	if i := strings.LastIndex(prompt, "\n"); i >= 0 {
		prompt = prompt[i+1:]
	}
	if err := json.Unmarshal([]byte(prompt), &items); err != nil {
		var s string
		if err := json.Unmarshal([]byte(prompt), &s); err != nil {
			return "", fmt.Errorf("unexpected prompt %q", req.Prompt)
		}
		b, _ := json.Marshal(strings.ToUpper(s))
		return string(b), nil
	}
	for i := range items {
		items[i] = strings.ToUpper(items[i])
	}
	b, _ := json.Marshal(items)
	return string(b), nil
}

func makeCues(n int, text string) []Cue {
	cues := make([]Cue, n)
	for i := range cues {
		cues[i] = Cue{StartMs: int64(i) * 2000, EndMs: int64(i)*2000 + 1500, Text: fmt.Sprintf("%s %d", text, i)}
	}
	return cues
}

func TestBatches(t *testing.T) {
	if got := batches(makeCues(95, "x")); len(got) != 3 || got[0] != [2]int{0, 40} || got[2] != [2]int{80, 95} {
		t.Errorf("by count: %v", got)
	}
	long := make([]Cue, 8)
	for i := range long {
		long[i] = Cue{StartMs: int64(i) * 1000, EndMs: int64(i)*1000 + 500, Text: strings.Repeat("a", 400)}
	}
	got := batches(long)
	if len(got) != 2 || got[0] != [2]int{0, 6} {
		t.Errorf("by chars: %v", got)
	}
	for _, b := range got {
		n := 0
		for _, c := range long[b[0]:b[1]] {
			n += runeLen(c.Text)
		}
		if n > batchMaxChars {
			t.Errorf("batch %v has %d chars", b, n)
		}
	}
	if len(batches(nil)) != 0 {
		t.Error("expected no batches")
	}
}

func TestTranslateKeepsTimingsAndSchema(t *testing.T) {
	tg := &fakeTG{reply: echoUpper}
	cues := makeCues(45, "hello")
	var done []int
	out, err := translateCues(context.Background(), tg, cues, "en", "es", 42, func(n int) { done = append(done, n) })
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != len(cues) {
		t.Fatalf("got %d cues", len(out))
	}
	for i, c := range out {
		if c.StartMs != cues[i].StartMs || c.EndMs != cues[i].EndMs {
			t.Errorf("cue %d timing changed", i)
		}
		if c.Text != strings.ToUpper(cues[i].Text) {
			t.Errorf("cue %d text %q", i, c.Text)
		}
	}
	if len(tg.reqs) != 2 || len(done) != 2 || done[1] != 45 {
		t.Fatalf("requests %d, progress %v", len(tg.reqs), done)
	}
	r := tg.reqs[0]
	if r.Temperature != 0.2 || r.Purpose != "Translating subtitles" {
		t.Errorf("request %+v", r)
	}
	if string(r.JSONSchema) != `{"type":"array","items":{"type":"string"},"minItems":40,"maxItems":40}` {
		t.Errorf("schema %s", r.JSONSchema)
	}
	if !strings.Contains(r.System, "from English to Spanish") {
		t.Errorf("system %q", r.System)
	}
	if !strings.Contains(tg.reqs[1].Prompt, "HELLO 39") || !strings.Contains(tg.reqs[1].Prompt, "HELLO 37") {
		t.Errorf("second batch lacks context: %q", tg.reqs[1].Prompt)
	}
	if strings.Contains(tg.reqs[1].Prompt, "HELLO 36") {
		t.Error("context should be the last 3 lines only")
	}
	if !strings.Contains(systemPrompt("", "fr"), "from the original language to French") {
		t.Error("unknown source wording")
	}
}

func TestTranslateRetryOnBadReply(t *testing.T) {
	tg := &fakeTG{reply: func(n int, req core.CompletionRequest) (string, error) {
		if n == 1 {
			return `["only one"]`, nil // wrong count
		}
		return echoUpper(n, req)
	}}
	out, err := translateCues(context.Background(), tg, makeCues(3, "a"), "", "de", 42, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tg.reqs) != 2 || out[2].Text != "A 2" {
		t.Errorf("reqs %d, out %+v", len(tg.reqs), out)
	}
}

func TestTranslatePerCueFallback(t *testing.T) {
	tg := &fakeTG{reply: func(n int, req core.CompletionRequest) (string, error) {
		if strings.HasPrefix(string(req.JSONSchema), `{"type":"array"`) {
			return "not json at all", nil
		}
		return echoUpper(n, req)
	}}
	out, err := translateCues(context.Background(), tg, makeCues(3, "b"), "", "de", 42, nil)
	if err != nil {
		t.Fatal(err)
	}
	// 2 failed batch attempts + 3 single requests.
	if len(tg.reqs) != 5 {
		t.Fatalf("requests = %d", len(tg.reqs))
	}
	for i, c := range out {
		if c.Text != fmt.Sprintf("B %d", i) {
			t.Errorf("cue %d = %q", i, c.Text)
		}
	}
	if string(tg.reqs[2].JSONSchema) != `{"type":"string"}` {
		t.Errorf("single schema %s", tg.reqs[2].JSONSchema)
	}
}

func TestTranslateRewrapsAndFenced(t *testing.T) {
	long := "this translated line is far too long to sit on a single subtitle line"
	tg := &fakeTG{reply: func(n int, req core.CompletionRequest) (string, error) {
		return "```json\n[\"" + long + "\"]\n```", nil
	}}
	out, err := translateCues(context.Background(), tg, makeCues(1, "x"), "", "de", 42, nil)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(out[0].Text, "\n")
	if len(lines) != 2 {
		t.Fatalf("text %q", out[0].Text)
	}
	for _, l := range lines {
		if runeLen(l) > 42 {
			t.Errorf("line too long: %q", l)
		}
	}
}

func TestTranslateCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tg := &fakeTG{reply: func(n int, req core.CompletionRequest) (string, error) {
		cancel() // after the first batch
		return echoUpper(n, req)
	}}
	_, err := translateCues(ctx, tg, makeCues(100, "c"), "", "de", 42, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if len(tg.reqs) != 1 {
		t.Errorf("requests after cancel: %d", len(tg.reqs))
	}
}

func TestTranslateEmptyReplyKeepsOriginal(t *testing.T) {
	tg := &fakeTG{reply: func(int, core.CompletionRequest) (string, error) { return `["  "]`, nil }}
	out, err := translateCues(context.Background(), tg, makeCues(1, "keep"), "", "de", 42, nil)
	if err != nil || out[0].Text != "keep 0" {
		t.Errorf("out %+v err %v", out, err)
	}
}
