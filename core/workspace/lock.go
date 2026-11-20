package workspace

import (
	"context"
	"fmt"
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

// Acquire is AcquireTools on the folder given to SetToolsDir (no lock until
// main.go has set it). It is what installers call:
//
//	ctx, unlock, err := workspace.Acquire(ctx)
func Acquire(ctx context.Context) (context.Context, func(), error) {
	toolsDirMu.Lock()
	dir := toolsDir
	toolsDirMu.Unlock()
	return AcquireTools(ctx, dir)
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

// LockInstance takes <supportDir>/.toolbox-instance.lock without waiting. It
// is the first thing main.go does with a workspace: ok is false when another
// Toolbox process has this support dir open, and then the caller must not
// touch its state (recovering "running" jobs, clearing tmp, wiping the Vault's
// open copies would break the running instance) and only hand over to it.
func LockInstance(supportDir string) (unlock func(), ok bool, err error) {
	if err := os.MkdirAll(supportDir, 0o755); err != nil {
		return nil, false, fmt.Errorf("create support dir: %w", err)
	}
	f, err := os.OpenFile(filepath.Join(supportDir, InstanceLockFile), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false, fmt.Errorf("open instance lock: %w", err)
	}
	ok, err = tryLock(f)
	if err != nil || !ok {
		f.Close()
		if err != nil {
			return nil, false, fmt.Errorf("lock instance: %w", err)
		}
		return nil, false, nil
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			unlockFile(f)
			f.Close()
		})
	}, true, nil
}
