package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"testing/iotest"

	"toolbox/core"
)

func TestReadSSE(t *testing.T) {
	stream := ": keep-alive\r\n\r\ndata: {\"a\":1}\n\ndata:{\"b\":2}\n\nevent: x\ndata: line1\ndata: line2\n\ndata: [DONE]\n\ndata: after\n\n"
	for name, r := range map[string]io.Reader{
		"whole":    strings.NewReader(stream),
		"one byte": iotest.OneByteReader(strings.NewReader(stream)),
		"half":     iotest.HalfReader(strings.NewReader(stream)),
	} {
		var got []string
		err := readSSE(r, func(d string) (bool, error) {
			if d == "[DONE]" {
				return true, nil
			}
			got = append(got, d)
			return false, nil
		})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if want := `{"a":1}|{"b":2}|line1` + "\n" + `line2`; strings.Join(got, "|") != want {
			t.Errorf("%s: got %q want %q", name, strings.Join(got, "|"), want)
		}
	}
	// No trailing blank line: the last event is still delivered at EOF.
	var got []string
	readSSE(strings.NewReader("data: tail"), func(d string) (bool, error) { got = append(got, d); return false, nil })
	if len(got) != 1 || got[0] != "tail" {
		t.Errorf("eof event = %v", got)
	}
	// A callback error stops the read.
	err := readSSE(strings.NewReader("data: x\n\ndata: y\n\n"), func(string) (bool, error) { return false, fmt.Errorf("boom") })
	if err == nil || err.Error() != "boom" {
		t.Errorf("err = %v", err)
	}
}

func sseServer(t *testing.T, key string, body string) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestStreamOpenAIChunksUsageAndDone(t *testing.T) {
	body := `data: {"choices":[{"delta":{"role":"assistant"}}]}

data: {"choices":[{"delta":{"content":"Hel"}}]}

data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}

data: {"choices":[{"delta":{"content":"lo"}}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"completion_tokens":9},"timings":{"predicted_per_second":77.5}}

data: [DONE]

`
	srv := sseServer(t, "k", body)
	var got strings.Builder
	st, err := streamOpenAI(context.Background(), srv.URL, "k", []wireMsg{{Role: "user", Content: "hi"}}, 0.7, func(d string) { got.WriteString(d) })
	if err != nil || got.String() != "Hello" || st.Tokens != 9 || st.TPS != 77.5 {
		t.Fatalf("got %q %+v %v", got.String(), st, err)
	}
	if _, err := streamOpenAI(context.Background(), srv.URL, "wrong", nil, 0, func(string) {}); err == nil {
		t.Error("wrong key should fail")
	}
}

func TestStreamOpenAIContextOverflowMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"type":"exceed_context_size_error","message":"request (9000 tokens) exceeds the available context size"}}`, 400)
	}))
	defer srv.Close()
	_, err := streamOpenAI(context.Background(), srv.URL, "k", nil, 0, func(string) {})
	if ae := core.AsAppError(err); ae.Code != core.CodeToolFailed || !strings.Contains(ae.Message, "too long") {
		t.Fatalf("err = %v", err)
	}
}

func TestStreamCancelClosesRequest(t *testing.T) {
	closed := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n")
		fl.Flush()
		<-r.Context().Done()
		close(closed)
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	n := 0
	_, err := streamOpenAI(ctx, srv.URL, "k", nil, 0, func(string) { n++; cancel() })
	if err == nil || n != 1 {
		t.Fatalf("err=%v n=%d", err, n)
	}
	<-closed // the server saw the request go away
}

func TestOllamaTagsAndChat(t *testing.T) {
	var gotReq map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/tags":
			io.WriteString(w, `{"models":[{"name":"llama3:8b","size":4700000000},{"name":"phi3","size":2000}]}`)
		case "/api/chat":
			json.NewDecoder(r.Body).Decode(&gotReq)
			fl := w.(http.Flusher)
			for _, l := range []string{
				`{"message":{"role":"assistant","content":"Hi"},"done":false}`,
				`{"message":{"role":"assistant","content":" there"},"done":false}`,
				`{"message":{"role":"assistant","content":""},"done":true,"eval_count":20,"eval_duration":2000000000}`,
			} {
				io.WriteString(w, l+"\n")
				fl.Flush()
			}
		}
	}))
	defer srv.Close()
	// httptest binds 127.0.0.1, so it passes the loopback rule.
	models, err := ollamaTags(context.Background(), srv.URL+"/")
	if err != nil || len(models) != 2 || models[0].Name != "llama3:8b" {
		t.Fatalf("tags: %+v %v", models, err)
	}
	var got strings.Builder
	st, err := streamOllama(context.Background(), srv.URL, "llama3:8b", []wireMsg{{Role: "user", Content: "yo"}}, 0.5, 4096, func(d string) { got.WriteString(d) })
	if err != nil || got.String() != "Hi there" || st.Tokens != 20 || st.TPS != 10 {
		t.Fatalf("chat: %q %+v %v", got.String(), st, err)
	}
	if gotReq["model"] != "llama3:8b" || gotReq["stream"] != true {
		t.Fatalf("request = %v", gotReq)
	}
	if o := gotReq["options"].(map[string]any); o["temperature"] != 0.5 || o["num_ctx"] != float64(4096) {
		t.Fatalf("options = %v", o)
	}
}

func TestOllamaRejectsNonLoopback(t *testing.T) {
	for _, u := range []string{"http://example.com:11434", "http://192.168.1.5:11434", "https://127.0.0.1:11434", "ftp://localhost", "", "http://user@127.0.0.1"} {
		if _, err := ollamaBase(u); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%q should be rejected: %v", u, err)
		}
		if _, err := ollamaTags(context.Background(), u); err == nil {
			t.Errorf("tags %q should fail", u)
		}
	}
	for _, u := range []string{"http://127.0.0.1:11434", "http://localhost:11434/", "http://[::1]:11434"} {
		if _, err := ollamaBase(u); err != nil {
			t.Errorf("%q: %v", u, err)
		}
	}
}

func TestOllamaErrorLine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"error":"model not found"}`+"\n")
	}))
	defer srv.Close()
	_, err := streamOllama(context.Background(), srv.URL, "x", nil, 0, 4096, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "model not found") {
		t.Fatalf("err = %v", err)
	}
}

func TestCatalogIncludesOllamaModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"models":[{"name":"phi3","size":2000}]}`)
	}))
	defer srv.Close()
	h := newHarness(t, "ok")
	cs := core.DefaultChatSettings()
	cs.OllamaURL = srv.URL
	if _, err := h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs}); err != nil {
		t.Fatal(err)
	}
	cat := h.svc.Catalog()
	if len(cat) != 2 || cat[1].ID != "ollama:phi3" || !cat[1].Ollama || !cat[1].Installed {
		t.Fatalf("catalog = %+v", cat)
	}
	srv.Close() // unreachable: a status note, no error
	cat = h.svc.Catalog()
	if len(cat) != 1 || h.svc.Status().Notice == "" {
		t.Fatalf("unreachable: %+v %+v", cat, h.svc.Status())
	}
}

func TestSendViaOllama(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"message":{"content":"pong"},"done":false}`+"\n"+`{"done":true,"eval_count":1,"eval_duration":1000000000}`+"\n")
	}))
	defer srv.Close()
	h := newHarness(t, "ok")
	conv, _ := h.svc.NewConversation("ollama:phi3")
	if _, err := h.svc.Send(conv.ID, "ping"); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("ollama off: %v", err)
	}
	cs := core.DefaultChatSettings()
	cs.OllamaURL = srv.URL
	h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs})
	res, err := h.svc.Send(conv.ID, "ping")
	if err != nil {
		t.Fatal(err)
	}
	if d := h.waitDone(t, res.AssistantMessageID); d.Status != core.ChatMessageDone || h.ev.text(res.AssistantMessageID) != "pong" {
		t.Fatalf("done = %+v", d)
	}
	if st := h.svc.Status(); st.Backend != core.ChatBackendOllama || st.Model != "ollama:phi3" {
		t.Fatalf("status = %+v", st)
	}
	if h.c.srv != nil {
		t.Error("no llama-server should start for Ollama")
	}
}

func msg(role core.ChatRole, n int) core.ChatMessage {
	return core.ChatMessage{Role: role, Content: strings.Repeat("x", n)}
}

func TestBuildHistory(t *testing.T) {
	msgs := []core.ChatMessage{msg(core.ChatRoleUser, 10), msg(core.ChatRoleAssistant, 10), msg(core.ChatRoleUser, 10), {Role: core.ChatRoleAssistant}}
	out, trimmed := buildHistory("sys", msgs, 8192)
	if trimmed || len(out) != 4 || out[0].Role != "system" || out[3].Role != "user" {
		t.Fatalf("small: %+v trimmed=%v", out, trimmed)
	}
	if out, _ = buildHistory("", msgs, 8192); out[0].Role == "system" {
		t.Error("empty system prompt should be omitted")
	}

	// 4096 ctx → budget 3072 tokens ≈ 10752 chars. Five 3000-char turns don't fit.
	var big []core.ChatMessage
	for i := 0; i < 5; i++ {
		big = append(big, msg(core.ChatRoleUser, 3000), msg(core.ChatRoleAssistant, 3000))
	}
	big = append(big, msg(core.ChatRoleUser, 100))
	out, trimmed = buildHistory("sys", big, 4096)
	if !trimmed {
		t.Fatal("expected trimming")
	}
	if out[0].Role != "system" || out[1].Role != "user" || out[len(out)-1].Content != big[len(big)-1].Content {
		t.Fatalf("shape: %v", roles(out))
	}
	total := 0
	for _, m := range out {
		total += estimateTokens(m.Content) + 4
	}
	if total > 3072+4 {
		t.Errorf("estimated %d tokens over budget", total)
	}
	if len(out) >= len(big)+1 {
		t.Errorf("nothing dropped: %d", len(out))
	}
	// The newest message is kept even when it alone exceeds the budget.
	out, trimmed = buildHistory("sys", []core.ChatMessage{msg(core.ChatRoleUser, 100), msg(core.ChatRoleAssistant, 100), msg(core.ChatRoleUser, 50000)}, 4096)
	if len(out) != 2 || len(out[1].Content) != 50000 || !trimmed {
		t.Fatalf("oversize: %v", roles(out))
	}
	if estimateTokens("1234567") != 2 || estimateTokens("é") != 1 {
		t.Error("token estimate")
	}
}

func roles(ms []wireMsg) []string {
	var r []string
	for _, m := range ms {
		r = append(r, m.Role+":"+strconv.Itoa(len(m.Content)))
	}
	return r
}

func TestTitleFrom(t *testing.T) {
	if got := titleFrom("  hello\n\n  world\t!  "); got != "hello world !" {
		t.Errorf("got %q", got)
	}
	long := strings.Repeat("ab ", 60)
	if got := titleFrom(long); len([]rune(got)) > 80 || got == "" {
		t.Errorf("long title %d", len([]rune(got)))
	}
	if titleFrom("   ") != "New chat" {
		t.Error("blank")
	}
}

// ---- model download ----

type modelServer struct {
	srv      *httptest.Server
	data     []byte
	ranges   []string
	failAt   int // abort the first response after this many bytes (0 = never)
	ignoreRg bool
	hits     atomic.Int32
}

func newModelServer(t *testing.T, data []byte) *modelServer {
	m := &modelServer{data: data}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := m.hits.Add(1)
		rg := r.Header.Get("Range")
		m.ranges = append(m.ranges, rg)
		start := 0
		if rg != "" && !m.ignoreRg {
			fmt.Sscanf(rg, "bytes=%d-", &start)
			if start >= len(m.data) {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(m.data)-1, len(m.data)))
			w.WriteHeader(http.StatusPartialContent)
		}
		body := m.data[start:]
		if m.failAt > 0 && n == 1 {
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			w.Write(body[:m.failAt])
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		}
		w.Write(body)
	}))
	t.Cleanup(m.srv.Close)
	return m
}

func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func downloadHarness(t *testing.T, data []byte, wantSum string) (*harness, *modelServer, *core.JobContext) {
	t.Helper()
	h := newHarness(t, "ok")
	os.Remove(h.models + "/llm/fake.gguf")
	ms := newModelServer(t, data)
	h.entry = catalogEntry{ID: "fake", Label: "Fake model", File: "fake.gguf", Bytes: int64(len(data)), SHA256: wantSum}
	h.c.modelURL = func(catalogEntry) string { return ms.srv.URL + "/m.gguf" }
	job := core.NewJobContext(core.JobContext{ID: "j"}, core.JobHooks{})
	return h, ms, job
}

func testData(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 7)
	}
	return b
}

func TestDownloadFresh(t *testing.T) {
	data := testData(1 << 20)
	h, _, job := downloadHarness(t, data, sha(data))
	if h.c.modelPresent("fake") {
		t.Fatal("present before download")
	}
	if err := h.c.downloadModel(context.Background(), job, h.entry); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(h.c.modelPath(h.entry))
	if sha(got) != sha(data) || !h.c.modelPresent("fake") {
		t.Fatal("file wrong")
	}
	if _, err := os.Stat(h.c.modelPath(h.entry) + ".part"); !os.IsNotExist(err) {
		t.Error(".part left behind")
	}
	// Present → no-op without any request.
	if err := h.c.downloadModel(context.Background(), job, h.entry); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadResumesFromPartial(t *testing.T) {
	data := testData(1 << 20)
	h, ms, job := downloadHarness(t, data, sha(data))
	part := h.c.modelPath(h.entry) + ".part"
	os.WriteFile(part, data[:300000], 0o644)
	if err := h.c.downloadModel(context.Background(), job, h.entry); err != nil {
		t.Fatal(err)
	}
	if len(ms.ranges) != 1 || ms.ranges[0] != "bytes=300000-" {
		t.Fatalf("ranges = %q", ms.ranges)
	}
	got, _ := os.ReadFile(h.c.modelPath(h.entry))
	if sha(got) != sha(data) {
		t.Fatal("resumed file differs")
	}
}

func TestDownloadInterruptedThenResumed(t *testing.T) {
	data := testData(1 << 20)
	h, ms, job := downloadHarness(t, data, sha(data))
	ms.failAt = 400000
	if err := h.c.downloadModel(context.Background(), job, h.entry); err == nil {
		t.Fatal("expected an interrupted download to fail")
	}
	fi, err := os.Stat(h.c.modelPath(h.entry) + ".part")
	if err != nil || fi.Size() == 0 || fi.Size() >= int64(len(data)) {
		t.Fatalf("partial file kept? %v %v", fi, err)
	}
	if err := h.c.downloadModel(context.Background(), job, h.entry); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if !strings.HasPrefix(ms.ranges[1], "bytes=") || ms.ranges[1] == "bytes=0-" {
		t.Errorf("second request ranges = %q", ms.ranges)
	}
	got, _ := os.ReadFile(h.c.modelPath(h.entry))
	if sha(got) != sha(data) {
		t.Fatal("resumed file differs")
	}
}

func TestDownloadServerIgnoresRange(t *testing.T) {
	data := testData(200000)
	h, ms, job := downloadHarness(t, data, sha(data))
	ms.ignoreRg = true
	os.WriteFile(h.c.modelPath(h.entry)+".part", data[:5000], 0o644)
	if err := h.c.downloadModel(context.Background(), job, h.entry); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(h.c.modelPath(h.entry))
	if sha(got) != sha(data) {
		t.Fatal("a 200 answer must restart from zero")
	}
}

func TestDownloadShaMismatchDeletes(t *testing.T) {
	data := testData(100000)
	h, _, job := downloadHarness(t, data, sha([]byte("something else")))
	err := h.c.downloadModel(context.Background(), job, h.entry)
	if ae := core.AsAppError(err); ae.Code != core.CodeToolFailed || ae.Message != "The download was corrupted — try again" {
		t.Fatalf("err = %v", err)
	}
	for _, p := range []string{h.c.modelPath(h.entry), h.c.modelPath(h.entry) + ".part"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s should be deleted", filepath.Base(p))
		}
	}
}

func TestDownloadStalePartLargerThanModel(t *testing.T) {
	data := testData(50000)
	h, _, job := downloadHarness(t, data, sha(data))
	os.WriteFile(h.c.modelPath(h.entry)+".part", testData(90000), 0o644)
	if err := h.c.downloadModel(context.Background(), job, h.entry); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadCancel(t *testing.T) {
	data := testData(100000)
	h, _, job := downloadHarness(t, data, sha(data))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := h.c.downloadModel(ctx, job, h.entry); !core.IsCode(err, core.CodeCancelled) {
		t.Fatalf("err = %v", err)
	}
}

func TestModelProviderAndModule(t *testing.T) {
	data := testData(80000)
	h, _, job := downloadHarness(t, data, sha(data))
	reg := core.NewRegistry()
	if err := Register(reg, h.c); err != nil {
		t.Fatal(err)
	}
	m, ok := reg.Get(ModuleID)
	if !ok {
		t.Fatal("module missing")
	}
	mp, ok := m.(core.ModelProvider)
	if !ok {
		t.Fatal("chat module must implement core.ModelProvider")
	}
	if mp.ModelPresent("fake") || mp.ModelPresent("nope") {
		t.Fatal("present before fetch")
	}
	if err := mp.FetchModel(context.Background(), job, "nope"); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("unknown preset: %v", err)
	}
	if err := mp.FetchModel(context.Background(), job, "fake"); err != nil {
		t.Fatal(err)
	}
	if !mp.ModelPresent("fake") {
		t.Fatal("not present after fetch")
	}
	if err := mp.RemoveModel("fake"); err != nil || mp.ModelPresent("fake") {
		t.Fatalf("remove: %v", err)
	}

	// The hidden job module.
	dm, ok := reg.Get(ModelModuleID)
	if !ok {
		t.Fatal("download module missing")
	}
	if err := dm.Validate(nil, json.RawMessage(`{"model":"nope"}`)); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("validate unknown: %v", err)
	}
	if err := dm.Validate(nil, json.RawMessage(`{"model":"fake"}`)); err != nil {
		t.Errorf("validate: %v", err)
	}
	jc := core.NewJobContext(core.JobContext{ID: "j", Options: json.RawMessage(`{"model":"fake"}`)}, core.JobHooks{})
	if err := dm.Run(context.Background(), jc); err != nil || !h.c.modelPresent("fake") {
		t.Fatalf("run: %v", err)
	}
}

func TestFormatBytes(t *testing.T) {
	for n, want := range map[int64]string{999: "999 B", 5000: "5 kB", 18000000: "18 MB", 2497281120: "2.5 GB"} {
		if got := formatBytes(n); got != want {
			t.Errorf("%d -> %q want %q", n, got, want)
		}
	}
}

func TestCatalogPinned(t *testing.T) {
	ids := map[string]bool{}
	for _, e := range catalog {
		if ids[e.ID] || len(e.SHA256) != 64 || e.Bytes <= 0 || e.License == "" || !strings.HasSuffix(e.File, ".gguf") {
			t.Errorf("bad entry %+v", e)
		}
		ids[e.ID] = true
	}
	if !ids["qwen3-4b"] || !ids["qwen3.5-2b"] || !ids["gemma4-e4b"] {
		t.Error("catalog ids")
	}
	if u := catalog[0].URL(); u != "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" {
		t.Errorf("url = %s", u)
	}
}
