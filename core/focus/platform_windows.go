//go:build windows

package focus

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows backend (SPEC.md §1, R9): one NtQuerySystemInformation snapshot
// per tick, image paths only for newly seen processes, a WinEvent hook for
// window kicks. No cgo.

var (
	user32                        = windows.NewLazySystemDLL("user32.dll")
	procPostMessageW              = user32.NewProc("PostMessageW")
	procGetWindow                 = user32.NewProc("GetWindow")
	procPostThreadMessageW        = user32.NewProc("PostThreadMessageW")
	procGetMessageW               = user32.NewProc("GetMessageW")
	procPeekMessageW              = user32.NewProc("PeekMessageW")
	procSetWinEventHook           = user32.NewProc("SetWinEventHook")
	procUnhookWinEvent            = user32.NewProc("UnhookWinEvent")
	wmClose                uint32 = 0x0010
	wmQuit                 uint32 = 0x0012
)

const (
	eventObjectShow      = 0x8002
	winEventOutOfContext = 0x0000
	winEventSkipOwn      = 0x0002
	objidWindow          = 0
	epochDiffMs          = 11644473600000 // 1601 → 1970
)

func filetimeMs(ft windows.Filetime) int64 {
	t := int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime)
	return t/10000 - epochDiffMs
}

type winPlatform struct {
	self ProcInfo
	root string

	snapMu sync.Mutex
	buf    []byte

	pathMu sync.Mutex
	paths  map[pkey]string
	long   map[string]string
}

// NewPlatform returns this OS's platform.
func NewPlatform() Platform {
	p := &winPlatform{paths: map[pkey]string{}, long: map[string]string{}, buf: make([]byte, 1<<20)}
	pid := windows.GetCurrentProcessId()
	p.self = ProcInfo{PID: pid}
	var c, x, k, u windows.Filetime
	if err := windows.GetProcessTimes(windows.CurrentProcess(), &c, &x, &k, &u); err == nil {
		p.self.Created = filetimeMs(c)
	}
	var sid uint32
	if err := windows.ProcessIdToSessionId(pid, &sid); err == nil {
		p.self.Session = sid
	}
	if exe, err := os.Executable(); err == nil {
		p.self.Path = exe
		p.self.Name = filepath.Base(exe)
	}
	if d, err := windows.GetSystemWindowsDirectory(); err == nil {
		p.root = strings.TrimRight(p.longPath(d), `\/`)
	}
	return p
}

func (p *winPlatform) Supported() error           { return nil }
func (p *winPlatform) Self() ProcInfo             { return p.self }
func (p *winPlatform) InteractiveSession() uint32 { return p.self.Session }
func (p *winPlatform) SystemRoot() string         { return p.root }

const statusInfoLengthMismatch = windows.STATUS_INFO_LENGTH_MISMATCH

func (p *winPlatform) Snapshot(ctx context.Context) ([]ProcInfo, error) {
	p.snapMu.Lock()
	defer p.snapMu.Unlock()
	var ret uint32
	for try := 0; try < 8; try++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		err := windows.NtQuerySystemInformation(windows.SystemProcessInformation, unsafe.Pointer(&p.buf[0]), uint32(len(p.buf)), &ret)
		if err == nil {
			break
		}
		if err == error(statusInfoLengthMismatch) {
			n := int(ret) + int(ret)/4 + 64<<10
			if n <= len(p.buf) {
				n = len(p.buf) * 2
			}
			p.buf = make([]byte, n)
			continue
		}
		return nil, fmt.Errorf("NtQuerySystemInformation: %w", err)
	}
	if ret == 0 || int(ret) > len(p.buf) {
		return nil, errors.New("NtQuerySystemInformation: process list didn't fit")
	}
	out := make([]ProcInfo, 0, 400)
	off := uintptr(0)
	for {
		e := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&p.buf[off]))
		pid := uint32(e.UniqueProcessID)
		if pid != 0 {
			name := ""
			if e.ImageName.Length > 0 && e.ImageName.Buffer != nil {
				name = e.ImageName.String()
			}
			out = append(out, ProcInfo{
				PID: pid, ParentPID: uint32(e.InheritedFromUniqueProcessID),
				Created: e.CreateTime/10000 - epochDiffMs, Session: e.SessionID, Name: name,
			})
		}
		if e.NextEntryOffset == 0 {
			break
		}
		off += uintptr(e.NextEntryOffset)
		if off+unsafe.Sizeof(windows.SYSTEM_PROCESS_INFORMATION{}) > uintptr(len(p.buf)) {
			break
		}
	}
	return out, nil
}

// longPath expands 8.3 names (cached) and strips the \\?\ prefix.
func (p *winPlatform) longPath(s string) string {
	s = strings.TrimPrefix(s, `\\?\`)
	if !strings.Contains(s, "~") {
		return s
	}
	p.pathMu.Lock()
	if v, ok := p.long[s]; ok {
		p.pathMu.Unlock()
		return v
	}
	p.pathMu.Unlock()
	res := s
	if in, err := windows.UTF16PtrFromString(s); err == nil {
		buf := make([]uint16, windows.MAX_LONG_PATH)
		if n, err := windows.GetLongPathName(in, &buf[0], uint32(len(buf))); err == nil && n > 0 && int(n) < len(buf) {
			res = windows.UTF16ToString(buf[:n])
		}
	}
	p.pathMu.Lock()
	if len(p.long) > 20000 {
		p.long = map[string]string{}
	}
	p.long[s] = res
	p.pathMu.Unlock()
	return res
}

func (p *winPlatform) imagePath(pid uint32, created int64) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	if created != 0 {
		var c, x, k, u windows.Filetime
		if err := windows.GetProcessTimes(h, &c, &x, &k, &u); err != nil || abs64(filetimeMs(c)-created) > 1 {
			return "" // a different process now owns this PID
		}
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil {
		return ""
	}
	return p.longPath(windows.UTF16ToString(buf[:size]))
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func (p *winPlatform) Paths(ps []ProcInfo) {
	for i := range ps {
		if ps[i].Path != "" {
			continue
		}
		k := pkey{ps[i].PID, ps[i].Created}
		p.pathMu.Lock()
		v, ok := p.paths[k]
		p.pathMu.Unlock()
		if !ok {
			v = p.imagePath(ps[i].PID, ps[i].Created)
			p.pathMu.Lock()
			if len(p.paths) > 50000 {
				p.paths = map[pkey]string{}
			}
			p.paths[k] = v
			p.pathMu.Unlock()
		}
		ps[i].Path = v
	}
}

// ---- windows ---------------------------------------------------------------

var (
	enumMu    sync.Mutex
	enumFn    func(hwnd windows.HWND, pid uint32)
	enumCBOne sync.Once
	enumCB    uintptr
)

// isOwned reports whether h has an owner (dialogs, tool palettes): only
// unowned top-level windows count as a program's windows (SPEC §1.2).
func isOwned(h windows.HWND) bool {
	owner, _, _ := procGetWindow.Call(uintptr(h), gwOwner)
	return owner != 0
}

const gwOwner = 4

// visibleWindows calls fn for every visible, unowned top-level window.
func visibleWindows(fn func(hwnd windows.HWND, pid uint32)) {
	enumCBOne.Do(func() {
		enumCB = windows.NewCallback(func(hwnd, _ uintptr) uintptr {
			h := windows.HWND(hwnd)
			if windows.IsWindowVisible(h) && !isOwned(h) {
				var pid uint32
				if _, err := windows.GetWindowThreadProcessId(h, &pid); err == nil && pid != 0 {
					enumFn(h, pid)
				}
			}
			return 1
		})
	})
	enumMu.Lock()
	defer enumMu.Unlock()
	enumFn = fn
	_ = windows.EnumWindows(enumCB, nil)
	enumFn = nil
}

func (p *winPlatform) Windows() map[uint32]bool {
	out := map[uint32]bool{}
	visibleWindows(func(_ windows.HWND, pid uint32) { out[pid] = true })
	return out
}

// verified opens pid with access and checks it is still the process created
// at created. ErrGone otherwise.
func verified(pid uint32, created int64, access uint32) (windows.Handle, error) {
	h, err := windows.OpenProcess(access|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return 0, ErrGone
		}
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return 0, fmt.Errorf("%w: %v", errDenied, err)
		}
		return 0, err
	}
	if created != 0 {
		var c, x, k, u windows.Filetime
		if err := windows.GetProcessTimes(h, &c, &x, &k, &u); err != nil || abs64(filetimeMs(c)-created) > 1 {
			windows.CloseHandle(h)
			return 0, ErrGone
		}
	}
	if r, _ := windows.WaitForSingleObject(h, 0); r == windows.WAIT_OBJECT_0 {
		windows.CloseHandle(h) // already exited
		return 0, ErrGone
	}
	return h, nil
}

func (p *winPlatform) Terminate(pi ProcInfo) error {
	h, err := verified(pi.PID, pi.Created, windows.PROCESS_TERMINATE)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	if err := windows.TerminateProcess(h, 1); err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return fmt.Errorf("%w: %v", errDenied, err)
		}
		return err
	}
	return nil
}

// closeWindows posts WM_CLOSE to pid's visible top-level windows.
func closeWindows(pid uint32) int {
	var hs []windows.HWND
	visibleWindows(func(h windows.HWND, wp uint32) {
		if wp == pid {
			hs = append(hs, h)
		}
	})
	for _, h := range hs {
		_, _, _ = procPostMessageW.Call(uintptr(h), uintptr(wmClose), 0, 0)
	}
	return len(hs)
}

func (p *winPlatform) AskToClose(pi ProcInfo) (bool, error) {
	h, err := verified(pi.PID, pi.Created, 0)
	if err != nil {
		return false, err
	}
	windows.CloseHandle(h)
	return closeWindows(pi.PID) > 0, nil
}

// AskToClose politely closes a program Toolbox launched (Open in app's
// closeWhen): WM_CLOSE to its visible windows once (pid, created) is verified.
// It never terminates. created 0 skips the creation-time check.
func AskToClose(pid uint32, created int64, path string) error {
	h, err := verified(pid, created, 0)
	if err != nil {
		if errors.Is(err, ErrGone) {
			return nil
		}
		return err
	}
	windows.CloseHandle(h)
	closeWindows(pid)
	return nil
}

// ---- kicks -------------------------------------------------------------------

var (
	kickMu   sync.Mutex
	kickByTh = map[uint32]chan struct{}{}
	kickOnce sync.Once
	kickCB   uintptr
)

func kickCallback() uintptr {
	kickOnce.Do(func() {
		kickCB = syscall.NewCallback(func(hook, event, hwnd, idObject, idChild, thread, ts uintptr) uintptr {
			if int32(idObject) != objidWindow || int32(idChild) != 0 || hwnd == 0 {
				return 0
			}
			kickMu.Lock()
			ch := kickByTh[windows.GetCurrentThreadId()]
			kickMu.Unlock()
			if ch != nil {
				select {
				case ch <- struct{}{}:
				default:
				}
			}
			return 0
		})
	})
	return kickCB
}

type winMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	ptX     int32
	ptY     int32
}

// Kicks fires when a top-level window is shown anywhere (out-of-context
// WinEvent hook on a locked OS thread with its own message loop).
func (p *winPlatform) Kicks(ctx context.Context) <-chan struct{} {
	out := make(chan struct{}, 1)
	ready := make(chan uint32, 1)
	done := make(chan struct{})
	cb := kickCallback()
	go func() {
		defer close(done)
		defer close(out)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		tid := windows.GetCurrentThreadId()
		var m winMsg
		_, _, _ = procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, 0) // creates the queue
		kickMu.Lock()
		kickByTh[tid] = out
		kickMu.Unlock()
		hook, _, _ := procSetWinEventHook.Call(eventObjectShow, eventObjectShow, 0, cb, 0, 0, winEventOutOfContext|winEventSkipOwn)
		ready <- tid
		if hook != 0 {
			for {
				r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
				if int32(r) <= 0 {
					break
				}
			}
			_, _, _ = procUnhookWinEvent.Call(hook)
		} else {
			<-ctx.Done()
		}
		kickMu.Lock()
		delete(kickByTh, tid)
		kickMu.Unlock()
	}()
	go func() {
		tid := <-ready
		select {
		case <-ctx.Done():
		case <-done:
			return
		}
		for {
			_, _, _ = procPostThreadMessageW.Call(uintptr(tid), uintptr(wmQuit), 0, 0)
			select {
			case <-done:
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
	}()
	return out
}
