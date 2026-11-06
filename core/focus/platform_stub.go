package focus

import (
	"context"
	"os"
	"runtime"
)

// stubPlatform is the Wave 0 placeholder platform (and the base of
// platform_other.go): it lists nothing and supports nothing.
type stubPlatform struct{ reason error }

func (s stubPlatform) Snapshot(context.Context) ([]ProcInfo, error) { return []ProcInfo{}, nil }
func (s stubPlatform) Terminate(ProcInfo) error                     { return s.reason }
func (s stubPlatform) AskToClose(ProcInfo) (bool, error)            { return false, s.reason }
func (s stubPlatform) Paths([]ProcInfo)                             {}
func (s stubPlatform) Windows() map[uint32]bool                     { return map[uint32]bool{} }
func (s stubPlatform) Self() ProcInfo                               { return ProcInfo{PID: uint32(os.Getpid())} }
func (s stubPlatform) InteractiveSession() uint32                   { return 0 }
func (s stubPlatform) SystemRoot() string                           { return "" }
func (s stubPlatform) Supported() error                             { return s.reason }

// OS is the current operating system as State.OS reports it.
func OS() string { return runtime.GOOS }

func (s stubPlatform) Kicks(context.Context) <-chan struct{} { return nil }
