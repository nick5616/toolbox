package workspace

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"time"

	"toolbox/core"
)

// ToolsLockWait is how long a second locker waits before giving up.
const ToolsLockWait = 2 * time.Second

const lockPoll = 50 * time.Millisecond

var (
	toolsDirMu sync.Mutex
	toolsDir   string
)

// SetToolsDir records the tools folder LockTools locks (main.go, at boot).
func SetToolsDir(dir string) {
	toolsDirMu.Lock()
	toolsDir = dir
	toolsDirMu.Unlock()
}

type heldKey struct{ dir string }

// LockTools takes the tools-folder lock of the folder given to SetToolsDir.
func LockTools(ctx context.Context) (unlock func(), err error) {
	toolsDirMu.Lock()
	dir := toolsDir
	toolsDirMu.Unlock()
	_, unlock, err = AcquireTools(ctx, dir)
	return unlock, err
}

// AcquireTools takes <dir>/.toolbox-tools.lock, an OS file lock shared by
// every Toolbox process (SPEC §A6b), waiting up to ToolsLockWait. Installs,
// updates, removes, `uv sync` and tools-folder moves hold it; reading tools
// needs no lock. The returned context marks the lock as held, so nested calls
// (an install job running the engine's setup) don't wait on themselves.
// dir "" takes no lock.
func AcquireTools(ctx context.Context, dir string) (context.Context, func(), error) {
	if dir == "" {
		return ctx, func() {}, nil
	}
	if h, ok := ctx.Value(heldKey{}).(string); ok && h == dir {
		return ctx, func() {}, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ctx, nil, core.Errorf(core.CodeInternal, "Couldn't open the tools folder").WithCause(err)
	}
	path := filepath.Join(dir, ToolsLockFile)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return ctx, nil, core.Errorf(core.CodeInternal, "Couldn't lock the tools folder").WithCause(err)
	}
	deadline := time.Now().Add(ToolsLockWait)
	for {
		ok, err := tryLock(f)
		if err != nil {
			f.Close()
			return ctx, nil, core.Errorf(core.CodeInternal, "Couldn't lock the tools folder").WithCause(err)
		}
		if ok {
			break
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			f.Close()
			if ctx.Err() != nil {
				return ctx, nil, ctx.Err()
			}
			return ctx, nil, core.Errorf(core.CodeConflict, "Another Toolbox is changing the tools").
				WithHint("Try again in a moment")
		}
		select {
		case <-time.After(lockPoll):
		case <-ctx.Done():
		}
	}
	var once sync.Once
	unlock := func() {
		once.Do(func() {
			unlockFile(f)
			f.Close()
		})
	}
	return context.WithValue(ctx, heldKey{}, dir), unlock, nil
}
