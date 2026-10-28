package exif

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

const (
	// idleTimeout is how long an unused ExifTool process is kept alive.
	idleTimeout = 5 * time.Minute
	// closeGrace is how long Close waits for a graceful -stay_open False.
	closeGrace = 2 * time.Second
	// maxPending caps buffered output lines per process (runaway guard).
	maxPending = 1 << 20
)

// session is the long-lived `exiftool -stay_open True -@ -` process
// (SPEC.md §6.1). Safe for concurrent use; commands are serialised.
type session struct {
	exe  func() (string, error)
	idle time.Duration // injectable for tests

	mu    sync.Mutex // serialises Exec / lifecycle
	sp    *sproc
	seq   int
	timer *time.Timer
	cur   atomic.Pointer[sproc] // lets Close interrupt a running Exec
}

// ExecError is returned by Exec when ExifTool reported errors on stderr.
// The command's stdout is still returned alongside it.
type ExecError struct {
	Stderr string
}

func (e *ExecError) Error() string { return "exiftool: " + e.Stderr }

// sproc is one running ExifTool process and its buffered output.
type sproc struct {
	p   *proc.Process
	sig chan struct{}

	mu     sync.Mutex
	out    []string
	errOut []string
}

func newSession(exe func() (string, error)) *session {
	return &session{exe: exe, idle: idleTimeout}
}

func (sp *sproc) push(isErr bool, line string) {
	sp.mu.Lock()
	if len(sp.out)+len(sp.errOut) < maxPending {
		if isErr {
			sp.errOut = append(sp.errOut, line)
		} else {
			sp.out = append(sp.out, line)
		}
	}
	sp.mu.Unlock()
	select {
	case sp.sig <- struct{}{}:
	default:
	}
}

func (s *session) start() (*sproc, error) {
	path, err := s.exe()
	if err != nil {
		return nil, err
	}
	sp := &sproc{sig: make(chan struct{}, 1)}
	p, err := proc.Start(context.Background(), proc.Spec{
		Path:     path,
		Args:     []string{"-charset", "filename=utf8", "-stay_open", "True", "-@", "-"},
		OnStdout: func(l string) { sp.push(false, l) },
		OnStderr: func(l string) { sp.push(true, l) },
	})
	if err != nil {
		return nil, core.Errorf(core.CodeToolFailed, "Couldn't start ExifTool").WithCause(err)
	}
	sp.p = p
	return sp, nil
}

func (sp *sproc) alive() bool {
	select {
	case <-sp.p.Done():
		return false
	default:
		return true
	}
}

// drop discards the current process (killing it). Caller holds s.mu.
func (s *session) drop() {
	if s.sp != nil {
		_ = s.sp.p.Kill()
		s.sp = nil
		s.cur.Store(nil)
	}
}

// Exec runs one command (args, one per ExifTool argument) and returns its
// stdout. If ExifTool wrote errors to stderr, the error is an *ExecError and
// stdout is still returned. Cancelling ctx kills the process; the next call
// starts a fresh one.
func (s *session) Exec(ctx context.Context, args ...string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
	}
	defer s.armIdle()

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if s.sp != nil && !s.sp.alive() {
			s.drop()
		}
		fresh := false
		if s.sp == nil {
			sp, err := s.start()
			if err != nil {
				return "", err
			}
			s.sp, fresh = sp, true
			s.cur.Store(sp)
		}
		out, stderr, retry, err := s.run(ctx, s.sp, args)
		if err != nil {
			lastErr = err
			s.drop()
			if retry && !fresh && ctx.Err() == nil {
				continue // the idle process had died; retry on a new one
			}
			return "", err
		}
		if e := errorLines(stderr); e != "" {
			return out, &ExecError{Stderr: e}
		}
		return out, nil
	}
	return "", lastErr
}

// run writes one command and waits for its sentinels on stdout and stderr.
// retry is true when the write failed before ExifTool saw the command.
func (s *session) run(ctx context.Context, sp *sproc, args []string) (stdout, stderr string, retry bool, err error) {
	s.seq++
	n := strconv.Itoa(s.seq)
	ready := "{ready" + n + "}"

	sp.mu.Lock()
	sp.out, sp.errOut = nil, nil
	sp.mu.Unlock()

	var b strings.Builder
	for _, a := range args {
		if strings.ContainsAny(a, "\r\n") {
			return "", "", false, fmt.Errorf("exiftool argument contains a newline: %q", a)
		}
		b.WriteString(a)
		b.WriteByte('\n')
	}
	// -echo4 prints the sentinel on stderr once the command is done, so
	// stderr is delimited per command just like stdout ({ready<N>}).
	b.WriteString("-echo4\n" + ready + "\n-execute" + n + "\n")
	if _, werr := sp.p.Stdin().Write([]byte(b.String())); werr != nil {
		return "", "", true, fmt.Errorf("writing to ExifTool: %w", werr)
	}

	for {
		sp.mu.Lock()
		oi, ei := indexOf(sp.out, ready), indexOf(sp.errOut, ready)
		if oi >= 0 && ei >= 0 {
			stdout = strings.Join(sp.out[:oi], "\n")
			stderr = strings.Join(sp.errOut[:ei], "\n")
			sp.out, sp.errOut = nil, nil
			sp.mu.Unlock()
			return stdout, stderr, false, nil
		}
		sp.mu.Unlock()
		select {
		case <-sp.sig:
		case <-ctx.Done():
			return "", "", false, ctx.Err()
		case <-sp.p.Done():
			// Output may have raced the exit; look once more.
			sp.mu.Lock()
			oi, ei = indexOf(sp.out, ready), indexOf(sp.errOut, ready)
			done := oi >= 0 && ei >= 0
			tail := append([]string(nil), sp.errOut...)
			sp.mu.Unlock()
			if done {
				continue
			}
			msg := strings.TrimSpace(strings.Join(tail, "\n"))
			if msg == "" {
				msg = "the process exited"
			}
			return "", "", false, core.Errorf(core.CodeToolFailed, "ExifTool stopped unexpectedly").
				WithCause(errors.New(msg))
		}
	}
}

func indexOf(lines []string, want string) int {
	for i, l := range lines {
		if l == want {
			return i
		}
	}
	return -1
}

// errorLines returns the "Error: ..." lines of ExifTool's stderr.
func errorLines(stderr string) string {
	var errs []string
	for _, l := range strings.Split(stderr, "\n") {
		if strings.HasPrefix(l, "Error") {
			errs = append(errs, strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(l, "Error:"), "Error")))
		}
	}
	return strings.Join(errs, "; ")
}

// armIdle schedules the idle shutdown. Caller holds s.mu.
func (s *session) armIdle() {
	if s.sp == nil || s.idle <= 0 {
		return
	}
	if s.timer == nil {
		s.timer = time.AfterFunc(s.idle, s.idleClose)
	} else {
		s.timer.Reset(s.idle)
	}
}

func (s *session) idleClose() {
	if !s.mu.TryLock() {
		return // busy; Exec re-arms the timer when it finishes
	}
	defer s.mu.Unlock()
	s.stop()
}

// running reports whether a process is currently alive (tests).
func (s *session) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sp != nil && s.sp.alive()
}

// stop shuts the process down gracefully, killing it after closeGrace.
// Caller holds s.mu.
func (s *session) stop() {
	sp := s.sp
	if sp == nil {
		return
	}
	s.sp = nil
	s.cur.Store(nil)
	if sp.alive() {
		_, _ = sp.p.Stdin().Write([]byte("-stay_open\nFalse\n"))
		_ = sp.p.CloseStdin()
		select {
		case <-sp.p.Done():
			return
		case <-time.After(closeGrace):
		}
	}
	_ = sp.p.Kill()
}

// Close stops the process if running. A command in flight fails.
func (s *session) Close() {
	if !s.mu.TryLock() {
		if sp := s.cur.Load(); sp != nil {
			_ = sp.p.Kill()
		}
		s.mu.Lock()
	}
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
	}
	s.stop()
}
