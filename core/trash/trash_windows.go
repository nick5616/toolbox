//go:build windows

package trash

import (
	"errors"
	"fmt"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	shell32             = syscall.NewLazyDLL("shell32.dll")
	procSHFileOperation = shell32.NewProc("SHFileOperationW")
)

const (
	foDelete = 0x3

	fofSilent          = 0x0004
	fofNoConfirmation  = 0x0010
	fofAllowUndo       = 0x0040
	fofNoErrorUI       = 0x0400
	fofWantNukeWarning = 0x4000 // ask instead of silently deleting what the bin can't hold

	maxPath = 260
)

// shFileOpStruct is SHFILEOPSTRUCTW (x64/arm64 layout: natural alignment).
type shFileOpStruct struct {
	Hwnd                 uintptr
	Func                 uint32
	From                 *uint16
	To                   *uint16
	Flags                uint16
	AnyOperationsAborted int32
	NameMappings         uintptr
	ProgressTitle        *uint16
}

type platform struct{}

func (platform) Available() bool { return procSHFileOperation.Find() == nil }

// Trash sends each path to the Recycle Bin with one SHFileOperationW call per
// path, so a failure is reported for that path only.
func (platform) Trash(paths []string) []error {
	errs := make([]error, len(paths))
	for i, p := range paths {
		errs[i] = trashOne(p)
	}
	return errs
}

func trashOne(p string) error {
	abs, err := filepath.Abs(p)
	if err != nil {
		return fmt.Errorf("resolving %s: %w", p, err)
	}
	// Paths over MAX_PATH may be deleted for good instead of recycled.
	if len(abs) >= maxPath-1 {
		return errors.New("the path is too long to move to the Recycle Bin")
	}
	from, err := syscall.UTF16FromString(abs)
	if err != nil {
		return fmt.Errorf("path %s: %w", p, err)
	}
	from = append(from, 0) // the list ends with a second NUL
	op := shFileOpStruct{
		Func:  foDelete,
		From:  &from[0],
		Flags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI | fofWantNukeWarning,
	}
	r, _, _ := procSHFileOperation.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return fmt.Errorf("the Recycle Bin refused it (code 0x%x)", r)
	}
	if op.AnyOperationsAborted != 0 {
		return errors.New("moving to the Recycle Bin was cancelled")
	}
	return nil
}
