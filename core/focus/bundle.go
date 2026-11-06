package focus

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Pure helpers for macOS app bundles (SPEC.md §1.7). They live outside the
// darwin file so every OS tests them.

// bundleOf returns the outermost .app bundle containing path ("" if none):
// `…/Foo.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper` is Foo.app.
func bundleOf(path string) string {
	for i := 0; i+4 <= len(path); i++ {
		if strings.EqualFold(path[i:i+4], ".app") && (i+4 == len(path) || path[i+4] == '/') {
			return path[:i+4]
		}
	}
	return ""
}

// isBundleMain reports whether path is an app's own executable, directly in
// the outermost bundle's Contents/MacOS. Helper bundles nested inside it are
// not: one app gets one quit request.
func isBundleMain(path string) bool {
	b := bundleOf(path)
	if b == "" {
		return false
	}
	rest, ok := strings.CutPrefix(path, b+"/Contents/MacOS/")
	return ok && rest != "" && !strings.Contains(rest, "/")
}

// quitTimeout is how long an app's own quit may take.
const quitTimeout = 30 * time.Second

// quitError words a failed quit: a timeout says so, anything else is a refusal.
func quitError(bundle string, err error) error {
	name := bundle
	if i := strings.LastIndexByte(bundle, '/'); i >= 0 {
		name = bundle[i+1:]
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s didn't answer within %d seconds", name, int(quitTimeout.Seconds()))
	}
	return fmt.Errorf("Toolbox isn't allowed to quit %s: %w", name, err)
}

// quitFlight shares one quit request per bundle: callers asking for the same
// bundle while it is in flight, or just after, get the same answer.
type quitFlight struct {
	mu    sync.Mutex
	calls map[string]*quitCall
	now   func() time.Time
	keep  time.Duration
}

type quitCall struct {
	done chan struct{}
	err  error
	at   time.Time
}

func newQuitFlight() *quitFlight {
	return &quitFlight{calls: map[string]*quitCall{}, now: time.Now, keep: 10 * time.Second}
}

func (f *quitFlight) do(bundle string, fn func() error) error {
	f.mu.Lock()
	if c, ok := f.calls[bundle]; ok {
		select {
		case <-c.done:
			if f.now().Sub(c.at) > f.keep {
				delete(f.calls, bundle)
				c = nil
			}
		default:
		}
		if c != nil {
			f.mu.Unlock()
			<-c.done
			return c.err
		}
	}
	c := &quitCall{done: make(chan struct{})}
	f.calls[bundle] = c
	f.mu.Unlock()
	c.err = fn()
	f.mu.Lock()
	c.at = f.now()
	f.mu.Unlock()
	close(c.done)
	return c.err
}
