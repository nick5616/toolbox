// Package trash moves files to the operating system's Recycle Bin / Trash
// (Phase 19, SPEC.md §3.2), so a Library delete can be undone from the OS.
// Callers check paths are inside the library first; this package doesn't.
package trash

import (
	"errors"
	"sync"
)

// ErrUnavailable is returned where this build can't use the OS trash (a
// cgo-less macOS build); the UI disables Delete with the reason.
var ErrUnavailable = errors.New("moving files to the Trash isn't available in this build")

// Trasher moves paths to the OS trash. It returns one error per path that
// failed (nil = moved), in the order given.
type Trasher interface {
	Available() bool
	Trash(paths []string) []error
}

// Default is the platform implementation (trash_windows.go, trash_darwin.go,
// trash_other.go).
func Default() Trasher { return platform{} }

// Fake records what it was asked to trash (tests).
type Fake struct {
	mu      sync.Mutex
	Trashed []string
	Fail    map[string]error // path → error to return
	Off     bool             // Available() == false
}

// Available implements Trasher.
func (f *Fake) Available() bool { return !f.Off }

// Trash implements Trasher.
func (f *Fake) Trash(paths []string) []error {
	f.mu.Lock()
	defer f.mu.Unlock()
	errs := make([]error, len(paths))
	for i, p := range paths {
		if err := f.Fail[p]; err != nil {
			errs[i] = err
			continue
		}
		f.Trashed = append(f.Trashed, p)
	}
	return errs
}
