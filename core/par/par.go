// Package par runs independent work in parallel with a bound.
//
// It is the one helper the app uses for fan-out over inputs (files, frames,
// pages): results are written by index so callers keep their order, the first
// error cancels the rest, and nothing outlives the call.
package par

import (
	"context"
	"runtime"
	"sync"
)

// ForEach calls fn(ctx, i) for i in [0, n) with at most limit calls running at
// once (limit < 1 means 1). The ctx given to fn is cancelled after the first
// error or when the parent is cancelled; ForEach returns the first error, or
// ctx.Err() if the parent was cancelled before every item started. It always
// waits for every started call to return.
func ForEach(ctx context.Context, n, limit int, fn func(ctx context.Context, i int) error) error {
	if n <= 0 {
		return ctx.Err()
	}
	if limit < 1 {
		limit = 1
	}
	if limit > n {
		limit = n
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var (
		mu       sync.Mutex
		firstErr error
		wg       sync.WaitGroup
		next     int
	)
	fail := func(err error) {
		mu.Lock()
		if firstErr == nil {
			firstErr = err
			cancel()
		}
		mu.Unlock()
	}
	take := func() (int, bool) {
		mu.Lock()
		defer mu.Unlock()
		if next >= n || firstErr != nil || ctx.Err() != nil {
			return 0, false
		}
		i := next
		next++
		return i, true
	}
	wg.Add(limit)
	for w := 0; w < limit; w++ {
		go func() {
			defer wg.Done()
			for {
				i, ok := take()
				if !ok {
					return
				}
				if err := fn(ctx, i); err != nil {
					fail(err)
					return
				}
			}
		}()
	}
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if firstErr != nil {
		return firstErr
	}
	if next < n {
		return context.Cause(ctx) // parent cancelled before every item started
	}
	return nil
}

// Map is ForEach collecting fn's results by index.
func Map[T any](ctx context.Context, n, limit int, fn func(ctx context.Context, i int) (T, error)) ([]T, error) {
	out := make([]T, n)
	err := ForEach(ctx, n, limit, func(ctx context.Context, i int) error {
		v, err := fn(ctx, i)
		if err != nil {
			return err
		}
		out[i] = v
		return nil
	})
	return out, err
}

// CPUHalf is max(1, NumCPU/2): the default bound for CPU-heavy pure-Go work
// (image decode/encode) that shouldn't starve the UI or running jobs.
func CPUHalf() int {
	return max(1, runtime.NumCPU()/2)
}
