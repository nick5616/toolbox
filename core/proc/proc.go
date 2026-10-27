// Package proc runs external tools with line-oriented output capture and
// whole-process-tree cancellation. Every subprocess the app starts must go
// through this package so that no console windows flash on Windows and no
// orphaned grandchildren (e.g. ffmpeg under yt-dlp) survive a cancel.
package proc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Spec describes a process to run.
type Spec struct {
	Path string
	Args []string
	Dir  string
	// Env is appended to os.Environ().
	Env []string
	// OnStdout/OnStderr are called once per line (split on \n, \r\n or a bare
	// \r), with the terminator removed. Empty lines are skipped. The two
	// callbacks may run concurrently with each other, never with themselves.
	OnStdout func(line string)
	OnStderr func(line string)
}

// Result describes a finished process.
type Result struct {
	ExitCode   int
	StderrTail []string // last StderrTailLines stderr lines
}

// StderrTailLines is how many trailing stderr lines Result keeps.
const StderrTailLines = 50

// killGrace is how long a process group gets between SIGTERM and SIGKILL.
const killGrace = 3 * time.Second

// waitDelay bounds how long Wait blocks on pipes after the process exits or
// is killed (e.g. when a grandchild still holds stdout open).
const waitDelay = 5 * time.Second

// Run starts s and waits for it. When ctx is cancelled the whole process tree
// is killed and the returned error wraps ctx.Err(). A non-zero exit returns an
// error wrapping *exec.ExitError, with Result.ExitCode set.
func Run(ctx context.Context, s Spec) (Result, error) {
	cmd := exec.CommandContext(ctx, s.Path, s.Args...)
	cmd.Dir = s.Dir
	cmd.Env = append(os.Environ(), s.Env...)
	configure(cmd)
	cmd.Cancel = func() error { return killTree(cmd) }
	cmd.WaitDelay = waitDelay

	tail := &tailBuffer{max: StderrTailLines}
	stdout := newLineWriter(s.OnStdout)
	stderr := newLineWriter(func(line string) {
		tail.add(line)
		if s.OnStderr != nil {
			s.OnStderr(line)
		}
	})
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		return Result{ExitCode: -1}, fmt.Errorf("start %s: %w", s.Path, err)
	}
	err := cmd.Wait()
	stdout.Flush()
	stderr.Flush()

	res := Result{ExitCode: -1, StderrTail: tail.lines()}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return res, fmt.Errorf("run %s: %w", s.Path, ctxErr)
	}
	if err != nil {
		return res, fmt.Errorf("run %s: %w", s.Path, err)
	}
	return res, nil
}

// Output runs a short command (e.g. "--version") and returns its combined
// stdout+stderr, trimmed. It is killed after timeout.
func Output(ctx context.Context, timeout time.Duration, path string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var mu sync.Mutex
	var buf strings.Builder
	collect := func(line string) {
		mu.Lock()
		defer mu.Unlock()
		if buf.Len() > 0 {
			buf.WriteByte('\n')
		}
		buf.WriteString(line)
	}
	_, err := Run(ctx, Spec{Path: path, Args: args, OnStdout: collect, OnStderr: collect})
	mu.Lock()
	out := strings.TrimSpace(buf.String())
	mu.Unlock()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return out, fmt.Errorf("%s timed out after %s: %w", path, timeout, err)
		}
		return out, err
	}
	return out, nil
}

// lineWriter is an io.Writer that splits on \n, \r\n and bare \r.
type lineWriter struct {
	mu      sync.Mutex
	fn      func(string)
	buf     []byte
	sawCR   bool
	maxLine int
}

func newLineWriter(fn func(string)) *lineWriter {
	return &lineWriter{fn: fn, maxLine: 1 << 20}
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, b := range p {
		switch b {
		case '\n':
			if w.sawCR {
				// \r\n: the \r already ended the line.
				w.sawCR = false
				continue
			}
			w.emit()
		case '\r':
			w.emit()
			w.sawCR = true
			continue
		default:
			if len(w.buf) < w.maxLine {
				w.buf = append(w.buf, b)
			}
		}
		w.sawCR = false
	}
	return len(p), nil
}

// Flush emits any trailing partial line.
func (w *lineWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.emit()
}

func (w *lineWriter) emit() {
	line := bytes.TrimRight(w.buf, " \t")
	w.buf = w.buf[:0]
	if len(line) == 0 || w.fn == nil {
		return
	}
	w.fn(string(line))
}

type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []string
}

func (t *tailBuffer) add(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, line)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
}

func (t *tailBuffer) lines() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.buf...)
}
