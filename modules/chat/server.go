package chat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/proc"
)

// llama-server lifecycle (SPEC.md §4.1). At most one server runs. It binds
// 127.0.0.1 on a random port behind a random per-launch key; the port and key
// never leave this package.

var listeningRE = regexp.MustCompile(`listening on http://127\.0\.0\.1:(\d+)`)

// logRing keeps the last n log lines.
type logRing struct {
	mu    sync.Mutex
	n     int
	lines []string
}

func (r *logRing) add(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, line)
	if len(r.lines) > r.n {
		r.lines = r.lines[len(r.lines)-r.n:]
	}
}

func (r *logRing) tail(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n > len(r.lines) {
		n = len(r.lines)
	}
	return append([]string(nil), r.lines[len(r.lines)-n:]...)
}

// server is one running llama-server.
type server struct {
	proc    *proc.Process
	cancel  context.CancelFunc
	port    int
	key     string
	keyFile string
	model   string // catalog ID
	backend core.ChatBackend
	// Settings the server was started with; a change restarts it.
	ctxSize int
	gpu     bool
	logs    *logRing

	stopping bool // guarded by Chat.mu
}

func (s *server) base() string { return "http://127.0.0.1:" + strconv.Itoa(s.port) }

func (s *server) alive() bool {
	select {
	case <-s.proc.Done():
		return false
	default:
		return true
	}
}

// removeKey deletes the key file (idempotent).
func (s *server) removeKey() {
	if s.keyFile != "" {
		_ = os.Remove(s.keyFile)
	}
}

// launchError describes a failed start.
type launchError struct {
	tail      []string
	bindFail  bool
	gpuFail   bool
	timedOut  bool
	cancelled bool
	cause     error
}

func (e *launchError) Error() string {
	return fmt.Sprintf("llama-server failed to start (timeout=%v): %s", e.timedOut, strings.Join(e.tail, " | "))
}

func lowerContains(lines []string, subs ...string) bool {
	for _, l := range lines {
		l = strings.ToLower(l)
		for _, s := range subs {
			if strings.Contains(l, s) {
				return true
			}
		}
	}
	return false
}

func looksLikeGPUFailure(lines []string) bool {
	if lowerContains(lines, "erroroutofdevicememory", "out of memory", "failed to allocate", "vk::", "no vulkan", "vkcreate") {
		return true
	}
	for _, l := range lines {
		l = strings.ToLower(l)
		if strings.Contains(l, "vulkan") && (strings.Contains(l, "error") || strings.Contains(l, "fail")) {
			return true
		}
	}
	return false
}

// serverArgs builds the llama-server command line.
func serverArgs(modelPath, keyFile string, ctxSize int, gpu bool) []string {
	args := []string{
		"-m", modelPath, "--host", "127.0.0.1", "--port", "0", "--api-key-file", keyFile,
		"--jinja", "-c", strconv.Itoa(ctxSize), "--no-webui", "--sleep-idle-seconds", "300",
	}
	if gpu {
		return append(args, "-ngl", "99")
	}
	return append(args, "-ngl", "0", "--device", "none")
}

// newKey makes 32 random bytes as hex.
func newKey() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// launch starts llama-server once and waits until /health is 200.
func (c *Chat) launch(ctx context.Context, exe string, e catalogEntry, ctxSize int, gpu bool) (*server, *launchError) {
	key, err := newKey()
	if err != nil {
		return nil, &launchError{cause: err}
	}
	if err := os.MkdirAll(c.cfg.TmpDir, 0o755); err != nil {
		return nil, &launchError{cause: err}
	}
	keyFile := filepath.Join(c.cfg.TmpDir, "llama-"+core.NewID()+".key")
	if err := os.WriteFile(keyFile, []byte(key), 0o600); err != nil {
		return nil, &launchError{cause: err}
	}

	pctx, cancel := context.WithCancel(context.Background())
	s := &server{
		cancel: cancel, key: key, keyFile: keyFile, model: e.ID, ctxSize: ctxSize, gpu: gpu,
		backend: core.ChatBackendCPU, logs: &logRing{n: 200},
	}
	if gpu {
		s.backend = core.ChatBackendGPU
	}
	portCh := make(chan int, 1)
	var lmu sync.Mutex
	onLine := func(line string) {
		lmu.Lock()
		defer lmu.Unlock()
		s.logs.add(line)
		slog.Debug("llama-server", "line", line)
		if m := listeningRE.FindStringSubmatch(line); m != nil && s.port == 0 {
			if p, err := strconv.Atoi(m[1]); err == nil {
				s.port = p
				portCh <- p
			}
		}
	}
	p, err := proc.Start(pctx, proc.Spec{
		Path: exe, Args: serverArgs(c.modelPath(e), keyFile, ctxSize, gpu), Env: c.serverEnv,
		OnStdout: onLine, OnStderr: onLine,
	})
	if err != nil {
		cancel()
		s.removeKey()
		return nil, &launchError{cause: err, tail: []string{err.Error()}}
	}
	s.proc = p

	fail := func(le *launchError) (*server, *launchError) {
		_ = p.Kill()
		select {
		case <-p.Done():
		case <-time.After(c.tm.killGrace):
		}
		cancel()
		s.removeKey()
		le.tail = s.logs.tail(10)
		le.bindFail = lowerContains(le.tail, "couldn't bind")
		le.gpuFail = looksLikeGPUFailure(s.logs.tail(50))
		return nil, le
	}

	deadline := time.NewTimer(c.tm.ready)
	defer deadline.Stop()
	// 1. the listening line
	select {
	case <-portCh:
	case <-p.Done():
		return fail(&launchError{})
	case <-deadline.C:
		return fail(&launchError{timedOut: true})
	case <-ctx.Done():
		return fail(&launchError{cancelled: true})
	}
	// 2. /health
	tick := time.NewTicker(c.tm.poll)
	defer tick.Stop()
	for {
		if c.healthOK(ctx, s) {
			break
		}
		select {
		case <-tick.C:
		case <-p.Done():
			return fail(&launchError{})
		case <-deadline.C:
			return fail(&launchError{timedOut: true})
		case <-ctx.Done():
			return fail(&launchError{cancelled: true})
		}
	}
	s.removeKey() // the server has read it
	return s, nil
}

func (c *Chat) healthOK(ctx context.Context, s *server) bool {
	rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, s.base()+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := loopbackClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// ensureServer returns a ready server for e, starting (or restarting) it when
// needed. ctx cancels a start in progress.
func (c *Chat) ensureServer(ctx context.Context, e catalogEntry) (*server, error) {
	c.srvMu.Lock()
	defer c.srvMu.Unlock()
	st := c.cfg.Settings.Current().Chat
	c.touchIdle()

	c.mu.Lock()
	cur := c.srv
	c.mu.Unlock()
	if cur != nil {
		// Reuse it unless the model or context size changed, or GPU was turned
		// off. A server that fell back to CPU keeps serving while GPU is on.
		if cur.alive() && cur.model == e.ID && cur.ctxSize == st.ContextSize && (st.GPU || !cur.gpu) {
			return cur, nil
		}
		c.stopServerLocked(cur)
	}
	if !c.modelPresent(e.ID) {
		return nil, core.Errorf(core.CodeNotFound, "%s isn't downloaded yet", e.Label).WithHint("Download it from the model list")
	}
	exe, err := c.cfg.Resolve(deps.Llama)
	if err != nil {
		return nil, err
	}

	c.setStatus(core.ChatStatus{State: core.ChatStarting, Model: e.ID, Backend: backendFor(st.GPU)})
	gpu := st.GPU
	notice := ""
	bindRetried, cpuRetried := false, false
	var last *launchError
	for {
		s, le := c.launch(ctx, exe, e, st.ContextSize, gpu)
		if le == nil {
			c.mu.Lock()
			c.srv = s
			c.mu.Unlock()
			c.setStatus(core.ChatStatus{State: core.ChatReady, Model: e.ID, Backend: s.backend, Notice: notice})
			go c.watch(s)
			return s, nil
		}
		last = le
		if le.cancelled {
			c.setStatus(core.ChatStatus{State: core.ChatStopped})
			return nil, core.Errorf(core.CodeCancelled, "Cancelled").WithCause(ctx.Err())
		}
		if le.bindFail && !bindRetried {
			bindRetried = true
			continue
		}
		if gpu && le.gpuFail && !le.timedOut && !cpuRetried {
			cpuRetried, gpu = true, false
			notice = "The GPU ran out of memory, so answers run on the CPU"
			c.setStatus(core.ChatStatus{State: core.ChatStarting, Model: e.ID, Backend: core.ChatBackendCPU, Notice: notice})
			continue
		}
		break
	}
	msg := "The chat engine didn't start"
	if last.timedOut {
		msg = "The chat engine took too long to start"
	}
	appErr := core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(errors.New(strings.Join(last.tail, "\n")))
	if last.cause != nil {
		appErr.Err = last.cause
	}
	c.setStatus(core.ChatStatus{State: core.ChatError, Model: e.ID, Backend: backendFor(gpu), Error: msg})
	return nil, appErr
}

func backendFor(gpu bool) core.ChatBackend {
	if gpu {
		return core.ChatBackendGPU
	}
	return core.ChatBackendCPU
}

// watch reports an unexpected exit of s.
func (c *Chat) watch(s *server) {
	<-s.proc.Done()
	c.mu.Lock()
	expected := s.stopping
	if c.srv == s {
		c.srv = nil
		if !expected {
			c.mu.Unlock()
			c.setStatus(core.ChatStatus{State: core.ChatError, Model: s.model, Backend: s.backend,
				Error: "The chat engine stopped unexpectedly"})
			return
		}
	}
	c.mu.Unlock()
}

// stopServerLocked stops s; srvMu must be held.
func (c *Chat) stopServerLocked(s *server) {
	c.mu.Lock()
	s.stopping = true
	wasCurrent := c.srv == s
	if wasCurrent {
		c.srv = nil
	}
	c.mu.Unlock()
	_ = s.proc.Kill()
	select {
	case <-s.proc.Done():
	case <-time.After(c.tm.killGrace):
	}
	s.cancel()
	s.removeKey()
	if wasCurrent {
		c.setStatus(core.ChatStatus{State: core.ChatStopped})
	}
}

// stopServer stops the running server, if any.
func (c *Chat) stopServer() { c.stopServerIf(func(*server) bool { return true }) }

// stopServerIf stops the running server when match accepts it.
func (c *Chat) stopServerIf(match func(*server) bool) {
	c.srvMu.Lock()
	defer c.srvMu.Unlock()
	c.mu.Lock()
	s := c.srv
	if s != nil && match(s) && c.idleTimer != nil {
		c.idleTimer.Stop()
	}
	c.mu.Unlock()
	if s != nil && match(s) {
		c.stopServerLocked(s)
	}
}

// touchIdle (re)arms the idle timer: the server stops after tm.idle without
// requests, unless a generation is running.
func (c *Chat) touchIdle() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.idleTimer != nil {
		c.idleTimer.Stop()
	}
	c.idleTimer = time.AfterFunc(c.tm.idle, c.idleExpired)
}

func (c *Chat) idleExpired() {
	c.mu.Lock()
	busy := c.gen != nil
	c.mu.Unlock()
	if busy {
		c.touchIdle()
		return
	}
	c.stopServer()
}

// setStatus stores and emits the status. The Ollama note rides along.
func (c *Chat) setStatus(s core.ChatStatus) {
	c.mu.Lock()
	c.status = s
	out := c.statusLocked()
	c.mu.Unlock()
	c.cfg.Emitter.Emit(core.EventChatStatus, out)
}

func (c *Chat) statusLocked() core.ChatStatus {
	out := c.status
	out.Busy = ""
	if c.gen != nil && c.gen.background {
		out.Busy = c.gen.purpose
	}
	if out.Notice == "" {
		out.Notice = c.ollamaErr
	}
	return out
}
