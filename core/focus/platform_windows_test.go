//go:build windows

package focus

import (
	"context"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Read-only checks of the real Windows platform: nothing is stopped.
func TestWindowsPlatformSnapshot(t *testing.T) {
	p := NewPlatform()
	if p.Supported() != nil {
		t.Fatal(p.Supported())
	}
	self := p.Self()
	if int(self.PID) != os.Getpid() || self.Created == 0 || self.Path == "" {
		t.Fatalf("self = %+v", self)
	}
	if p.InteractiveSession() != self.Session {
		t.Fatal("session mismatch")
	}
	if !strings.EqualFold(p.SystemRoot(), os.Getenv("SystemRoot")) {
		t.Fatalf("SystemRoot = %q, env %q", p.SystemRoot(), os.Getenv("SystemRoot"))
	}
	procs, err := p.Snapshot(context.Background())
	if err != nil || len(procs) < 10 {
		t.Fatalf("snapshot = %d procs, %v", len(procs), err)
	}
	var me *ProcInfo
	for i := range procs {
		if procs[i].PID == self.PID {
			me = &procs[i]
		}
	}
	if me == nil || me.Session != self.Session || abs64(me.Created-self.Created) > 1 || me.ParentPID == 0 {
		t.Fatalf("self in snapshot = %+v (self %+v)", me, self)
	}
	ps := []ProcInfo{*me}
	p.Paths(ps)
	if !strings.EqualFold(ps[0].Path, self.Path) {
		t.Fatalf("path = %q, want %q", ps[0].Path, self.Path)
	}
	_ = p.Windows()
	// A stale (pid, created) is refused without touching anything.
	if err := p.Terminate(ProcInfo{PID: self.PID, Created: self.Created + 100000}); err != ErrGone {
		t.Fatalf("stale terminate = %v", err)
	}
}

func TestWindowsKicksStopCleanly(t *testing.T) {
	p := NewPlatform()
	before := runtime.NumGoroutine()
	ctx, cancel := context.WithCancel(context.Background())
	ch := p.Kicks(ctx)
	time.Sleep(150 * time.Millisecond)
	cancel()
	select {
	case _, ok := <-ch:
		for ok {
			_, ok = <-ch
		}
	case <-time.After(3 * time.Second):
		t.Fatal("kick channel didn't close")
	}
	time.Sleep(100 * time.Millisecond)
	if n := runtime.NumGoroutine(); n > before {
		t.Fatalf("goroutines %d -> %d", before, n)
	}
}
