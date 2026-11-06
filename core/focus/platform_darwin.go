//go:build darwin

package focus

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"toolbox/core/proc"
)

// macOS backend (SPEC.md §1.7): sysctl snapshots, kern.procargs2 paths,
// SIGKILL, and the app's own quit through osascript. No cgo.

type macPlatform struct {
	self ProcInfo
	uid  uint32

	mu    sync.Mutex
	paths map[pkey]string
	last  []ProcInfo
}

// NewPlatform returns this OS's platform.
func NewPlatform() Platform {
	uid := uint32(os.Getuid())
	p := &macPlatform{uid: uid, paths: map[pkey]string{}}
	pid := os.Getpid()
	p.self = ProcInfo{PID: uint32(pid), Session: uid, Name: filepath.Base(os.Args[0])}
	if exe, err := os.Executable(); err == nil {
		p.self.Path = exe
		p.self.Name = filepath.Base(exe)
	}
	if kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid); err == nil {
		p.self.Created = startMs(kp)
		p.self.ParentPID = uint32(kp.Eproc.Ppid)
	}
	return p
}

func startMs(kp *unix.KinfoProc) int64 {
	return kp.Proc.P_starttime.Sec*1000 + int64(kp.Proc.P_starttime.Usec)/1000
}

func (p *macPlatform) Supported() error           { return nil }
func (p *macPlatform) Self() ProcInfo             { return p.self }
func (p *macPlatform) InteractiveSession() uint32 { return p.uid }
func (p *macPlatform) SystemRoot() string         { return "/System" }

// Kicks: there are none on the Mac; the engine polls at min(PollMs, 500).
func (p *macPlatform) Kicks(context.Context) <-chan struct{} { return nil }

func (p *macPlatform) Snapshot(ctx context.Context) ([]ProcInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	kps, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, fmt.Errorf("sysctl kern.proc.all: %w", err)
	}
	out := make([]ProcInfo, 0, len(kps))
	for i := range kps {
		kp := &kps[i]
		pid := kp.Proc.P_pid
		if pid <= 0 {
			continue
		}
		name := make([]byte, 0, 17)
		for _, c := range kp.Proc.P_comm[:] {
			if c == 0 {
				break
			}
			name = append(name, byte(c))
		}
		out = append(out, ProcInfo{
			PID: uint32(pid), ParentPID: uint32(kp.Eproc.Ppid), Created: startMs(kp),
			Session: kp.Eproc.Pcred.P_ruid, Name: string(name),
		})
	}
	p.mu.Lock()
	p.last = out
	p.mu.Unlock()
	return out, nil
}

// execPath reads the exec path from kern.procargs2 (argc word, then the path).
func execPath(pid uint32) string {
	raw, err := unix.SysctlRaw("kern.procargs2", int(pid))
	if err != nil || len(raw) <= 4 {
		return ""
	}
	rest := raw[4:]
	for i, c := range rest {
		if c == 0 {
			return string(rest[:i])
		}
	}
	return ""
}

func (p *macPlatform) Paths(ps []ProcInfo) {
	for i := range ps {
		if ps[i].Path != "" {
			continue
		}
		k := pkey{ps[i].PID, ps[i].Created}
		p.mu.Lock()
		v, ok := p.paths[k]
		p.mu.Unlock()
		if !ok {
			v = execPath(ps[i].PID)
			p.mu.Lock()
			if len(p.paths) > 50000 {
				p.paths = map[pkey]string{}
			}
			p.paths[k] = v
			p.mu.Unlock()
		}
		ps[i].Path = v
	}
}

// bundleOf returns the .app bundle containing path ("" if none).
func bundleOf(path string) string {
	for i := 0; i+4 <= len(path); i++ {
		if strings.EqualFold(path[i:i+4], ".app") && (i+4 == len(path) || path[i+4] == '/') {
			return path[:i+4]
		}
	}
	return ""
}

// Windows guesses windowed apps from the bundle layout: the main executable
// of an .app is windowed.
func (p *macPlatform) Windows() map[uint32]bool {
	p.mu.Lock()
	procs := append([]ProcInfo(nil), p.last...)
	p.mu.Unlock()
	p.Paths(procs)
	out := map[uint32]bool{}
	for _, pi := range procs {
		if strings.Contains(pi.Path, ".app/Contents/MacOS/") {
			out[pi.PID] = true
		}
	}
	return out
}

// check re-reads the start time; ErrGone when pid is gone or reused.
func check(pid uint32, created int64) error {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", int(pid))
	if err != nil || kp.Proc.P_pid != int32(pid) {
		return ErrGone
	}
	if created != 0 {
		d := startMs(kp) - created
		if d < -1 || d > 1 {
			return ErrGone
		}
	}
	return nil
}

func (p *macPlatform) Terminate(pi ProcInfo) error {
	if err := check(pi.PID, pi.Created); err != nil {
		return err
	}
	if err := syscall.Kill(int(pi.PID), syscall.SIGKILL); err != nil {
		switch {
		case errors.Is(err, syscall.ESRCH):
			return ErrGone
		case errors.Is(err, syscall.EPERM):
			return fmt.Errorf("%w: %v", errDenied, err)
		}
		return err
	}
	return nil
}

func quitApp(bundle string) error {
	esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(bundle)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := proc.Output(ctx, 30*time.Second, "/usr/bin/osascript", "-e", `tell application "`+esc+`" to quit`)
	if err != nil {
		return fmt.Errorf("Toolbox isn't allowed to quit %s: %w", filepath.Base(bundle), err)
	}
	return nil
}

func (p *macPlatform) AskToClose(pi ProcInfo) (bool, error) {
	if err := check(pi.PID, pi.Created); err != nil {
		return false, err
	}
	b := bundleOf(pi.Path)
	if b == "" {
		return false, nil // outside an .app: windowless
	}
	if err := quitApp(b); err != nil {
		return false, err
	}
	return true, nil
}

// AskToClose politely closes a program Toolbox launched (Open in app's
// closeWhen): the bundle's own quit (path is the .app or its executable).
// It never terminates.
func AskToClose(pid uint32, created int64, path string) error {
	if pid != 0 && created != 0 {
		if err := check(pid, created); err != nil {
			return nil // already gone
		}
	}
	b := bundleOf(path)
	if b == "" {
		return nil
	}
	return quitApp(b)
}
