package desktop

import (
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Arguments a relaunch passes to the new process. Neither is meant for users;
// ParseLaunch removes both before anything else reads the command line.
const (
	// ArgAfterPID makes the new process wait for the old one to exit, so it
	// starts as soon as the workspace lock is free (no fixed delay).
	ArgAfterPID = "--after-pid"
	// ArgWindow carries the main window's place: "x,y,w,h" (DIP) or "max".
	ArgWindow = "--window"
)

// WindowHint is where the main window was when the app relaunched.
type WindowHint struct {
	X, Y, Width, Height int
	Maximised           bool
}

// Arg is the hint as a command-line argument.
func (h WindowHint) Arg() string {
	if h.Maximised {
		return ArgWindow + "=max"
	}
	return fmt.Sprintf("%s=%d,%d,%d,%d", ArgWindow, h.X, h.Y, h.Width, h.Height)
}

// ParseLaunch returns args without the relaunch arguments, the PID to wait
// for (0 = none) and the window hint (nil = none). Malformed values are
// dropped, never an error: a bad hint only means the default window.
func ParseLaunch(args []string) (rest []string, afterPID int, hint *WindowHint) {
	rest = make([]string, 0, len(args))
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, ArgAfterPID+"="); ok {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				afterPID = n
			}
			continue
		}
		if v, ok := strings.CutPrefix(a, ArgWindow+"="); ok {
			hint = parseWindowHint(v)
			continue
		}
		rest = append(rest, a)
	}
	return rest, afterPID, hint
}

func parseWindowHint(v string) *WindowHint {
	if v == "max" {
		return &WindowHint{Maximised: true}
	}
	parts := strings.Split(v, ",")
	if len(parts) != 4 {
		return nil
	}
	var n [4]int
	for i, p := range parts {
		x, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return nil
		}
		n[i] = x
	}
	h := &WindowHint{X: n[0], Y: n[1], Width: n[2], Height: n[3]}
	if h.Width < 200 || h.Height < 150 || h.Width > 20000 || h.Height > 20000 ||
		h.X < -20000 || h.X > 20000 || h.Y < -20000 || h.Y > 20000 {
		return nil
	}
	return h
}

var (
	relaunchWinMu sync.Mutex
	relaunchWin   *application.WebviewWindow
)

// SetRelaunchWindow names the window whose place a relaunch keeps (main.go,
// the main window).
func SetRelaunchWindow(w *application.WebviewWindow) {
	relaunchWinMu.Lock()
	relaunchWin = w
	relaunchWinMu.Unlock()
}

// currentWindowHint reads the main window's place. A minimised window has no
// useful place, so it gives none (the new window opens at the default).
func currentWindowHint() *WindowHint {
	relaunchWinMu.Lock()
	w := relaunchWin
	relaunchWinMu.Unlock()
	if w == nil || w.IsMinimised() {
		return nil
	}
	if w.IsMaximised() {
		return &WindowHint{Maximised: true}
	}
	x, y := w.Position()
	width, height := w.Size()
	return parseWindowHint(fmt.Sprintf("%d,%d,%d,%d", x, y, width, height))
}

// DefaultWindowSize is the main window's first size: wide enough that the
// sidebar shows its names (the frontend collapses it below 1180 CSS px of
// content; the window frame takes a few more), and never larger than the
// screen's work area (w, h = 0 when unknown).
func DefaultWindowSize(workW, workH int) (int, int) {
	const wantW, wantH = 1200, 780
	w, h := wantW, wantH
	if workW > 0 && workW < w {
		w = workW
	}
	if workH > 0 && workH < h {
		h = workH
	}
	return max(w, 960), max(h, 600)
}
