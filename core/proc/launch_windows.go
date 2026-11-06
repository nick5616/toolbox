//go:build windows

package proc

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	swShowMinNoActive = 7 // SW_SHOWMINNOACTIVE
	exitStillActive   = 259
)

// launch starts the program with CreateProcess: no CREATE_NO_WINDOW, a new
// process group, no job object (so nothing kills it with Toolbox's calls), and
// each argument escaped separately (SPEC.md §4.2, R25).
func launch(ctx context.Context, s LaunchSpec) (Launched, error) {
	if st, err := os.Stat(s.Path); err != nil || st.IsDir() {
		if err == nil {
			err = fmt.Errorf("%s is a folder", s.Path)
		}
		return Launched{}, fmt.Errorf("the program isn't there: %w", err)
	}
	app, err := windows.UTF16PtrFromString(s.Path)
	if err != nil {
		return Launched{}, fmt.Errorf("bad program path: %w", err)
	}
	cmdline, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{s.Path}, s.Args...)))
	if err != nil {
		return Launched{}, fmt.Errorf("bad arguments: %w", err)
	}
	dir := s.Dir
	if dir == "" {
		dir = filepath.Dir(s.Path)
	}
	dirp, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return Launched{}, fmt.Errorf("bad folder: %w", err)
	}
	si := &windows.StartupInfo{}
	si.Cb = uint32(unsafe.Sizeof(*si))
	if s.Minimized {
		si.Flags = windows.STARTF_USESHOWWINDOW
		si.ShowWindow = swShowMinNoActive
	}
	var pi windows.ProcessInformation
	if err := windows.CreateProcess(app, cmdline, nil, nil, false,
		windows.CREATE_NEW_PROCESS_GROUP|windows.CREATE_UNICODE_ENVIRONMENT, nil, dirp, si, &pi); err != nil {
		return Launched{}, fmt.Errorf("starting %s: %w", filepath.Base(s.Path), err)
	}
	defer windows.CloseHandle(pi.Thread)
	defer windows.CloseHandle(pi.Process)

	var created, exit, kernel, user windows.Filetime
	l := Launched{PID: pi.ProcessId}
	if err := windows.GetProcessTimes(pi.Process, &created, &exit, &kernel, &user); err == nil {
		l.Created = created.Nanoseconds() / int64(time.Millisecond)
	}

	deadline := time.NewTimer(earlyExitWindow)
	defer deadline.Stop()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		var code uint32
		if err := windows.GetExitCodeProcess(pi.Process, &code); err == nil && code != exitStillActive {
			if code != 0 {
				return Launched{}, &ExitedEarlyError{Code: int(code)}
			}
			return l, nil // exit 0: a single-instance hand-off
		}
		select {
		case <-ctx.Done():
			return l, nil
		case <-deadline.C:
			return l, nil
		case <-tick.C:
		}
	}
}
