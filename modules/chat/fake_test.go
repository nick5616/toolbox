package chat

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/store"
)

// The fake llama-server: the test binary re-executes itself (see TestMain)
// when FAKE_LLAMA=1. FAKE_MODE picks the behaviour:
//
//	ok          listen, /health 200, authenticated SSE completions
//	early_exit  print an error and exit 1 before listening
//	hang        print nothing and never listen
//	bind_once   fail with "couldn't bind" the first time (FAKE_STATE file), then ok
//	gpu_fail    fail with a Vulkan OOM unless started with --device none, then ok
//	unhealthy   listen, but /health stays 503
//
// FAKE_RECORD (file) receives every completion request body, one per line;
// FAKE_ARGS (file) receives the command line.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_LLAMA") == "1" {
		runFakeLlama()
		return
	}
	os.Exit(m.Run())
}

func runFakeLlama() {
	args := os.Args[1:]
	if f := os.Getenv("FAKE_ARGS"); f != "" {
		_ = os.WriteFile(f, []byte(strings.Join(args, "\n")), 0o644)
	}
	argVal := func(name string) string {
		for i, a := range args {
			if a == name && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	has := func(v string) bool {
		for _, a := range args {
			if a == v {
				return true
			}
		}
		return false
	}
	keyBytes, _ := os.ReadFile(argVal("--api-key-file"))
	key := strings.TrimSpace(string(keyBytes))

	switch os.Getenv("FAKE_MODE") {
	case "early_exit":
		fmt.Println("llama_model_load: error loading model: bad gguf")
		fmt.Fprintln(os.Stderr, "fatal: could not load")
		os.Exit(1)
	case "hang":
		time.Sleep(time.Hour)
	case "bind_once":
		st := os.Getenv("FAKE_STATE")
		if _, err := os.Stat(st); err != nil {
			_ = os.WriteFile(st, []byte("x"), 0o644)
			fmt.Println("couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 0")
			os.Exit(1)
		}
	case "gpu_fail":
		if !has("none") {
			fmt.Println("ggml_vulkan: Found 1 Vulkan devices")
			fmt.Println("ggml_vulkan: Device memory allocation failed: vk::Device::allocateMemory: ErrorOutOfDeviceMemory")
			os.Exit(1)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if os.Getenv("FAKE_MODE") == "unhealthy" {
			http.Error(w, "loading", http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	var recMu sync.Mutex
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key || key == "" {
			http.Error(w, `{"error":{"message":"Invalid API Key"}}`, http.StatusUnauthorized)
			return
		}
		var req struct {
			Messages []struct{ Role, Content string } `json:"messages"`
		}
		var raw json.RawMessage
		dec := json.NewDecoder(r.Body)
		_ = dec.Decode(&raw)
		_ = json.Unmarshal(raw, &req)
		if f := os.Getenv("FAKE_RECORD"); f != "" {
			recMu.Lock()
			fh, _ := os.OpenFile(f, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			fh.Write(append(raw, '\n'))
			fh.Close()
			recMu.Unlock()
		}
		last := ""
		if n := len(req.Messages); n > 0 {
			last = req.Messages[n-1].Content
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		chunk := func(s string) { fmt.Fprintf(w, "data: %s\n\n", s); fl.Flush() }
		chunk(`{"choices":[{"delta":{"role":"assistant"}}]}`)
		if strings.HasPrefix(last, "SLOW") {
			for i := 0; ; i++ {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(15 * time.Millisecond):
				}
				chunk(`{"choices":[{"delta":{"content":"tick "}}]}`)
			}
		}
		if strings.HasPrefix(last, "FAIL") {
			chunk(`{"error":{"message":"boom"}}`)
			return
		}
		for _, word := range strings.Fields("echo: " + last) {
			b, _ := json.Marshal(word + " ")
			chunk(`{"choices":[{"delta":{"content":` + string(b) + `}}]}`)
			time.Sleep(3 * time.Millisecond)
		}
		chunk(`{"choices":[{"delta":{},"finish_reason":"stop"}]}`)
		chunk(`{"choices":[],"usage":{"completion_tokens":7},"timings":{"predicted_per_second":42.5}}`)
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Println("couldn't bind HTTP server socket")
		os.Exit(1)
	}
	fmt.Printf("main: server is listening on http://127.0.0.1:%d\n", ln.Addr().(*net.TCPAddr).Port)
	_ = http.Serve(ln, mux)
}

// ---- harness ----

type events struct {
	mu     sync.Mutex
	deltas []core.ChatDelta
	dones  []core.ChatDone
	status []core.ChatStatus
}

func (e *events) Emit(name string, data any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch name {
	case core.EventChatDelta:
		e.deltas = append(e.deltas, data.(core.ChatDelta))
	case core.EventChatDone:
		e.dones = append(e.dones, data.(core.ChatDone))
	case core.EventChatStatus:
		e.status = append(e.status, data.(core.ChatStatus))
	}
}

func (e *events) doneFor(msgID string) (core.ChatDone, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, d := range e.dones {
		if d.MessageID == msgID {
			return d, true
		}
	}
	return core.ChatDone{}, false
}

func (e *events) text(msgID string) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var b strings.Builder
	for _, d := range e.deltas {
		if d.MessageID == msgID {
			b.WriteString(d.Delta)
		}
	}
	return b.String()
}

func (e *events) states() []core.ChatServerState {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []core.ChatServerState
	for _, s := range e.status {
		out = append(out, s.State)
	}
	return out
}

type harness struct {
	c       *Chat
	svc     *Service
	db      *store.DB
	ev      *events
	tmp     string
	models  string
	lib     string
	env     map[string]string
	entry   catalogEntry
	outputs []string
}

const fakeModelBody = "GGUF-fake-model"

func newHarness(t *testing.T, mode string) *harness {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(dir + "/db/toolbox.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ev := &events{}
	settings, err := core.NewSettingsService(db, ev, dir+"/lib")
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{db: db, ev: ev, tmp: dir + "/tmp", models: dir + "/models", lib: dir + "/lib", env: map[string]string{}}
	h.entry = catalogEntry{ID: "fake", Label: "Fake model", File: "fake.gguf", Bytes: int64(len(fakeModelBody)), License: "MIT", Verified: true}
	exe, _ := os.Executable()
	h.c = New(Config{
		Store: db, Settings: settings, Emitter: ev, ModelsDir: h.models, TmpDir: h.tmp,
		Resolve:    func(string) (string, error) { return exe, nil },
		LibraryDir: func() string { return h.lib },
		RegisterOutput: func(p string) error {
			h.outputs = append(h.outputs, p)
			return nil
		},
	})
	h.c.entries = func() []catalogEntry { return []catalogEntry{h.entry} }
	h.c.tm = timings{
		ready: 15 * time.Second, poll: 20 * time.Millisecond, idle: time.Hour,
		persist: time.Hour, coalesce: 10 * time.Millisecond, killGrace: 5 * time.Second,
	}
	h.svc = NewService(h.c)
	h.setEnv("FAKE_LLAMA", "1")
	h.setEnv("FAKE_MODE", mode)
	if err := os.MkdirAll(h.models+"/llm", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.models+"/llm/fake.gguf", []byte(fakeModelBody), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.c.Stop)
	return h
}

func (h *harness) setEnv(k, v string) {
	h.env[k] = v
	var env []string
	for k, v := range h.env {
		env = append(env, k+"="+v)
	}
	h.c.serverEnv = env
}

func (h *harness) newConv(t *testing.T) core.ChatConversation {
	t.Helper()
	conv, err := h.svc.NewConversation("fake")
	if err != nil {
		t.Fatal(err)
	}
	return conv
}

func (h *harness) waitDone(t *testing.T, msgID string) core.ChatDone {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if d, ok := h.ev.doneFor(msgID); ok {
			return d
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no chat:done for %s", msgID)
	return core.ChatDone{}
}
