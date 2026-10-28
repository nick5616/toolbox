package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

// Tunables (SPEC §4.4). The Manager copies them into injectable fields.
const (
	defaultReadyTimeout = 90 * time.Second
	defaultCancelGrace  = 3 * time.Second
	defaultStopGrace    = 5 * time.Second
	defaultIdleTimeout  = 10 * time.Minute
	defaultRecycleBytes = int64(3) << 30
	defaultCrashWindow  = 2 * time.Minute
	defaultFailFast     = 60 * time.Second

	// EnvIdle overrides the idle shutdown timeout (a dev aid), e.g. "30s".
	EnvIdle = "TOOLBOX_SIDECAR_IDLE"

	// proc's line reader truncates lines at 1 MiB; a line that long was cut
	// short and can no longer be parsed.
	truncatedLine = 1 << 20

	repairHint = "Repair it in Settings → Dependencies"
)

var defaultBackoffs = []time.Duration{0, 2 * time.Second, 5 * time.Second, 15 * time.Second}

var idPrefix = regexp.MustCompile(`^\{"id":"([^"\\]*)"`)

type exitReason int

const (
	reasonCrash exitReason = iota // unexpected
	reasonStop
	reasonIdle
	reasonRecycle
	reasonRestart // killed after a cancel that wasn't honoured
)

// Manager owns the engine process. It implements Caller.
type Manager struct {
	paths  core.Paths
	python func() (string, error)
	em     core.Emitter

	// Injectable for tests.
	command      func(python string) (path string, args []string)
	extraEnv     []string
	ffmpeg       func() (string, error) // resolves the ffmpeg binary; its folder goes first on PATH
	readyTimeout time.Duration
	cancelGrace  time.Duration
	stopGrace    time.Duration
	idleTimeout  time.Duration // 0 disables
	recycleBytes int64
	backoffs     []time.Duration
	crashWindow  time.Duration
	failFast     time.Duration
	warmup       bool
	now          func() time.Time

	mu        sync.Mutex
	cur       *instance
	crashes   []time.Time
	failUntil time.Time
}

var _ Caller = (*Manager)(nil)

// NewManager builds a manager. python resolves the venv interpreter (or
// returns a CodeDependencyMissing error when the engine isn't installed).
func NewManager(p core.Paths, python func() (string, error), em core.Emitter) *Manager {
	if em == nil {
		em = core.NopEmitter{}
	}
	m := &Manager{
		paths: p, python: python, em: em,
		command: func(py string) (string, []string) {
			return py, []string{"-u", "-X", "utf8", "-m", "toolbox_sidecar"}
		},
		readyTimeout: defaultReadyTimeout,
		cancelGrace:  defaultCancelGrace,
		stopGrace:    defaultStopGrace,
		idleTimeout:  defaultIdleTimeout,
		recycleBytes: defaultRecycleBytes,
		backoffs:     defaultBackoffs,
		crashWindow:  defaultCrashWindow,
		failFast:     defaultFailFast,
		warmup:       true,
		now:          time.Now,
	}
	if v := os.Getenv(EnvIdle); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			m.idleTimeout = d
		}
	}
	return m
}

// SetFFmpegResolver sets the function that finds the ffmpeg binary; when it
// succeeds, the binary's folder is put first on the engine's PATH (pydub
// looks for ffmpeg there; SPEC.md §7.6). Call before the engine starts.
func (m *Manager) SetFFmpegResolver(resolve func() (string, error)) {
	m.mu.Lock()
	m.ffmpeg = resolve
	m.mu.Unlock()
}

// enginePath returns PATH with dir first.
func enginePath(dir, current string) string {
	if current == "" {
		return dir
	}
	return dir + string(os.PathListSeparator) + current
}

func (m *Manager) env() []string {
	py := filepath.Join(m.paths.CacheDir, "py")
	env := []string{
		"PYTHONUNBUFFERED=1",
		"PYTHONIOENCODING=utf-8",
		"TQDM_DISABLE=0",
		"NUMBA_CACHE_DIR=" + filepath.Join(m.paths.CacheDir, "numba"),
		"TOOLBOX_MODELS_DIR=" + m.paths.ModelsDir,
		"HF_HOME=" + py,
		"TORCH_HOME=" + py,
		"XDG_CACHE_HOME=" + py,
		"NO_COLOR=1",
	}
	if m.ffmpeg != nil {
		if exe, err := m.ffmpeg(); err == nil && exe != "" {
			env = append(env, "PATH="+enginePath(filepath.Dir(exe), os.Getenv("PATH")))
		}
	}
	return append(env, m.extraEnv...)
}

// ---- errors ---------------------------------------------------------------

func errStopped() error {
	return core.Errorf(core.CodeToolFailed, "The AI engine stopped unexpectedly").
		WithHint("Retry the job; details are in the app log")
}

func errRestarted() error {
	return core.Errorf(core.CodeToolFailed, "The AI engine was restarted").
		WithHint("Retry the job")
}

func errShutDown() error {
	return core.Errorf(core.CodeToolFailed, "The AI engine was stopped").
		WithHint("Retry the job")
}

func errTooLarge() error {
	return core.Errorf(core.CodeToolFailed, "The AI engine sent a reply that was too large").
		WithHint("Retry the job; details are in the app log")
}

func exitError(r exitReason) error {
	switch r {
	case reasonRestart:
		return errRestarted()
	case reasonStop, reasonIdle, reasonRecycle:
		return errShutDown()
	}
	return errStopped()
}

func lastLines(lines []string, n int) []string {
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

func errNoStart(tail []string) error {
	e := core.Errorf(core.CodeToolFailed, "The AI engine didn't start").WithHint(repairHint)
	if len(tail) > 0 {
		e.Err = errors.New(strings.Join(lastLines(tail, 20), "\n"))
	}
	return e
}

func errKeepsFailing() error {
	return core.Errorf(core.CodeToolFailed, "The AI engine keeps stopping").WithHint(repairHint)
}

// ---- wire format ----------------------------------------------------------

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

type wireMsg struct {
	ID     string          `json:"id"`
	Event  string          `json:"event"`
	Data   json.RawMessage `json:"data"`
	Result json.RawMessage `json:"result"`
	Error  *wireError      `json:"error"`
}

func mapError(w *wireError) error {
	code := core.ErrorCode(w.Code)
	switch code {
	case core.CodeValidation, core.CodeToolFailed, core.CodeCancelled, core.CodeInternal,
		core.CodeDependencyMissing, core.CodeNotFound, core.CodeConflict:
	default:
		code = core.CodeInternal
	}
	msg := w.Message
	if msg == "" {
		msg = "The AI engine reported an error"
	}
	return &core.AppError{Code: code, Message: msg, Hint: w.Hint}
}

// ---- per-call queue --------------------------------------------------------

type item struct {
	ev    *Event
	final bool
	res   json.RawMessage
	err   error
}

// call is one in-flight request. Events and the final outcome are queued in
// arrival order and consumed by the calling goroutine.
type call struct {
	id       string
	internal bool // warmup: ignored for idle/recycle accounting

	mu       sync.Mutex
	q        []item
	finished bool
	wake     chan struct{}
}

func newCall(id string, internal bool) *call {
	return &call{id: id, internal: internal, wake: make(chan struct{}, 1)}
}

func (c *call) push(it item) {
	c.mu.Lock()
	if c.finished {
		c.mu.Unlock()
		return
	}
	if it.final {
		c.finished = true
	}
	c.q = append(c.q, it)
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *call) drain() []item {
	c.mu.Lock()
	q := c.q
	c.q = nil
	c.mu.Unlock()
	return q
}

// ---- process instance ------------------------------------------------------

type instance struct {
	m         *Manager
	p         atomic.Pointer[proc.Process]
	started   chan struct{} // closed once p is set
	cancel    context.CancelFunc
	startedAt time.Time

	readyCh   chan struct{}
	readyOnce sync.Once
	readyErr  error
	done      chan struct{} // closed after exit handling is complete

	wmu sync.Mutex // serialises stdin writes

	mu         sync.Mutex
	calls      map[string]*call
	active     int
	ready      bool
	dead       bool
	draining   bool
	reason     exitReason
	recycle    bool
	rss        int64
	pid        int
	idle       *time.Timer
	readyTimer *time.Timer
	killTimer  *time.Timer
}

func (i *instance) closeReady(err error) {
	i.readyOnce.Do(func() {
		i.readyErr = err
		close(i.readyCh)
	})
}

func (i *instance) write(line []byte) error {
	<-i.started
	p := i.p.Load()
	if p == nil {
		return errStopped()
	}
	i.wmu.Lock()
	defer i.wmu.Unlock()
	_, err := p.Stdin().Write(append(line, '\n'))
	return err
}

func (i *instance) hardKill() {
	<-i.started
	i.cancel()
	if p := i.p.Load(); p != nil {
		_ = p.Kill()
	}
}

// kill force-kills the process; later calls start a fresh one.
func (i *instance) kill(r exitReason) {
	i.mu.Lock()
	if !i.dead && !i.draining {
		i.reason = r
	}
	i.draining = true
	i.mu.Unlock()
	i.hardKill()
}

// shutdown asks the process to exit ($shutdown), killing it after stopGrace.
func (i *instance) shutdown(r exitReason) {
	i.mu.Lock()
	if i.dead || i.draining {
		i.mu.Unlock()
		return
	}
	i.draining = true
	i.reason = r
	if i.idle != nil {
		i.idle.Stop()
	}
	i.killTimer = time.AfterFunc(i.m.stopGrace, i.hardKill)
	i.mu.Unlock()
	if err := i.write([]byte(`{"id":"","method":"$shutdown"}`)); err != nil {
		i.hardKill()
	}
}

func (i *instance) register(c *call) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.dead || i.draining {
		return false
	}
	i.calls[c.id] = c
	if !c.internal {
		i.active++
		if i.idle != nil {
			i.idle.Stop()
		}
	}
	return true
}

func (i *instance) finish(c *call) {
	i.mu.Lock()
	if _, ok := i.calls[c.id]; !ok {
		i.mu.Unlock()
		return
	}
	delete(i.calls, c.id)
	if c.internal {
		i.mu.Unlock()
		return
	}
	i.active--
	if i.active == 0 && !i.dead && !i.draining {
		if i.recycle {
			i.mu.Unlock()
			i.shutdown(reasonRecycle)
			return
		}
		i.resetIdleLocked()
	}
	i.mu.Unlock()
}

func (i *instance) resetIdleLocked() {
	if i.m.idleTimeout <= 0 || !i.ready {
		return
	}
	if i.idle != nil {
		i.idle.Stop()
	}
	i.idle = time.AfterFunc(i.m.idleTimeout, i.idleFire)
}

func (i *instance) idleFire() {
	i.mu.Lock()
	ok := i.active == 0 && !i.dead && !i.draining
	i.mu.Unlock()
	if ok {
		slog.Info("AI engine idle; shutting down", "component", "sidecar")
		i.shutdown(reasonIdle)
	}
}

func (i *instance) markReady(data json.RawMessage) {
	var d struct {
		Pid int `json:"pid"`
	}
	_ = json.Unmarshal(data, &d)
	i.mu.Lock()
	if i.ready || i.dead {
		i.mu.Unlock()
		return
	}
	i.ready = true
	i.pid = d.Pid
	if i.readyTimer != nil {
		i.readyTimer.Stop()
	}
	if i.active == 0 {
		i.resetIdleLocked()
	}
	i.mu.Unlock()
	i.closeReady(nil)
	if i.m.warmup {
		i.startWarmup()
	}
}

func (i *instance) startWarmup() {
	c := newCall(core.NewID(), true)
	if !i.register(c) {
		return
	}
	line, _ := json.Marshal(request{ID: c.id, Method: "system.warmup"})
	if err := i.write(line); err != nil {
		i.finish(c)
		return
	}
	go func() {
		defer i.finish(c)
		for {
			select {
			case <-c.wake:
				for _, it := range c.drain() {
					if it.final {
						return
					}
				}
			case <-i.done:
				return
			}
		}
	}()
}

// onLine handles one stdout line.
func (i *instance) onLine(line string) {
	if len(line) >= truncatedLine {
		if mm := idPrefix.FindStringSubmatch(line); mm != nil {
			i.mu.Lock()
			c := i.calls[mm[1]]
			i.mu.Unlock()
			if c != nil {
				slog.Warn("AI engine sent an oversized line", "component", "sidecar", "id", mm[1])
				c.push(item{final: true, err: errTooLarge()})
				return
			}
		}
		slog.Warn("AI engine sent an oversized line; ignored", "component", "sidecar")
		return
	}
	var msg wireMsg
	if err := json.Unmarshal([]byte(line), &msg); err != nil || (msg.Event == "" && msg.Result == nil && msg.Error == nil) {
		slog.Warn("non-protocol output from the AI engine", "component", "sidecar", "line", trimLog(line))
		return
	}
	if msg.Event == "ready" {
		i.markReady(msg.Data)
		return
	}
	i.mu.Lock()
	c := i.calls[msg.ID]
	i.mu.Unlock()
	if c == nil {
		return
	}
	switch {
	case msg.Error != nil:
		c.push(item{final: true, err: mapError(msg.Error)})
	case msg.Result != nil:
		var r struct {
			RSS int64 `json:"rssBytes"`
		}
		_ = json.Unmarshal(msg.Result, &r)
		if r.RSS > 0 {
			i.mu.Lock()
			i.rss = r.RSS
			if i.m.recycleBytes > 0 && r.RSS > i.m.recycleBytes {
				i.recycle = true
			}
			i.mu.Unlock()
		}
		c.push(item{final: true, res: msg.Result})
	default:
		if ev, ok := decodeEvent(msg); ok {
			c.push(item{ev: &ev})
		}
	}
}

func trimLog(s string) string {
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}

func decodeEvent(msg wireMsg) (Event, bool) {
	switch msg.Event {
	case "progress":
		var d struct {
			Pct *float64 `json:"pct"`
			Msg string   `json:"msg"`
		}
		if json.Unmarshal(msg.Data, &d) != nil {
			return Event{}, false
		}
		ev := Event{Kind: "progress", Pct: core.IndeterminateProgress, Msg: d.Msg}
		if d.Pct != nil {
			ev.Pct = *d.Pct
		}
		return ev, true
	case "log":
		var d struct{ Line, Level string }
		if json.Unmarshal(msg.Data, &d) != nil {
			return Event{}, false
		}
		return Event{Kind: "log", Line: d.Line, Level: d.Level}, true
	case "output":
		var d struct{ Path string }
		if json.Unmarshal(msg.Data, &d) != nil {
			return Event{}, false
		}
		return Event{Kind: "output", Path: d.Path}, true
	}
	return Event{}, false
}

// onExit runs once, after the process has exited and output is flushed.
func (i *instance) onExit(res proc.Result) {
	i.mu.Lock()
	i.dead = true
	reason := i.reason
	wasReady := i.ready
	calls := make([]*call, 0, len(i.calls))
	for _, c := range i.calls {
		calls = append(calls, c)
	}
	for _, t := range []*time.Timer{i.idle, i.readyTimer, i.killTimer} {
		if t != nil {
			t.Stop()
		}
	}
	i.mu.Unlock()

	if !wasReady {
		i.closeReady(errNoStart(res.StderrTail))
	}
	err := exitError(reason)
	for _, c := range calls {
		c.push(item{final: true, err: err})
	}

	m := i.m
	m.mu.Lock()
	if m.cur == i {
		m.cur = nil
	}
	if reason == reasonCrash {
		now := m.now()
		m.crashes = append(m.crashes, now)
		slog.Warn("AI engine exited unexpectedly", "component", "sidecar", "exit", res.ExitCode)
	}
	m.mu.Unlock()
	close(i.done)
}

// ---- manager ---------------------------------------------------------------

func (m *Manager) startLocked() (*instance, error) {
	py, err := m.python()
	if err != nil {
		return nil, err
	}
	path, args := m.command(py)
	for _, d := range []string{"numba", "py"} {
		_ = os.MkdirAll(filepath.Join(m.paths.CacheDir, d), 0o755)
	}
	ctx, cancel := context.WithCancel(context.Background())
	inst := &instance{
		m: m, cancel: cancel, started: make(chan struct{}),
		readyCh: make(chan struct{}), done: make(chan struct{}),
		calls: map[string]*call{}, startedAt: m.now(),
	}
	p, err := proc.Start(ctx, proc.Spec{
		Path: path, Args: args, Dir: m.paths.SidecarDir, Env: m.env(),
		OnStdout: inst.onLine,
		OnStderr: func(line string) {
			slog.Info(line, "component", "sidecar")
		},
	})
	if err != nil {
		cancel()
		return nil, core.Errorf(core.CodeToolFailed, "The AI engine didn't start").
			WithHint(repairHint).WithCause(err)
	}
	inst.p.Store(p)
	close(inst.started)
	inst.mu.Lock()
	inst.readyTimer = time.AfterFunc(m.readyTimeout, func() {
		inst.mu.Lock()
		ok := !inst.ready && !inst.dead
		inst.mu.Unlock()
		if ok {
			slog.Warn("AI engine did not become ready", "component", "sidecar")
			inst.hardKill()
		}
	})
	inst.mu.Unlock()
	go func() {
		res, _ := p.Wait()
		inst.onExit(res)
		cancel()
	}()
	return inst, nil
}

// acquire returns a ready, usable instance, starting one if needed.
func (m *Manager) acquire(ctx context.Context) (*instance, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		m.mu.Lock()
		inst := m.cur
		if inst != nil {
			inst.mu.Lock()
			dead, draining := inst.dead, inst.draining
			inst.mu.Unlock()
			if !dead && !draining {
				m.mu.Unlock()
				select {
				case <-inst.readyCh:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				if inst.readyErr != nil {
					return nil, inst.readyErr
				}
				return inst, nil
			}
			m.mu.Unlock()
			select {
			case <-inst.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			continue
		}

		now := m.now()
		recent := m.crashes[:0]
		for _, t := range m.crashes {
			if now.Sub(t) < m.crashWindow {
				recent = append(recent, t)
			}
		}
		m.crashes = recent
		if n := len(recent); n > 0 {
			if n > len(m.backoffs) {
				if m.failUntil.IsZero() {
					m.failUntil = recent[n-1].Add(m.failFast)
				}
				if now.Before(m.failUntil) {
					m.mu.Unlock()
					return nil, errKeepsFailing()
				}
				m.crashes, m.failUntil = nil, time.Time{}
			} else if wait := recent[n-1].Add(m.backoffs[n-1]).Sub(now); wait > 0 {
				m.mu.Unlock()
				t := time.NewTimer(wait)
				select {
				case <-t.C:
				case <-ctx.Done():
					t.Stop()
					return nil, ctx.Err()
				}
				continue
			}
		}
		inst, err := m.startLocked()
		if err != nil {
			m.mu.Unlock()
			return nil, err
		}
		m.cur = inst
		m.mu.Unlock()
	}
}

// Call implements Caller, starting the engine on first use.
func (m *Manager) Call(ctx context.Context, method string, params any, onEvent func(Event)) (json.RawMessage, error) {
	if _, err := m.python(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	req := request{ID: core.NewID(), Method: method}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return nil, core.Errorf(core.CodeInternal, "Couldn't encode the request").WithCause(err)
		}
		req.Params = raw
	}
	line, err := json.Marshal(req)
	if err != nil {
		return nil, core.Errorf(core.CodeInternal, "Couldn't encode the request").WithCause(err)
	}
	for {
		inst, err := m.acquire(ctx)
		if err != nil {
			return nil, err
		}
		c := newCall(req.ID, false)
		if !inst.register(c) {
			continue
		}
		if err := inst.write(line); err != nil {
			inst.finish(c)
			return nil, fmt.Errorf("write to the AI engine: %w", errStopped())
		}
		return m.await(ctx, inst, c, onEvent)
	}
}

func (m *Manager) await(ctx context.Context, inst *instance, c *call, onEvent func(Event)) (json.RawMessage, error) {
	defer inst.finish(c)
	for {
		select {
		case <-c.wake:
			for _, it := range c.drain() {
				if it.final {
					return it.res, it.err
				}
				if onEvent != nil && it.ev != nil {
					onEvent(*it.ev)
				}
			}
		case <-ctx.Done():
			return m.cancelCall(ctx, inst, c)
		}
	}
}

// cancelCall sends $cancel and waits for the reply; if it doesn't come in
// time the process is killed (a model can't be stopped mid-run).
func (m *Manager) cancelCall(ctx context.Context, inst *instance, c *call) (json.RawMessage, error) {
	cl, _ := json.Marshal(request{ID: c.id, Method: "$cancel"})
	_ = inst.write(cl)
	t := time.NewTimer(m.cancelGrace)
	defer t.Stop()
	for {
		select {
		case <-c.wake:
			for _, it := range c.drain() {
				if !it.final {
					continue
				}
				if it.err == nil {
					return it.res, nil
				}
				var ae *core.AppError
				if errors.As(it.err, &ae) && ae.Code == core.CodeCancelled {
					cp := *ae
					cp.Err = ctx.Err()
					return nil, &cp
				}
				return nil, it.err
			}
		case <-t.C:
			slog.Warn("AI engine ignored cancel; restarting", "component", "sidecar")
			inst.kill(reasonRestart)
			return nil, ctx.Err()
		}
	}
}

// Stop shuts the engine down ($shutdown, then kill after 5 s). Safe to call
// when it isn't running.
func (m *Manager) Stop() error {
	m.mu.Lock()
	inst := m.cur
	m.mu.Unlock()
	if inst == nil {
		return nil
	}
	inst.shutdown(reasonStop)
	<-inst.done
	return nil
}

// Status reports the engine process state.
func (m *Manager) Status() Status {
	m.mu.Lock()
	inst := m.cur
	m.mu.Unlock()
	if inst == nil {
		return Status{}
	}
	inst.mu.Lock()
	defer inst.mu.Unlock()
	if inst.dead {
		return Status{}
	}
	pid := inst.pid
	if p := inst.p.Load(); p != nil && p.Pid() != 0 {
		pid = p.Pid()
	}
	return Status{Running: true, Pid: pid, RSSBytes: inst.rss, StartedAt: inst.startedAt.UnixMilli()}
}
