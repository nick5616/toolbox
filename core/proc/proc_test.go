package proc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestHelperProcess is not a real test: it is re-executed by the tests below
// to play a child process, selected by PROC_HELPER.
func TestHelperProcess(t *testing.T) {
	mode := os.Getenv("PROC_HELPER")
	if mode == "" {
		return
	}
	switch mode {
	case "lines":
		fmt.Fprint(os.Stdout, "one\r\ntwo\rthree\n\npartial")
		fmt.Fprint(os.Stderr, "err1\nerr2\n")
		os.Exit(0)
	case "exit3":
		fmt.Fprintln(os.Stderr, "boom")
		os.Exit(3)
	case "parent":
		// Spawn a grandchild sleeper, report both PIDs, then sleep.
		child := exec.Command(os.Args[0], "-test.run=^TestHelperProcess$")
		child.Env = append(os.Environ(), "PROC_HELPER=sleep")
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("pids %d %d\n", os.Getpid(), child.Process.Pid)
		time.Sleep(time.Minute)
		os.Exit(0)
	case "sleep":
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(2)
}

func helper(mode string) Spec {
	return Spec{
		Path: os.Args[0],
		Args: []string{"-test.run=^TestHelperProcess$"},
		Env:  []string{"PROC_HELPER=" + mode},
	}
}

func TestRunSplitsLines(t *testing.T) {
	var mu sync.Mutex
	var out, errs []string
	s := helper("lines")
	s.OnStdout = func(l string) { mu.Lock(); out = append(out, l); mu.Unlock() }
	s.OnStderr = func(l string) { mu.Lock(); errs = append(errs, l); mu.Unlock() }
	res, err := Run(context.Background(), s)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d", res.ExitCode)
	}
	want := []string{"one", "two", "three", "partial"}
	if strings.Join(out, "|") != strings.Join(want, "|") {
		t.Fatalf("stdout lines = %q, want %q", out, want)
	}
	if strings.Join(errs, "|") != "err1|err2" {
		t.Fatalf("stderr lines = %q", errs)
	}
	if strings.Join(res.StderrTail, "|") != "err1|err2" {
		t.Fatalf("stderr tail = %q", res.StderrTail)
	}
}

func TestRunExitCode(t *testing.T) {
	res, err := Run(context.Background(), helper("exit3"))
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("err = %v, want *exec.ExitError", err)
	}
	if res.ExitCode != 3 {
		t.Fatalf("exit code = %d, want 3", res.ExitCode)
	}
	if len(res.StderrTail) != 1 || res.StderrTail[0] != "boom" {
		t.Fatalf("stderr tail = %q", res.StderrTail)
	}
}

func TestRunCancelKillsTree(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pids := make(chan [2]int, 1)
	s := helper("parent")
	s.OnStdout = func(l string) {
		var a, b int
		if _, err := fmt.Sscanf(l, "pids %d %d", &a, &b); err == nil {
			pids <- [2]int{a, b}
		}
	}
	done := make(chan error, 1)
	go func() {
		_, err := Run(ctx, s)
		done <- err
	}()

	var got [2]int
	select {
	case got = <-pids:
	case <-time.After(10 * time.Second):
		t.Fatal("helper never reported its pids")
	}
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	deadline := time.Now().Add(5 * time.Second)
	for _, pid := range got {
		for alive(pid) {
			if time.Now().After(deadline) {
				t.Fatalf("pid %d still alive 5s after cancel", pid)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func TestOutputTimeout(t *testing.T) {
	_, err := Output(context.Background(), 300*time.Millisecond, os.Args[0], "-test.run=^TestHelperProcess$")
	// Without PROC_HELPER the helper returns immediately; just check no error.
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
}

func TestLineWriterCRLFAcrossWrites(t *testing.T) {
	var got []string
	w := newLineWriter(func(l string) { got = append(got, l) })
	_, _ = w.Write([]byte("a\r"))
	_, _ = w.Write([]byte("\nb\r"))
	_, _ = w.Write([]byte("c"))
	w.Flush()
	if strings.Join(got, "|") != "a|b|c" {
		t.Fatalf("lines = %q", got)
	}
}
