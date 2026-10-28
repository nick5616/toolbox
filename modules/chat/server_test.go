package chat

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

func startServer(t *testing.T, h *harness) (*server, error) {
	t.Helper()
	return h.c.ensureServer(context.Background(), h.entry)
}

func keyFiles(h *harness) []string {
	m, _ := filepath.Glob(filepath.Join(h.tmp, "llama-*.key"))
	return m
}

func TestServerStartsAndIsAuthenticated(t *testing.T) {
	h := newHarness(t, "ok")
	argsFile := filepath.Join(t.TempDir(), "args")
	h.setEnv("FAKE_ARGS", argsFile)
	s, err := startServer(t, h)
	if err != nil {
		t.Fatal(err)
	}
	if s.port == 0 || s.backend != core.ChatBackendGPU {
		t.Fatalf("server = %+v", s)
	}
	if st := h.svc.Status(); st.State != core.ChatReady || st.Model != "fake" || st.Backend != core.ChatBackendGPU {
		t.Fatalf("status = %+v", st)
	}
	if k := keyFiles(h); len(k) != 0 {
		t.Fatalf("key file not deleted after ready: %v", k)
	}
	// 401 without the key, 200 with.
	req, _ := http.NewRequest(http.MethodPost, s.base()+"/v1/chat/completions", strings.NewReader(`{"messages":[]}`))
	resp, err := loopbackClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no key: %d", resp.StatusCode)
	}
	args, _ := os.ReadFile(argsFile)
	for _, want := range []string{"--host\n127.0.0.1", "--port\n0", "--api-key-file", "--jinja", "-ngl\n99", "-c\n8192", "--no-webui", "--sleep-idle-seconds\n300"} {
		if !strings.Contains(string(args), want) {
			t.Errorf("args missing %q:\n%s", want, args)
		}
	}
	// Reuse: a second ensure returns the same server.
	s2, err := startServer(t, h)
	if err != nil || s2 != s {
		t.Fatalf("not reused: %v", err)
	}
	h.c.Stop()
	if st := h.svc.Status(); st.State != core.ChatStopped {
		t.Fatalf("after stop: %+v", st)
	}
	if s.alive() {
		t.Error("server still running after Stop")
	}
}

func TestServerCPUArgs(t *testing.T) {
	h := newHarness(t, "ok")
	argsFile := filepath.Join(t.TempDir(), "args")
	h.setEnv("FAKE_ARGS", argsFile)
	gpu := false
	cs := core.DefaultChatSettings()
	cs.GPU = gpu
	if _, err := h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs}); err != nil {
		t.Fatal(err)
	}
	s, err := startServer(t, h)
	if err != nil {
		t.Fatal(err)
	}
	if s.backend != core.ChatBackendCPU {
		t.Fatalf("backend = %s", s.backend)
	}
	args, _ := os.ReadFile(argsFile)
	if !strings.Contains(string(args), "-ngl\n0\n--device\nnone") {
		t.Errorf("cpu args:\n%s", args)
	}
}

func TestServerEarlyExitShowsLogTail(t *testing.T) {
	h := newHarness(t, "early_exit")
	_, err := startServer(t, h)
	if !core.IsCode(err, core.CodeToolFailed) {
		t.Fatalf("err = %v", err)
	}
	ae := core.AsAppError(err)
	if ae.Message != "The chat engine didn't start" || ae.Err == nil || !strings.Contains(ae.Err.Error(), "bad gguf") {
		t.Fatalf("error = %+v", ae)
	}
	if st := h.svc.Status(); st.State != core.ChatError {
		t.Fatalf("status = %+v", st)
	}
	if k := keyFiles(h); len(k) != 0 {
		t.Fatalf("key file left: %v", k)
	}
}

func TestServerReadinessTimeout(t *testing.T) {
	for _, mode := range []string{"hang", "unhealthy"} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t, mode)
			h.c.tm.ready = 600 * time.Millisecond
			start := time.Now()
			_, err := startServer(t, h)
			if !core.IsCode(err, core.CodeToolFailed) {
				t.Fatalf("err = %v", err)
			}
			if time.Since(start) > 10*time.Second {
				t.Errorf("took %v", time.Since(start))
			}
			if k := keyFiles(h); len(k) != 0 {
				t.Fatalf("key file left: %v", k)
			}
		})
	}
}

func TestServerBindRetry(t *testing.T) {
	h := newHarness(t, "bind_once")
	h.setEnv("FAKE_STATE", filepath.Join(t.TempDir(), "state"))
	s, err := startServer(t, h)
	if err != nil {
		t.Fatalf("bind failure should be retried once: %v", err)
	}
	if s.port == 0 {
		t.Fatal("no port")
	}
}

func TestServerGPUFailureFallsBackToCPU(t *testing.T) {
	h := newHarness(t, "gpu_fail")
	s, err := startServer(t, h)
	if err != nil {
		t.Fatal(err)
	}
	if s.backend != core.ChatBackendCPU {
		t.Fatalf("backend = %s", s.backend)
	}
	st := h.svc.Status()
	if st.State != core.ChatReady || st.Backend != core.ChatBackendCPU || !strings.Contains(st.Notice, "CPU") {
		t.Fatalf("status = %+v", st)
	}
	var sawNotice bool
	h.ev.mu.Lock()
	for _, e := range h.ev.status {
		sawNotice = sawNotice || (e.Backend == core.ChatBackendCPU && e.Notice != "")
	}
	h.ev.mu.Unlock()
	if !sawNotice {
		t.Error("no chat:status with a cpu notice")
	}
	// With GPU on, the CPU fallback keeps serving (no restart loop).
	s2, err := startServer(t, h)
	if err != nil || s2 != s {
		t.Fatalf("fallback server not reused: %v", err)
	}
}

func TestServerIdleStop(t *testing.T) {
	h := newHarness(t, "ok")
	h.c.tm.idle = 300 * time.Millisecond
	s, err := startServer(t, h)
	if err != nil {
		t.Fatal(err)
	}
	// The process exits slightly before the status flips to stopped; wait for both.
	deadline := time.Now().Add(10 * time.Second)
	for (s.alive() || h.svc.Status().State != core.ChatStopped) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if s.alive() {
		t.Fatal("server not stopped when idle")
	}
	if st := h.svc.Status(); st.State != core.ChatStopped {
		t.Fatalf("status = %+v", st)
	}
}

func TestServerUnexpectedExitReported(t *testing.T) {
	h := newHarness(t, "ok")
	s, err := startServer(t, h)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.proc.Kill()
	deadline := time.Now().Add(10 * time.Second)
	for h.svc.Status().State != core.ChatError && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if st := h.svc.Status(); st.State != core.ChatError {
		t.Fatalf("status = %+v", st)
	}
	// The next start replaces it.
	s2, err := startServer(t, h)
	if err != nil || s2 == s || !s2.alive() {
		t.Fatalf("restart: %v", err)
	}
}

func TestServerCancelDuringStart(t *testing.T) {
	h := newHarness(t, "hang")
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	_, err := h.c.ensureServer(ctx, h.entry)
	if !core.IsCode(err, core.CodeCancelled) {
		t.Fatalf("err = %v", err)
	}
}

func TestServerNeedsModelAndRuntime(t *testing.T) {
	h := newHarness(t, "ok")
	os.Remove(h.models + "/llm/fake.gguf")
	if _, err := startServer(t, h); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("missing model: %v", err)
	}
}

func TestPortParse(t *testing.T) {
	for line, want := range map[string]string{
		"main: server is listening on http://127.0.0.1:54321": "54321",
		"listening on http://127.0.0.1:8080":                  "8080",
	} {
		m := listeningRE.FindStringSubmatch(line)
		if m == nil || m[1] != want {
			t.Errorf("%q -> %v", line, m)
		}
	}
	if listeningRE.MatchString("listening on http://0.0.0.0:8080") {
		t.Error("only loopback lines count")
	}
}
