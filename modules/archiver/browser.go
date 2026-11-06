package archiver

import (
	"os"
	"path/filepath"
	"runtime"
)

// browserFinder is the seam for locating an installed Chromium browser.
type browserFinder struct {
	goos   string
	getenv func(string) string
	exists func(string) bool
}

func defaultFinder() browserFinder {
	return browserFinder{goos: runtime.GOOS, getenv: os.Getenv, exists: isFile}
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

type browserCandidate struct{ path, name string }

const (
	nameEdge   = "Microsoft Edge"
	nameChrome = "Google Chrome"
)

// candidates lists the known install locations, best first.
func (f browserFinder) candidates() []browserCandidate {
	var out []browserCandidate
	switch f.goos {
	case "windows":
		var roots []string
		for _, k := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
			if v := f.getenv(k); v != "" {
				roots = append(roots, v)
			}
		}
		for _, r := range roots {
			out = append(out, browserCandidate{filepath.Join(r, "Microsoft", "Edge", "Application", "msedge.exe"), nameEdge})
		}
		for _, r := range roots {
			out = append(out, browserCandidate{filepath.Join(r, "Google", "Chrome", "Application", "chrome.exe"), nameChrome})
		}
		if v := f.getenv("LOCALAPPDATA"); v != "" {
			out = append(out, browserCandidate{filepath.Join(v, "Google", "Chrome", "Application", "chrome.exe"), nameChrome})
		}
	case "darwin":
		out = append(out,
			browserCandidate{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", nameChrome},
			browserCandidate{"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", nameEdge},
		)
		if h := f.getenv("HOME"); h != "" {
			out = append(out,
				browserCandidate{filepath.Join(h, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), nameChrome},
				browserCandidate{filepath.Join(h, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"), nameEdge},
			)
		}
	default:
		for _, p := range []string{"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"} {
			out = append(out, browserCandidate{p, nameChrome})
		}
		for _, p := range []string{"/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"} {
			out = append(out, browserCandidate{p, nameEdge})
		}
	}
	return out
}

// find returns the first installed browser, or "" when there is none.
func (f browserFinder) find() (path, name string) {
	for _, c := range f.candidates() {
		if f.exists(c.path) {
			return c.path, c.name
		}
	}
	return "", ""
}

func browserHint() string {
	return "Install Microsoft Edge or Google Chrome to use Render JavaScript and Also save as PDF"
}
