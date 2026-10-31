package pipelines

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func chatOpts(c ChatJob) Options { return Options{Action: ActionChat, Pipeline: "Podcast", Chat: &c} }

func TestChatWrite(t *testing.T) {
	tg := &fakeTG{reply: func(req core.CompletionRequest, n int) (string, error) { return "  ## Summary\n\nGreat.  ", nil }}
	h := newHarness(t, tg)
	rec, err := h.run(chatOpts(ChatJob{
		Mode: ChatWrite, System: "Be brief about {item}", Prompt: "Notes for {item}: {transcript}",
		Vars: map[string]string{"item": "Ep 1", "transcript": "hello"}, OutputName: "Ep 1 (show notes)", Format: FormatMD,
		Temperature: 0.3, Label: "Podcast",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(tg.reqs) != 1 {
		t.Fatalf("%d requests", len(tg.reqs))
	}
	r := tg.reqs[0]
	if r.Prompt != "Notes for Ep 1: hello" || r.System != "Be brief about Ep 1" || r.MaxTokens != 2048 ||
		r.Temperature != 0.3 || r.Purpose != "Pipeline · Podcast" || r.JSONSchema != nil {
		t.Fatalf("request = %+v", r)
	}
	f := rec.files(t)[0]
	if f.Role != "text" || filepath.Base(f.Path) != "Ep 1 (show notes).md" || f.OutputID == "" {
		t.Fatalf("file = %+v", f)
	}
	if got := readFile(t, f.Path); got != "## Summary\n\nGreat.\n" {
		t.Fatalf("content = %q", got)
	}
	if v := rec.vars(t); v["reply"] != "" {
		t.Fatal("the reply must not be stored in the result")
	}

	// StepOutputs reads the reply back from the file
	s := &step{m: h.m, action: ActionChat}
	res, err := s.StepOutputs(core.Job{ResultJSON: string(rec.result)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Vars["reply"] != "## Summary\n\nGreat." || len(res.Files) != 1 {
		t.Fatalf("outputs = %+v", res)
	}
}

func TestChatNotReadyFailsFast(t *testing.T) {
	want := core.Errorf(core.CodeDependencyMissing, "Download a model in Local Chat first")
	tg := &fakeTG{ready: want, reply: func(core.CompletionRequest, int) (string, error) { return "x", nil }}
	h := newHarness(t, tg)
	_, err := h.run(chatOpts(ChatJob{Mode: ChatWrite, Prompt: "hi", OutputName: "n", Format: FormatTXT}))
	if !errors.Is(err, want) {
		t.Fatalf("err = %v", err)
	}
	if len(tg.reqs) != 0 {
		t.Fatal("no request may be made")
	}
}

var receiptFields = []ChatField{
	{Name: "when", Label: "Purchase date", Type: "date"},
	{Name: "merchant", Label: "Merchant", Type: "text"},
	{Name: "total", Label: "Total", Type: "number"},
}

func extractJob() ChatJob {
	return ChatJob{Mode: ChatExtract, Prompt: "Read: {text}", Vars: map[string]string{"text": "Cafe 4.50"}, Fields: receiptFields,
		OutputName: "receipt-1", Temperature: 0.4, SaveJSON: true}
}

func TestChatExtract(t *testing.T) {
	tg := &fakeTG{reply: func(core.CompletionRequest, int) (string, error) {
		return "```json\n{\"when\":\"2026-01-02\",\"merchant\":\" Cafe \",\"total\":4.5}\n```", nil
	}}
	h := newHarness(t, tg)
	rec, err := h.run(chatOpts(extractJob()))
	if err != nil {
		t.Fatal(err)
	}
	r := tg.reqs[0]
	if r.MaxTokens != 512 || r.Temperature != 0.4 {
		t.Fatalf("request = %+v", r)
	}
	var schema struct {
		Type       string                       `json:"type"`
		Properties map[string]map[string]string `json:"properties"`
		Required   []string                     `json:"required"`
	}
	if err := json.Unmarshal(r.JSONSchema, &schema); err != nil {
		t.Fatal(err)
	}
	if schema.Type != "object" || len(schema.Properties) != 3 || strings.Join(schema.Required, ",") != "when,merchant,total" ||
		schema.Properties["total"]["type"] != "string" || !strings.Contains(schema.Properties["total"]["description"], "number") {
		t.Fatalf("schema = %s", r.JSONSchema)
	}
	vars := rec.vars(t)
	if vars["when"] != "2026-01-02" || vars["merchant"] != "Cafe" || vars["total"] != "4.5" {
		t.Fatalf("vars = %v", vars)
	}
	f := rec.files(t)
	if len(f) != 1 || f[0].Role != "json" || filepath.Base(f[0].Path) != "receipt-1.json" {
		t.Fatalf("files = %+v", f)
	}
	var round map[string]string
	if err := json.Unmarshal([]byte(readFile(t, f[0].Path)), &round); err != nil || round["merchant"] != "Cafe" {
		t.Fatalf("json file = %v %v", round, err)
	}
	if !strings.HasPrefix(readFile(t, f[0].Path), "{\n  \"when\"") {
		t.Fatal("JSON fields are not in field order")
	}
}

func TestChatExtractRetriesOnceAtZero(t *testing.T) {
	tg := &fakeTG{reply: func(_ core.CompletionRequest, n int) (string, error) {
		if n == 1 {
			return "I think the merchant is Cafe", nil
		}
		return `{"when":"","merchant":"Cafe","total":"4.50"}`, nil
	}}
	h := newHarness(t, tg)
	j := extractJob()
	j.SaveJSON = false
	rec, err := h.run(chatOpts(j))
	if err != nil {
		t.Fatal(err)
	}
	if len(tg.reqs) != 2 || tg.reqs[0].Temperature != 0.4 || tg.reqs[1].Temperature != 0 {
		t.Fatalf("requests = %+v", tg.reqs)
	}
	if rec.vars(t)["total"] != "4.50" || len(rec.files(t)) != 0 {
		t.Fatalf("vars = %v files = %v", rec.vars(t), rec.files(t))
	}
}

func TestChatExtractUnusableAfterRetry(t *testing.T) {
	tg := &fakeTG{reply: func(core.CompletionRequest, int) (string, error) { return `{"when":"x"}`, nil }}
	h := newHarness(t, tg)
	_, err := h.run(chatOpts(extractJob()))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Message != "The chat model's answer wasn't usable" {
		t.Fatalf("err = %v", err)
	}
	if len(tg.reqs) != 2 {
		t.Fatalf("%d requests, want exactly one retry", len(tg.reqs))
	}
}

func TestChatLongTextIsChunked(t *testing.T) {
	var paras []string
	for i := 0; i < 40; i++ {
		paras = append(paras, "[0:00:0"+string(rune('0'+i%10))+"] "+strings.Repeat("word ", 30))
	}
	transcript := strings.Join(paras, "\n\n") // ~6.6k chars
	tg := &fakeTG{ctxTokens: 1600, reply: func(req core.CompletionRequest, n int) (string, error) {
		if strings.HasPrefix(req.Prompt, mapPrompt) {
			return "NOTES", nil
		}
		return "final", nil
	}}
	h := newHarness(t, tg)
	rec, err := h.run(chatOpts(ChatJob{
		Mode: ChatWrite, Prompt: "Summarise:\n\n{transcript_timed}", Vars: map[string]string{"transcript_timed": transcript},
		OutputName: "n", Format: FormatMD, Temperature: 0.3,
	}))
	if err != nil {
		t.Fatal(err)
	}
	budget := promptBudget(1600)
	var maps int
	for _, r := range tg.reqs {
		if strings.HasPrefix(r.Prompt, mapPrompt) {
			maps++
			if len(r.Prompt) > len(mapPrompt)+2+budget/2 {
				t.Errorf("chunk of %d bytes exceeds half the budget (%d)", len(r.Prompt), budget/2)
			}
		}
	}
	if maps < 2 {
		t.Fatalf("only %d map requests", maps)
	}
	last := tg.reqs[len(tg.reqs)-1]
	if strings.HasPrefix(last.Prompt, mapPrompt) || !strings.HasPrefix(last.Prompt, "Summarise:\n\nNOTES") || strings.Contains(last.Prompt, "word word") {
		t.Fatalf("final prompt = %q", last.Prompt)
	}
	if !contains(rec.logs, "Long text: read in") {
		t.Fatalf("logs = %v", rec.logs)
	}
	if last.MaxTokens != 2048 {
		t.Fatalf("final MaxTokens = %d", last.MaxTokens)
	}
}

func TestChatShortTextIsNotChunked(t *testing.T) {
	tg := &fakeTG{reply: func(core.CompletionRequest, int) (string, error) { return "ok", nil }}
	h := newHarness(t, tg)
	if _, err := h.run(chatOpts(ChatJob{Mode: ChatWrite, Prompt: "{file}", Vars: map[string]string{"file": strings.Repeat("a ", 500)}, OutputName: "n", Format: FormatTXT})); err != nil {
		t.Fatal(err)
	}
	if len(tg.reqs) != 1 {
		t.Fatalf("%d requests", len(tg.reqs))
	}
}

func TestSplitChunks(t *testing.T) {
	cases := []struct {
		name string
		text string
		size int
		want []string
	}{
		{"paragraphs", "aaa\n\nbbb\n\nccc", 8, []string{"aaa\n\nbbb", "ccc"}},
		{"lines", "aaaa\nbbbb\ncccc", 9, []string{"aaaa\nbbbb", "cccc"}},
		{"hard split", "abcdefghij", 4, []string{"abcd", "efgh", "ij"}},
		{"runes", "ééééé", 4, []string{"éé", "éé", "é"}},
		{"fits", "short", 100, []string{"short"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := splitChunks(c.text, c.size)
			if strings.Join(got, "|") != strings.Join(c.want, "|") {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
}

func TestCueText(t *testing.T) {
	srt := "1\n00:00:01,000 --> 00:00:02,000\nHello <i>there</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n"
	if got := cueText(srt); got != "Hello there\nBye" {
		t.Fatalf("srt = %q", got)
	}
	vtt := "WEBVTT\n\nNOTE a note\nstill note\n\n00:01.000 --> 00:02.000\nOne\n\ncue2\n00:03.000 --> 00:04.000 align:start\nTwo\n"
	if got := cueText(vtt); got != "One\nTwo" {
		t.Fatalf("vtt = %q", got)
	}
}

func TestPromptBudget(t *testing.T) {
	// 8192 × 0.7 − 1024 = 4710.4 tokens × 3.5
	if got := promptBudget(8192); got != 16486 {
		t.Fatalf("budget = %d", got)
	}
	if promptBudget(0) <= 0 || promptBudget(100) <= 0 {
		t.Fatal("budget must stay positive")
	}
}
