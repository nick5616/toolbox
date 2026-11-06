//go:build integration && windows

package focus

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestRealPlatformE2E runs the real Windows platform with DryRun off, but the
// engine's Scope is limited to descendants of helper processes this test
// spawned, so nothing else on the machine is ever decided or touched.
// Run with TOOLBOX_FOCUS_E2E=1 go test -tags integration -run E2E ./core/focus/

const helperSrc = `package main

import (
	"fmt"
	"os"
	"os/exec"
	"time"
)

func main() {
	if len(os.Args) > 2 && os.Args[1] == "spawn" {
		c := exec.Command(os.Args[2])
		if err := c.Start(); err == nil {
			fmt.Println(c.Process.Pid)
		}
	}
	time.Sleep(8 * time.Second)
}
`

// scopedPlatform limits the real platform: Self is faked and the set of
// in-scope PIDs is "descendants of the roots the test started".
type scopedPlatform struct {
	Platform
	mu    sync.Mutex
	roots map[uint32]int64
	scope map[uint32]bool
}

func (s *scopedPlatform) Self() ProcInfo {
	i := s.Platform.Self()
	i.PID = 0xFFFFFFF0 // not the test process, so the test binary gets no Toolbox status
	return i
}

func (s *scopedPlatform) addRoot(pid uint32, created int64) {
	s.mu.Lock()
	s.roots[pid] = created
	s.mu.Unlock()
}

func (s *scopedPlatform) Snapshot(ctx context.Context) ([]ProcInfo, error) {
	procs, err := s.Platform.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	byPID := map[uint32]ProcInfo{}
	for _, p := range procs {
		byPID[p.PID] = p
	}
	scope := map[uint32]bool{}
	for _, p := range procs {
		cur, depth := p, 0
		for depth < 16 {
			if c, ok := s.roots[cur.PID]; ok && c == cur.Created {
				scope[p.PID] = true
				break
			}
			par, ok := byPID[cur.ParentPID]
			if !ok || par.Created > cur.Created {
				break
			}
			cur, depth = par, depth+1
		}
	}
	s.scope = scope
	return procs, nil
}

func (s *scopedPlatform) inScope(p ProcInfo) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.scope[p.PID]
}

func TestRealPlatformE2E(t *testing.T) {
	if os.Getenv("TOOLBOX_FOCUS_E2E") != "1" {
		t.Skip("set TOOLBOX_FOCUS_E2E=1")
	}
	dir, _ := os.MkdirTemp("", "focus-e2e")
	defer func() { time.Sleep(9 * time.Second); _ = os.RemoveAll(dir) }() // the survivor helper exits by itself
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "main.go"), []byte(helperSrc), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "go.mod"), []byte("module helper\n\ngo 1.21\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-o", filepath.Join(dir, "allowed.exe"), ".")
	build.Dir = src
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build helper: %v\n%s", err, out)
	}
	blocked := filepath.Join(dir, "blocked.exe")
	data, _ := os.ReadFile(filepath.Join(dir, "allowed.exe"))
	if err := os.WriteFile(blocked, data, 0o755); err != nil {
		t.Fatal(err)
	}
	allowed := filepath.Join(dir, "allowed.exe")

	sp := &scopedPlatform{Platform: NewPlatform(), roots: map[uint32]int64{}}
	e := New(Options{Platform: sp, Store: newMemStore(), DryRun: false, Scope: sp.inScope})
	if err := e.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer e.Stop()
	prof, err := e.SaveProfile(Profile{Name: "E2E", Rules: []AllowRule{{Label: "allowed", Kind: RuleExe, Path: allowed, Children: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Begin(StartRequest{ProfileID: prof.ID, Minutes: 5, Strength: StrengthSoft, OnStart: OnStartLeave}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond) // first tick over an empty scope

	started := []*exec.Cmd{}
	defer func() {
		for _, c := range started { // only processes this test started
			_ = c.Process.Kill()
		}
	}()
	start := func(path string, args ...string) *exec.Cmd {
		c := exec.Command(path, args...)
		c.Stdout = nil
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		started = append(started, c)
		created := int64(0)
		for i := 0; i < 50 && created == 0; i++ { // find it in a snapshot
			procs, _ := sp.Platform.Snapshot(context.Background())
			for _, p := range procs {
				if p.PID == uint32(c.Process.Pid) {
					created = p.Created
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
		sp.addRoot(uint32(c.Process.Pid), created)
		return c
	}

	// blocked.exe is terminated.
	b := start(blocked)
	done := make(chan error, 1)
	go func() { done <- b.Wait() }()
	select {
	case <-done:
	case <-time.After(4 * time.Second):
		t.Fatal("blocked.exe was not terminated")
	}

	// allowed.exe survives, and so does the blocked.exe it starts.
	a := start(allowed, "spawn", blocked)
	time.Sleep(3500 * time.Millisecond)
	if a.ProcessState != nil {
		t.Fatal("allowed.exe died")
	}
	if got := e.State().Session.Blocked; got != 1 {
		t.Fatalf("blocked count = %d, want 1 (the child of allowed.exe must survive)", got)
	}
	fmt.Println("e2e ok")
}
