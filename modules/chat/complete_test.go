package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

func slotHolder(h *harness) *generation {
	h.c.mu.Lock()
	defer h.c.mu.Unlock()
	return h.c.gen
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestReadyAndModelChoice(t *testing.T) {
	h := newHarness(t, "ok")
	os.Remove(h.models + "/llm/fake.gguf")
	_, err := h.c.Ready()
	if !core.IsCode(err, core.CodeDependencyMissing) || !strings.Contains(err.Error(), "Download a model in Local Chat first") {
		t.Fatalf("nothing downloaded: %v", err)
	}
	if _, err := h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "x"}); !core.IsCode(err, core.CodeDependencyMissing) {
		t.Fatalf("complete: %v", err)
	}
	os.WriteFile(h.models+"/llm/fake.gguf", []byte(fakeModelBody), 0o644)
	// Default model not downloaded: the first downloaded one.
	if m, err := h.c.Ready(); err != nil || m != "fake" {
		t.Fatalf("first downloaded: %q %v", m, err)
	}
	// Default model downloaded: it wins over catalog order.
	second := catalogEntry{ID: "second", Label: "Second", File: "second.gguf", Bytes: 3}
	h.c.entries = func() []catalogEntry { return []catalogEntry{h.entry, second} }
	os.WriteFile(h.models+"/llm/second.gguf", []byte("abc"), 0o644)
	cs := core.DefaultChatSettings()
	cs.DefaultModel = "second"
	if _, err := h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs}); err != nil {
		t.Fatal(err)
	}
	if m, _ := h.c.Ready(); m != "second" {
		t.Fatalf("default: %q", m)
	}
	// Ollama default only while Ollama is configured.
	cs.DefaultModel = "ollama:phi3"
	h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs})
	if m, _ := h.c.Ready(); m != "fake" {
		t.Fatalf("ollama off: %q", m)
	}
	cs.OllamaURL = "http://127.0.0.1:11434"
	h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs})
	if m, _ := h.c.Ready(); m != "ollama:phi3" {
		t.Fatalf("ollama on: %q", m)
	}
}

func TestCompleteSendsRequestAndReleasesSlot(t *testing.T) {
	h := newHarness(t, "ok")
	rec := filepath.Join(t.TempDir(), "rec")
	h.setEnv("FAKE_RECORD", rec)
	schema := json.RawMessage(`{"type":"object","properties":{"a":{"type":"string"}}}`)
	out, err := h.c.Complete(context.Background(), core.CompletionRequest{
		System: "sys", Prompt: "hello", JSONSchema: schema, Temperature: 0, Purpose: "Testing",
	})
	if err != nil || out != "echo: hello " {
		t.Fatalf("out = %q, %v", out, err)
	}
	if slotHolder(h) != nil {
		t.Fatal("slot not released")
	}
	b, _ := os.ReadFile(rec)
	var req struct {
		Messages       []wireMsg `json:"messages"`
		MaxTokens      int       `json:"max_tokens"`
		Temperature    float64   `json:"temperature"`
		ResponseFormat struct {
			Type       string `json:"type"`
			JSONSchema struct {
				Name   string          `json:"name"`
				Schema json.RawMessage `json:"schema"`
				Strict bool            `json:"strict"`
			} `json:"json_schema"`
		} `json:"response_format"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(b))), &req); err != nil {
		t.Fatal(err)
	}
	rf := req.ResponseFormat
	if req.MaxTokens != 2048 || req.Temperature != 0 || len(req.Messages) != 2 || req.Messages[0].Role != "system" ||
		rf.Type != "json_schema" || rf.JSONSchema.Name != "reply" || !rf.JSONSchema.Strict || string(rf.JSONSchema.Schema) != string(schema) {
		t.Fatalf("request = %s", b)
	}
	// Nothing stored, and no schema → no response_format.
	if page, _ := h.svc.Conversations("", ""); len(page.Items) != 0 {
		t.Fatalf("conversations stored: %+v", page.Items)
	}
	os.Remove(rec)
	h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "p", MaxTokens: 50})
	b, _ = os.ReadFile(rec)
	if strings.Contains(string(b), "response_format") || !strings.Contains(string(b), `"max_tokens":50`) {
		t.Fatalf("request = %s", b)
	}
}

func TestCompleteCancelAbortsRequest(t *testing.T) {
	h := newHarness(t, "ok")
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := h.c.Complete(ctx, core.CompletionRequest{Prompt: "SLOW", Purpose: "Slow work"})
		errc <- err
	}()
	waitFor(t, "slot taken", func() bool { return slotHolder(h) != nil })
	cancel()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("expected an error")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancel did not abort")
	}
	waitFor(t, "slot released", func() bool { return slotHolder(h) == nil })
}

func TestBusyStatusDuringCompletion(t *testing.T) {
	h := newHarness(t, "ok")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.c.Complete(ctx, core.CompletionRequest{Prompt: "SLOW", Purpose: "Translating subtitles"})
	}()
	waitFor(t, "busy", func() bool { return h.svc.Status().Busy == "Translating subtitles" })
	cancel()
	<-done
	if b := h.svc.Status().Busy; b != "" {
		t.Fatalf("busy after = %q", b)
	}
	h.ev.mu.Lock()
	last := h.ev.status[len(h.ev.status)-1]
	h.ev.mu.Unlock()
	if last.Busy != "" {
		t.Fatalf("last emitted status busy = %q", last.Busy)
	}
}

func TestInteractiveSendWaitsForBackground(t *testing.T) {
	h := newHarness(t, "ok")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.c.Complete(ctx, core.CompletionRequest{Prompt: "SLOW", Purpose: "Slow work"})
	}()
	waitFor(t, "busy", func() bool { return slotHolder(h) != nil })
	conv := h.newConv(t)
	type sr struct {
		res SendResult
		err error
	}
	rc := make(chan sr, 1)
	go func() {
		r, err := h.svc.Send(conv.ID, "hi")
		rc <- sr{r, err}
	}()
	select {
	case <-rc:
		t.Fatal("Send did not wait")
	case <-time.After(200 * time.Millisecond):
	}
	cancel() // background finishes
	<-done
	r := <-rc
	if r.err != nil {
		t.Fatal(r.err)
	}
	if d := h.waitDone(t, r.res.AssistantMessageID); d.Status != core.ChatMessageDone {
		t.Fatalf("done = %+v", d)
	}
}

func TestInteractiveBusyTimeout(t *testing.T) {
	h := newHarness(t, "ok")
	h.c.ixWait = 100 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.c.Complete(ctx, core.CompletionRequest{Prompt: "SLOW", Purpose: "Translating subtitles"})
	}()
	waitFor(t, "slot", func() bool { return slotHolder(h) != nil })
	conv := h.newConv(t)
	_, err := h.svc.Send(conv.ID, "hi")
	if !core.IsCode(err, core.CodeConflict) || !strings.Contains(err.Error(), "Local Chat is busy: Translating subtitles") {
		t.Fatalf("err = %v", err)
	}
	cancel()
	<-done
	if msgs, _ := h.db.ListMessages(context.Background(), conv.ID); len(msgs) != 0 {
		t.Fatalf("stored on conflict: %+v", msgs)
	}
}

func TestInteractivePriorityOverQueuedBackground(t *testing.T) {
	h := newHarness(t, "ok")
	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()
	first := make(chan struct{})
	go func() {
		defer close(first)
		h.c.Complete(ctx1, core.CompletionRequest{Prompt: "SLOW", Purpose: "first"})
	}()
	waitFor(t, "first holds", func() bool { g := slotHolder(h); return g != nil && g.purpose == "first" })

	var mu sync.Mutex
	var order []string
	note := func(s string) { mu.Lock(); order = append(order, s); mu.Unlock() }

	// A queued background request, then an interactive one.
	bgDone := make(chan struct{})
	go func() {
		defer close(bgDone)
		if _, err := h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "queued", Purpose: "second"}); err == nil {
			note("background")
		}
	}()
	waitFor(t, "bg queued", func() bool {
		h.c.mu.Lock()
		defer h.c.mu.Unlock()
		return h.c.freed != nil
	})
	conv := h.newConv(t)
	ixDone := make(chan struct{})
	go func() {
		defer close(ixDone)
		r, err := h.svc.Send(conv.ID, "hi")
		if err != nil {
			t.Error(err)
			return
		}
		note("interactive")
		h.waitDone(t, r.AssistantMessageID)
	}()
	waitFor(t, "interactive waiting", func() bool {
		h.c.mu.Lock()
		defer h.c.mu.Unlock()
		return h.c.waitingIx == 1
	})
	cancel1()
	<-first
	<-ixDone
	<-bgDone
	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "interactive" {
		t.Fatalf("order = %v", order)
	}
}

func TestConversationMarksRunningMessageStreaming(t *testing.T) {
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	res, err := h.svc.Send(conv.ID, "SLOW please")
	if err != nil {
		t.Fatal(err)
	}
	view, _ := h.svc.Conversation(conv.ID)
	got := map[string]core.ChatMessageStatus{}
	for _, m := range view.Messages {
		got[m.ID] = m.Status
	}
	if got[res.AssistantMessageID] != core.ChatMessageStreaming || got[res.UserMessageID] != core.ChatMessageDone {
		t.Fatalf("statuses = %v", got)
	}
	h.svc.Stop(conv.ID)
	h.waitDone(t, res.AssistantMessageID)
	view, _ = h.svc.Conversation(conv.ID)
	if st := view.Messages[1].Status; st != core.ChatMessageStopped {
		t.Fatalf("after stop = %q", st)
	}
}

func TestCompleteOllamaFormat(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			http.NotFound(w, r)
			return
		}
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &body)
		io.WriteString(w, `{"message":{"role":"assistant","content":"{\"a\":\"b\"}"},"done":true}`)
	}))
	defer srv.Close()
	h := newHarness(t, "ok")
	cs := core.DefaultChatSettings()
	cs.OllamaURL = srv.URL
	cs.DefaultModel = "ollama:phi3"
	if _, err := h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs}); err != nil {
		t.Fatal(err)
	}
	out, err := h.c.Complete(context.Background(), core.CompletionRequest{
		System: "s", Prompt: "p", JSONSchema: json.RawMessage(`{"type":"object"}`), MaxTokens: 77,
	})
	if err != nil || out != `{"a":"b"}` {
		t.Fatalf("out = %q, %v", out, err)
	}
	f, _ := body["format"].(map[string]any)
	opts, _ := body["options"].(map[string]any)
	if body["stream"] != false || body["model"] != "phi3" || f["type"] != "object" || opts["num_predict"] != float64(77) {
		t.Fatalf("body = %v", body)
	}
}
