package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

func newTestManager(t *testing.T, mode string, mods ...func(*Manager)) *Manager {
	t.Helper()
	p := core.NewPaths(t.TempDir())
	if err := os.MkdirAll(p.SidecarDir, 0o755); err != nil {
		t.Fatal(err)
	}
	m := NewManager(p, func() (string, error) { return os.Args[0], nil }, nil)
	m.extraEnv = []string{"FAKE_SIDECAR=1", "FAKE_MODE=" + mode}
	m.readyTimeout = 10 * time.Second
	m.cancelGrace = 300 * time.Millisecond
	m.stopGrace = 2 * time.Second
	m.idleTimeout = 0
	m.backoffs = []time.Duration{0, 50 * time.Millisecond, 100 * time.Millisecond, 150 * time.Millisecond}
	m.crashWindow = time.Minute
	m.failFast = 500 * time.Millisecond
	for _, f := range mods {
		f(m)
	}
	t.Cleanup(func() { m.Stop() })
	return m
}

func ctx20(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

type reply struct {
	Pid int    `json:"pid"`
	Tag string `json:"tag"`
}

func must(t *testing.T, m *Manager, method string, params any) reply {
	t.Helper()
	res, err := m.Call(ctx20(t), method, params, nil)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	var r reply
	if err := json.Unmarshal(res, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func eventually(t *testing.T, d time.Duration, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestCallRoundTripAndStatus(t *testing.T) {
	m := newTestManager(t, "")
	if m.Status().Running {
		t.Fatal("running before first call")
	}
	r := must(t, m, "echo", map[string]any{"tag": "hi"})
	if r.Tag != "hi" || r.Pid == 0 {
		t.Fatalf("reply %+v", r)
	}
	st := m.Status()
	if !st.Running || st.Pid == 0 || st.StartedAt == 0 {
		t.Fatalf("status %+v", st)
	}
	if err := m.Stop(); err != nil {
		t.Fatal(err)
	}
	if m.Status().Running {
		t.Error("running after Stop")
	}
	// Lazy restart after Stop.
	if r2 := must(t, m, "ping", nil); r2.Pid == r.Pid {
		t.Error("expected a new process after Stop")
	}
	if err := m.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := m.Stop(); err != nil {
		t.Fatal(err)
	}
}

func TestDependencyMissing(t *testing.T) {
	p := core.NewPaths(t.TempDir())
	m := NewManager(p, func() (string, error) { return "", core.ErrDependencyMissing(DepID, "x") }, nil)
	_, err := m.Call(context.Background(), "echo", nil, nil)
	if !core.IsCode(err, core.CodeDependencyMissing) {
		t.Fatalf("err=%v", err)
	}
}

func TestMultiplexedOutOfOrder(t *testing.T) {
	m := newTestManager(t, "")
	must(t, m, "ping", nil) // start

	var mu sync.Mutex
	var order []string
	var wg sync.WaitGroup
	run := func(tag string, ms int) {
		defer wg.Done()
		res, err := m.Call(ctx20(t), "sleep", map[string]any{"ms": ms, "tag": tag}, nil)
		if err != nil {
			t.Errorf("%s: %v", tag, err)
			return
		}
		var r reply
		_ = json.Unmarshal(res, &r)
		if r.Tag != tag {
			t.Errorf("call %s got reply for %s", tag, r.Tag)
		}
		mu.Lock()
		order = append(order, tag)
		mu.Unlock()
	}
	wg.Add(3)
	go run("slow", 600)
	go run("mid", 300)
	time.Sleep(20 * time.Millisecond)
	go run("fast", 10)
	wg.Wait()
	if strings.Join(order, ",") != "fast,mid,slow" {
		t.Errorf("completion order %v", order)
	}
}

func TestEventsInOrder(t *testing.T) {
	m := newTestManager(t, "")
	const n = 300
	var evs []Event
	res, err := m.Call(ctx20(t), "events", map[string]any{"n": n}, func(e Event) { evs = append(evs, e) })
	if err != nil {
		t.Fatal(err)
	}
	if len(res) == 0 {
		t.Error("no result")
	}
	// n progress + n/10 logs + output + indeterminate progress
	if len(evs) != n+n/10+2 {
		t.Fatalf("got %d events", len(evs))
	}
	step := 0
	for _, e := range evs[:len(evs)-2] {
		if e.Kind == "progress" {
			step++
			if e.Msg != fmt.Sprintf("step %d", step) {
				t.Fatalf("out of order: %+v at step %d", e, step)
			}
		}
	}
	if o := evs[len(evs)-2]; o.Kind != "output" || o.Path != "/tmp/out.wav" {
		t.Errorf("output %+v", o)
	}
	if p := evs[len(evs)-1]; p.Kind != "progress" || p.Pct != -1 || p.Msg != "wrapping up" {
		t.Errorf("last %+v", p)
	}
	var logs int
	for _, e := range evs {
		if e.Kind == "log" && e.Level == "info" && strings.HasPrefix(e.Line, "log ") {
			logs++
		}
	}
	if logs != n/10 {
		t.Errorf("logs=%d", logs)
	}
}

func TestErrorMapping(t *testing.T) {
	m := newTestManager(t, "")
	tests := []struct {
		code string
		want core.ErrorCode
	}{
		{"tool_failed", core.CodeToolFailed},
		{"validation", core.CodeValidation},
		{"cancelled", core.CodeCancelled},
		{"internal", core.CodeInternal},
		{"weird", core.CodeInternal},
	}
	for _, tc := range tests {
		_, err := m.Call(ctx20(t), "fail", map[string]any{"code": tc.code, "msg": "Bad " + tc.code, "hint": "Try " + tc.code}, nil)
		ae := core.AsAppError(err)
		if err == nil || ae.Code != tc.want || ae.Message != "Bad "+tc.code || ae.Hint != "Try "+tc.code {
			t.Errorf("%s: %+v", tc.code, ae)
		}
	}
	// The process survives error replies.
	must(t, m, "ping", nil)
}

func TestCancelHonoured(t *testing.T) {
	m := newTestManager(t, "")
	pid := must(t, m, "ping", nil).Pid
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err := m.Call(ctx, "wait_cancel", nil, nil)
	if !core.IsCode(err, core.CodeCancelled) || !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Error("cancel took too long")
	}
	if got := must(t, m, "ping", nil).Pid; got != pid {
		t.Error("process was restarted although the cancel was honoured")
	}
}

func TestCancelPreCancelledContext(t *testing.T) {
	m := newTestManager(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.Call(ctx, "ping", nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v", err)
	}
	if m.Status().Running {
		t.Error("started for a cancelled call")
	}
}

func TestCancelIgnoredHardKillsAndRestarts(t *testing.T) {
	m := newTestManager(t, "")
	pid := must(t, m, "ping", nil).Pid

	otherErr := make(chan error, 1)
	go func() {
		_, err := m.Call(ctx20(t), "sleep", map[string]any{"ms": 20000}, nil)
		otherErr <- err
	}()
	time.Sleep(100 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := m.Call(ctx, "ignore_cancel", nil, nil)
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("err=%v", err)
		}
		if d := time.Since(start); d < 250*time.Millisecond || d > 5*time.Second {
			t.Errorf("hard kill after %s", d)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancel did not return")
	}
	select {
	case err := <-otherErr:
		ae := core.AsAppError(err)
		if ae.Code != core.CodeToolFailed || ae.Message != "The audio engine was restarted" {
			t.Errorf("other call: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("other call hung")
	}
	if got := must(t, m, "ping", nil).Pid; got == pid {
		t.Error("expected a fresh process after the hard kill")
	}
}

func TestCrashFailsInFlightThenRestartsWithBackoff(t *testing.T) {
	m := newTestManager(t, "")
	must(t, m, "ping", nil)

	other := make(chan error, 1)
	go func() {
		_, err := m.Call(ctx20(t), "sleep", map[string]any{"ms": 20000}, nil)
		other <- err
	}()
	time.Sleep(100 * time.Millisecond)

	check := func(err error) {
		t.Helper()
		ae := core.AsAppError(err)
		if err == nil || ae.Code != core.CodeToolFailed || ae.Message != "The audio engine stopped unexpectedly" || ae.Hint == "" {
			t.Fatalf("err=%v", err)
		}
	}
	_, err := m.Call(ctx20(t), "crash", nil, nil)
	check(err)
	select {
	case err := <-other:
		check(err)
	case <-time.After(10 * time.Second):
		t.Fatal("in-flight call hung")
	}

	// Crashes 2..5 are restarted with growing backoff (0, 50, 100, 150 ms).
	start := time.Now()
	for i := 0; i < 4; i++ {
		_, err := m.Call(ctx20(t), "crash", nil, nil)
		check(err)
	}
	if d := time.Since(start); d < 300*time.Millisecond {
		t.Errorf("backoff not applied: %s", d)
	}
	// Too many crashes: fail fast.
	start = time.Now()
	_, err = m.Call(ctx20(t), "ping", nil, nil)
	if ae := core.AsAppError(err); err == nil || ae.Code != core.CodeToolFailed || ae.Message != "The audio engine keeps stopping" {
		t.Fatalf("err=%v", err)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Error("fail-fast was slow")
	}
	time.Sleep(600 * time.Millisecond)
	must(t, m, "ping", nil)
}

func TestHandshakeTimeout(t *testing.T) {
	m := newTestManager(t, "never_ready", func(m *Manager) { m.readyTimeout = 300 * time.Millisecond })
	start := time.Now()
	_, err := m.Call(ctx20(t), "ping", nil, nil)
	ae := core.AsAppError(err)
	if err == nil || ae.Code != core.CodeToolFailed || ae.Message != "The audio engine didn't start" || ae.Hint != "Repair it in Settings → Dependencies" {
		t.Fatalf("err=%v", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Error("slow")
	}
	if m.Status().Running {
		t.Error("still running")
	}
}

func TestEarlyExitIncludesStderr(t *testing.T) {
	m := newTestManager(t, "exit_early")
	_, err := m.Call(ctx20(t), "ping", nil, nil)
	ae := core.AsAppError(err)
	if err == nil || ae.Message != "The audio engine didn't start" || ae.Err == nil ||
		!strings.Contains(ae.Err.Error(), "boom line one") || !strings.Contains(ae.Err.Error(), "boom line two") {
		t.Fatalf("err=%v", err)
	}
}

func TestIdleShutdown(t *testing.T) {
	m := newTestManager(t, "", func(m *Manager) { m.idleTimeout = 300 * time.Millisecond })
	pid := must(t, m, "ping", nil).Pid
	if !m.Status().Running {
		t.Fatal("not running")
	}
	eventually(t, 5*time.Second, "idle shutdown", func() bool { return !m.Status().Running })
	if got := must(t, m, "ping", nil).Pid; got == pid {
		t.Error("expected a new process after idle shutdown")
	}
}

func TestIdleDoesNotInterruptLongCall(t *testing.T) {
	m := newTestManager(t, "", func(m *Manager) { m.idleTimeout = 200 * time.Millisecond })
	r := must(t, m, "sleep", map[string]any{"ms": 800, "tag": "long"})
	if r.Tag != "long" {
		t.Fatalf("%+v", r)
	}
}

func TestIdleEnvOverride(t *testing.T) {
	t.Setenv(EnvIdle, "45s")
	m := NewManager(core.NewPaths(t.TempDir()), nil, nil)
	if m.idleTimeout != 45*time.Second {
		t.Errorf("idle=%s", m.idleTimeout)
	}
	t.Setenv(EnvIdle, "")
	if m := NewManager(core.NewPaths(t.TempDir()), nil, nil); m.idleTimeout != 10*time.Minute {
		t.Errorf("default idle=%s", m.idleTimeout)
	}
}

func TestRecycleAfterHugeRSS(t *testing.T) {
	m := newTestManager(t, "", func(m *Manager) { m.recycleBytes = 3 << 30 })
	pid := must(t, m, "ping", nil).Pid

	// Another call is in flight: the recycle waits for it.
	other := make(chan reply, 1)
	go func() {
		other <- must(t, m, "sleep", map[string]any{"ms": 500, "tag": "other"})
	}()
	time.Sleep(100 * time.Millisecond)
	must(t, m, "big", nil)
	if !m.Status().Running {
		t.Error("recycled while another call was in flight")
	}
	select {
	case r := <-other:
		if r.Tag != "other" {
			t.Errorf("%+v", r)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("other call hung")
	}
	eventually(t, 5*time.Second, "recycle", func() bool { return !m.Status().Running })
	if got := must(t, m, "ping", nil).Pid; got == pid {
		t.Error("expected a new process after recycling")
	}
	// Below the threshold nothing is recycled.
	pid = must(t, m, "ping", nil).Pid
	time.Sleep(200 * time.Millisecond)
	if got := must(t, m, "ping", nil).Pid; got != pid {
		t.Error("recycled below the threshold")
	}
}

func TestGarbageStdoutIgnored(t *testing.T) {
	for _, mode := range []string{"", "garbage_first"} {
		m := newTestManager(t, mode)
		r := must(t, m, "garbage", map[string]any{"tag": "ok"})
		if r.Tag != "ok" {
			t.Errorf("mode %q: %+v", mode, r)
		}
	}
}

func TestHugeLineErrorsInsteadOfHanging(t *testing.T) {
	m := newTestManager(t, "")
	pid := must(t, m, "ping", nil).Pid
	start := time.Now()
	_, err := m.Call(ctx20(t), "huge", map[string]any{"bytes": 17 << 20}, nil)
	ae := core.AsAppError(err)
	if err == nil || ae.Code != core.CodeToolFailed || !strings.Contains(ae.Message, "too large") {
		t.Fatalf("err=%v", err)
	}
	if time.Since(start) > 20*time.Second {
		t.Error("slow")
	}
	if got := must(t, m, "ping", nil).Pid; got != pid {
		t.Log("process restarted after the huge line (acceptable)")
	}
}

func TestStopKillsWhenShutdownIgnored(t *testing.T) {
	m := newTestManager(t, "no_shutdown", func(m *Manager) { m.stopGrace = 300 * time.Millisecond })
	must(t, m, "ping", nil)
	start := time.Now()
	if err := m.Stop(); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 250*time.Millisecond || d > 8*time.Second {
		t.Errorf("Stop took %s", d)
	}
	if m.Status().Running {
		t.Error("still running")
	}
}

func TestStopFailsInFlightCalls(t *testing.T) {
	m := newTestManager(t, "")
	must(t, m, "ping", nil)
	errc := make(chan error, 1)
	go func() {
		_, err := m.Call(ctx20(t), "sleep", map[string]any{"ms": 20000}, nil)
		errc <- err
	}()
	time.Sleep(100 * time.Millisecond)
	_ = m.Stop()
	select {
	case err := <-errc:
		if !core.IsCode(err, core.CodeToolFailed) {
			t.Errorf("err=%v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("hung")
	}
}

func TestConcurrentFirstCallsShareOneProcess(t *testing.T) {
	m := newTestManager(t, "")
	var wg sync.WaitGroup
	pids := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pids <- must(t, m, "ping", nil).Pid
		}()
	}
	wg.Wait()
	close(pids)
	first := 0
	for p := range pids {
		if first == 0 {
			first = p
		} else if p != first {
			t.Fatalf("pids %d and %d", first, p)
		}
	}
}
