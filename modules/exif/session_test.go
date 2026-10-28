package exif

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSession returns a session that runs the test binary as exiftool.
func fakeSession(t *testing.T) (*session, string) {
	t.Helper()
	pidlog := filepath.Join(t.TempDir(), "pids.txt")
	t.Setenv("FAKE_EXIFTOOL", "1")
	t.Setenv("FAKE_EXIF_PIDLOG", pidlog)
	s := newSession(func() (string, error) { return os.Args[0], nil })
	t.Cleanup(s.Close)
	return s, pidlog
}

func starts(pidlog string) int {
	b, _ := os.ReadFile(pidlog)
	return len(strings.Fields(string(b)))
}

func TestSessionFramingAndReuse(t *testing.T) {
	s, pidlog := fakeSession(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		out, err := s.Exec(ctx, "-ver")
		if err != nil || out != "13.59" {
			t.Fatalf("exec %d: %q %v", i, out, err)
		}
	}
	if n := starts(pidlog); n != 1 {
		t.Errorf("process starts = %d, want 1", n)
	}
}

func TestSessionStderrPerCommand(t *testing.T) {
	s, _ := fakeSession(t)
	ctx := context.Background()
	out, err := s.Exec(ctx, "STDERR")
	var ee *ExecError
	if !errors.As(err, &ee) || ee.Stderr != "bad thing" {
		t.Fatalf("err = %v", err)
	}
	if out != "partial" {
		t.Errorf("stdout = %q", out)
	}
	// The next command must not see the previous stderr.
	if out, err := s.Exec(ctx, "-ver"); err != nil || out != "13.59" {
		t.Errorf("next: %q %v", out, err)
	}
}

func TestSessionCrashRestarts(t *testing.T) {
	s, pidlog := fakeSession(t)
	ctx := context.Background()
	if _, err := s.Exec(ctx, "-ver"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Exec(ctx, "CRASH"); err == nil {
		t.Fatal("expected an error from a crashing command")
	}
	if out, err := s.Exec(ctx, "-ver"); err != nil || out != "13.59" {
		t.Fatalf("after crash: %q %v", out, err)
	}
	if n := starts(pidlog); n != 2 {
		t.Errorf("starts = %d, want 2", n)
	}
}

func TestSessionCancelKillsAndRecovers(t *testing.T) {
	s, pidlog := fakeSession(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	begin := time.Now()
	_, err := s.Exec(ctx, "HANG")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(begin) > 5*time.Second {
		t.Error("cancel took too long")
	}
	if s.running() {
		t.Error("process should be gone after cancel")
	}
	if out, err := s.Exec(context.Background(), "-ver"); err != nil || out != "13.59" {
		t.Fatalf("after cancel: %q %v", out, err)
	}
	if n := starts(pidlog); n != 2 {
		t.Errorf("starts = %d, want 2", n)
	}
	// An already-cancelled context never starts anything.
	cctx, c2 := context.WithCancel(context.Background())
	c2()
	if _, err := s.Exec(cctx, "-ver"); !errors.Is(err, context.Canceled) {
		t.Errorf("pre-cancelled: %v", err)
	}
}

func TestSessionIdleClose(t *testing.T) {
	s, pidlog := fakeSession(t)
	s.idle = 150 * time.Millisecond
	if _, err := s.Exec(context.Background(), "-ver"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for s.running() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if s.running() {
		t.Fatal("idle process was not closed")
	}
	if out, err := s.Exec(context.Background(), "-ver"); err != nil || out != "13.59" {
		t.Fatalf("after idle: %q %v", out, err)
	}
	if n := starts(pidlog); n != 2 {
		t.Errorf("starts = %d, want 2", n)
	}
}

func TestSessionCloseIsGracefulAndRepeatable(t *testing.T) {
	s, _ := fakeSession(t)
	if _, err := s.Exec(context.Background(), "-ver"); err != nil {
		t.Fatal(err)
	}
	begin := time.Now()
	s.Close()
	if s.running() {
		t.Error("still running after Close")
	}
	if time.Since(begin) > closeGrace {
		t.Error("Close should not need the kill fallback with a well-behaved tool")
	}
	s.Close()
	// Usable again afterwards.
	if out, err := s.Exec(context.Background(), "-ver"); err != nil || out != "13.59" {
		t.Fatalf("after Close: %q %v", out, err)
	}
}

func TestSessionCloseInterruptsRunningCommand(t *testing.T) {
	s, _ := fakeSession(t)
	errc := make(chan error, 1)
	go func() { _, err := s.Exec(context.Background(), "HANG"); errc <- err }()
	time.Sleep(300 * time.Millisecond)
	s.Close()
	select {
	case err := <-errc:
		if err == nil {
			t.Error("expected the in-flight command to fail")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Close did not interrupt the running command")
	}
}

func TestSessionConcurrentCommandsAreSerialised(t *testing.T) {
	s, pidlog := fakeSession(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := s.Exec(context.Background(), "-ver")
			if err != nil || out != "13.59" {
				t.Errorf("exec: %q %v", out, err)
			}
		}()
	}
	wg.Wait()
	if n := starts(pidlog); n != 1 {
		t.Errorf("starts = %d, want 1", n)
	}
}

func TestSessionExeError(t *testing.T) {
	want := errors.New("no exiftool")
	s := newSession(func() (string, error) { return "", want })
	if _, err := s.Exec(context.Background(), "-ver"); !errors.Is(err, want) {
		t.Errorf("err = %v", err)
	}
}

func TestSessionRejectsNewlineArguments(t *testing.T) {
	s, _ := fakeSession(t)
	if _, err := s.Exec(context.Background(), "-Title=a\nb"); err == nil {
		t.Error("newline in an argument must be rejected")
	}
	if out, err := s.Exec(context.Background(), "-ver"); err != nil || out != "13.59" {
		t.Errorf("session unusable after rejection: %q %v", out, err)
	}
}

func TestErrorLines(t *testing.T) {
	for in, want := range map[string]string{
		"":                                   "",
		"Warning: x":                         "",
		"Error: a\nWarning: b\nError: c":     "a; c",
		"Error: File not found - /tmp/x.jpg": "File not found - /tmp/x.jpg",
	} {
		if got := errorLines(in); got != want {
			t.Errorf("%q: %q want %q", in, got, want)
		}
	}
	_ = fmt.Sprint
}
