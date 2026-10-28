package chat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

func TestSendStreamsAndPersists(t *testing.T) {
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	res, err := h.svc.Send(conv.ID, "  hello world  ")
	if err != nil {
		t.Fatal(err)
	}
	done := h.waitDone(t, res.AssistantMessageID)
	if done.Status != core.ChatMessageDone || done.Tokens != 7 || done.TokensPerSec != 42.5 || done.Error != "" {
		t.Fatalf("done = %+v", done)
	}
	if got := h.ev.text(res.AssistantMessageID); got != "echo: hello world " {
		t.Fatalf("streamed = %q", got)
	}
	view, err := h.svc.Conversation(conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Conversation.Title != "hello world" || len(view.Messages) != 2 {
		t.Fatalf("view = %+v", view)
	}
	u, a := view.Messages[0], view.Messages[1]
	if u.Role != core.ChatRoleUser || u.Content != "hello world" || u.ID != res.UserMessageID {
		t.Fatalf("user = %+v", u)
	}
	if a.ID != res.AssistantMessageID || a.Content != "echo: hello world " || a.Status != core.ChatMessageDone || a.Tokens != 7 || a.TokensPerSec != 42.5 {
		t.Fatalf("assistant = %+v", a)
	}
	// The slot is free again.
	waitFree(t, h)
	if _, err := h.svc.Send(conv.ID, "again"); err != nil {
		t.Fatalf("second send: %v", err)
	}
}

func waitFree(t *testing.T, h *harness) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		h.c.mu.Lock()
		busy := h.c.gen != nil
		h.c.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("generation never released")
}

func TestSendRejectsEmptyAndUnavailable(t *testing.T) {
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	if _, err := h.svc.Send(conv.ID, "   "); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("empty: %v", err)
	}
	if _, err := h.svc.Send("nope", "hi"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("unknown conv: %v", err)
	}
	os.Remove(h.models + "/llm/fake.gguf")
	if _, err := h.svc.Send(conv.ID, "hi"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("missing model: %v", err)
	}
	if msgs, _ := h.db.ListMessages(context.Background(), conv.ID); len(msgs) != 0 {
		t.Fatalf("a failed preflight stored messages: %+v", msgs)
	}
	waitFree(t, h)
}

func TestOneGenerationAtATimeAndStop(t *testing.T) {
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	res, err := h.svc.Send(conv.ID, "SLOW please")
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.svc.Send(conv.ID, "second")
	if !core.IsCode(err, core.CodeConflict) || !strings.Contains(err.Error(), "Wait for the current answer or stop it") {
		t.Fatalf("second send: %v", err)
	}
	// Wait for some text, then stop.
	deadline := time.Now().Add(15 * time.Second)
	for h.ev.text(res.AssistantMessageID) == "" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	start := time.Now()
	if err := h.svc.Stop(conv.ID); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 3*time.Second {
		t.Errorf("stop took %v", time.Since(start))
	}
	done := h.waitDone(t, res.AssistantMessageID)
	if done.Status != core.ChatMessageStopped {
		t.Fatalf("done = %+v", done)
	}
	msgs, _ := h.db.ListMessages(context.Background(), conv.ID)
	a := msgs[1]
	if a.Status != core.ChatMessageStopped || !strings.HasPrefix(a.Content, "tick") {
		t.Fatalf("saved = %+v", a)
	}
	// A stop for another conversation does nothing; a new send works after.
	waitFree(t, h)
	if _, err := h.svc.Send(conv.ID, "next"); err != nil {
		t.Fatal(err)
	}
}

func TestQuitSavesStopped(t *testing.T) {
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	res, err := h.svc.Send(conv.ID, "SLOW forever")
	if err != nil {
		t.Fatal(err)
	}
	for h.ev.text(res.AssistantMessageID) == "" {
		time.Sleep(10 * time.Millisecond)
	}
	h.c.Stop()
	msgs, _ := h.db.ListMessages(context.Background(), conv.ID)
	if a := msgs[1]; a.Status != core.ChatMessageStopped || a.Content == "" {
		t.Fatalf("saved = %+v", a)
	}
	if h.svc.Status().State != core.ChatStopped {
		t.Fatalf("status = %+v", h.svc.Status())
	}
}

func TestStreamErrorSavedAsError(t *testing.T) {
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	res, _ := h.svc.Send(conv.ID, "FAIL now")
	done := h.waitDone(t, res.AssistantMessageID)
	if done.Status != core.ChatMessageError || done.Error == "" {
		t.Fatalf("done = %+v", done)
	}
	msgs, _ := h.db.ListMessages(context.Background(), conv.ID)
	if msgs[1].Status != core.ChatMessageError || msgs[1].Error == "" {
		t.Fatalf("saved = %+v", msgs[1])
	}
}

func TestPersistenceCadence(t *testing.T) {
	h := newHarness(t, "ok")
	h.c.tm.persist = 50 * time.Millisecond
	conv := h.newConv(t)
	res, _ := h.svc.Send(conv.ID, "SLOW persist")
	var mid string
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		msgs, _ := h.db.ListMessages(context.Background(), conv.ID)
		if len(msgs) == 2 && msgs[1].Content != "" {
			mid = msgs[1].Content
			if msgs[1].Status != core.ChatMessageDone {
				t.Fatalf("mid-stream status = %s", msgs[1].Status)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if mid == "" {
		t.Fatal("assistant message was not persisted while streaming")
	}
	h.svc.Stop(conv.ID)
	h.waitDone(t, res.AssistantMessageID)
}

func TestDeltasAreCoalesced(t *testing.T) {
	h := newHarness(t, "ok")
	h.c.tm.coalesce = 80 * time.Millisecond
	conv := h.newConv(t)
	res, _ := h.svc.Send(conv.ID, "one two three four five six seven eight nine ten")
	h.waitDone(t, res.AssistantMessageID)
	h.ev.mu.Lock()
	n := len(h.ev.deltas)
	h.ev.mu.Unlock()
	if n == 0 || n >= 11 {
		t.Fatalf("delta events = %d; want coalesced (<11)", n)
	}
	if got := h.ev.text(res.AssistantMessageID); got != "echo: one two three four five six seven eight nine ten " {
		t.Fatalf("text = %q", got)
	}
}

func TestRegenerateAndEdit(t *testing.T) {
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	r1, _ := h.svc.Send(conv.ID, "first")
	h.waitDone(t, r1.AssistantMessageID)
	waitFree(t, h)
	r2, _ := h.svc.Send(conv.ID, "second")
	h.waitDone(t, r2.AssistantMessageID)
	waitFree(t, h)

	// Regenerate replaces only the last assistant message.
	rr, err := h.svc.Regenerate(conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rr.UserMessageID != r2.UserMessageID || rr.AssistantMessageID == r2.AssistantMessageID {
		t.Fatalf("regenerate result = %+v (prev %+v)", rr, r2)
	}
	h.waitDone(t, rr.AssistantMessageID)
	waitFree(t, h)
	msgs, _ := h.db.ListMessages(context.Background(), conv.ID)
	if len(msgs) != 4 || msgs[3].ID != rr.AssistantMessageID || msgs[3].Content != "echo: second " {
		t.Fatalf("after regenerate: %+v", msgs)
	}

	// Edit the first user message: everything after it is dropped.
	er, err := h.svc.EditAndResend(conv.ID, r1.UserMessageID, "edited")
	if err != nil {
		t.Fatal(err)
	}
	h.waitDone(t, er.AssistantMessageID)
	waitFree(t, h)
	msgs, _ = h.db.ListMessages(context.Background(), conv.ID)
	if len(msgs) != 2 || msgs[0].Content != "edited" || msgs[1].Content != "echo: edited " {
		t.Fatalf("after edit: %+v", msgs)
	}
	view, _ := h.svc.Conversation(conv.ID)
	if view.Conversation.Title != "edited" {
		t.Errorf("title after editing the first message = %q", view.Conversation.Title)
	}
	// Errors.
	if _, err := h.svc.EditAndResend(conv.ID, msgs[1].ID, "x"); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("editing an assistant message: %v", err)
	}
	if _, err := h.svc.EditAndResend(conv.ID, "nope", "x"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("unknown message: %v", err)
	}
	empty := h.newConv(t)
	if _, err := h.svc.Regenerate(empty.ID); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("regenerate empty: %v", err)
	}
}

func TestRequestCarriesSystemPromptAndTemperature(t *testing.T) {
	h := newHarness(t, "ok")
	rec := filepath.Join(t.TempDir(), "rec")
	h.setEnv("FAKE_RECORD", rec)
	cs := core.DefaultChatSettings()
	cs.Temperature = 1.25
	if _, err := h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs}); err != nil {
		t.Fatal(err)
	}
	conv := h.newConv(t)
	res, _ := h.svc.Send(conv.ID, "hi there")
	h.waitDone(t, res.AssistantMessageID)
	b, _ := os.ReadFile(rec)
	var req struct {
		Messages    []wireMsg `json:"messages"`
		Stream      bool      `json:"stream"`
		Temperature float64   `json:"temperature"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(b))), &req); err != nil {
		t.Fatal(err)
	}
	if !req.Stream || req.Temperature != 1.25 || len(req.Messages) != 2 ||
		req.Messages[0].Role != "system" || req.Messages[0].Content != cs.SystemPrompt || req.Messages[1].Content != "hi there" {
		t.Fatalf("request = %+v", req)
	}
}

func TestConversationCRUD(t *testing.T) {
	h := newHarness(t, "ok")
	if _, err := h.svc.NewConversation("nope"); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("bad model: %v", err)
	}
	if _, err := h.svc.NewConversation("ollama:"); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("empty ollama name: %v", err)
	}
	conv, err := h.svc.NewConversation("ollama:llama3")
	if err != nil || conv.Model != "ollama:llama3" || conv.Title != "New chat" {
		t.Fatalf("new: %+v %v", conv, err)
	}
	title, model, sp := "  Renamed  ", "fake", strings.Repeat("x", 4001)
	if _, err := h.svc.UpdateConversation(conv.ID, core.ChatConversationPatch{SystemPrompt: &sp}); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("long prompt: %v", err)
	}
	up, err := h.svc.UpdateConversation(conv.ID, core.ChatConversationPatch{Title: &title, Model: &model})
	if err != nil || up.Title != "Renamed" || up.Model != "fake" {
		t.Fatalf("update: %+v %v", up, err)
	}
	blank := " "
	if _, err := h.svc.UpdateConversation(conv.ID, core.ChatConversationPatch{Title: &blank}); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("blank title: %v", err)
	}
	page, err := h.svc.Conversations("Renam", "")
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list: %+v %v", page, err)
	}
	if err := h.svc.DeleteConversation(conv.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.Conversation(conv.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}

func TestDeleteConversationStopsItsGeneration(t *testing.T) {
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	res, _ := h.svc.Send(conv.ID, "SLOW delete")
	for h.ev.text(res.AssistantMessageID) == "" {
		time.Sleep(10 * time.Millisecond)
	}
	if err := h.svc.DeleteConversation(conv.ID); err != nil {
		t.Fatal(err)
	}
	waitFree(t, h)
}

func TestModelSwitchRestartsServer(t *testing.T) {
	h := newHarness(t, "ok")
	e2 := h.entry
	e2.ID, e2.File = "fake2", "fake2.gguf"
	h.c.entries = func() []catalogEntry { return []catalogEntry{h.entry, e2} }
	os.WriteFile(h.models+"/llm/fake2.gguf", []byte(fakeModelBody), 0o644)
	s1, err := h.c.ensureServer(context.Background(), h.entry)
	if err != nil {
		t.Fatal(err)
	}
	s2, err := h.c.ensureServer(context.Background(), e2)
	if err != nil {
		t.Fatal(err)
	}
	if s1.alive() || !s2.alive() || s2.model != "fake2" {
		t.Fatalf("old alive=%v new alive=%v", s1.alive(), s2.alive())
	}
}

func TestDeleteModelStopsServer(t *testing.T) {
	h := newHarness(t, "ok")
	s, err := h.c.ensureServer(context.Background(), h.entry)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.DeleteModel("fake"); err != nil {
		t.Fatal(err)
	}
	if s.alive() {
		t.Error("server still running after its model was deleted")
	}
	if h.c.modelPresent("fake") {
		t.Error("model file still present")
	}
	if err := h.svc.DeleteModel("nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("unknown: %v", err)
	}
}

func TestCatalogAndExport(t *testing.T) {
	h := newHarness(t, "ok")
	cat := h.svc.Catalog()
	if len(cat) != 1 || !cat[0].Installed || cat[0].ID != "fake" {
		t.Fatalf("catalog = %+v", cat)
	}
	real := New(Config{Settings: h.c.cfg.Settings})
	infos := NewService(real).Catalog()
	if len(infos) != 3 || infos[0].ID != "qwen3-4b" || !infos[0].IsDefault || infos[0].Installed {
		t.Fatalf("real catalog = %+v", infos)
	}

	conv := h.newConv(t)
	title := `a/b: "c"?`
	h.svc.UpdateConversation(conv.ID, core.ChatConversationPatch{Title: &title})
	res, _ := h.svc.Send(conv.ID, "export me")
	h.waitDone(t, res.AssistantMessageID)
	waitFree(t, h)
	p1, err := h.svc.Export(conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := h.svc.Export(conv.ID)
	if err != nil || p1 == p2 {
		t.Fatalf("second export must get a unique path: %q %q %v", p1, p2, err)
	}
	if filepath.Dir(p1) != filepath.Join(h.lib, "Chats") || filepath.Ext(p1) != ".md" {
		t.Fatalf("path = %s", p1)
	}
	b, _ := os.ReadFile(p1)
	for _, want := range []string{"# a/b:", "## You", "export me", "## Assistant", "echo: export me"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("export missing %q:\n%s", want, b)
		}
	}
	if len(h.outputs) != 2 || h.outputs[0] != p1 {
		t.Errorf("registered outputs = %v", h.outputs)
	}
}

func TestFileStem(t *testing.T) {
	for in, want := range map[string]string{
		`a/b:c`: "a b c", "  ..x.. ": "x", "": "Chat", "CON": "Chat", "???": "Chat",
		strings.Repeat("é", 100): strings.Repeat("é", 80),
	} {
		if got := fileStem(in); got != want {
			t.Errorf("fileStem(%q) = %q want %q", in, got, want)
		}
	}
}

func TestEventsEmittedConcurrently(t *testing.T) {
	// Status events arrive in order starting → ready.
	h := newHarness(t, "ok")
	conv := h.newConv(t)
	res, _ := h.svc.Send(conv.ID, "hi")
	h.waitDone(t, res.AssistantMessageID)
	st := h.ev.states()
	var seen []core.ChatServerState
	for _, s := range st {
		if len(seen) == 0 || seen[len(seen)-1] != s {
			seen = append(seen, s)
		}
	}
	if len(seen) < 2 || seen[0] != core.ChatStarting || seen[1] != core.ChatReady {
		t.Fatalf("status sequence = %v", seen)
	}
}
