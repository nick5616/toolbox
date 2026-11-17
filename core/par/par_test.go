package par

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestMapKeepsOrderAndBound(t *testing.T) {
	for _, tc := range []struct{ n, limit int }{{0, 3}, {1, 0}, {5, 1}, {50, 4}, {3, 10}} {
		var running, peak atomic.Int32
		out, err := Map(context.Background(), tc.n, tc.limit, func(_ context.Context, i int) (int, error) {
			r := running.Add(1)
			for {
				p := peak.Load()
				if r <= p || peak.CompareAndSwap(p, r) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			running.Add(-1)
			return i * i, nil
		})
		if err != nil {
			t.Fatalf("n=%d: %v", tc.n, err)
		}
		if len(out) != tc.n {
			t.Fatalf("n=%d: len %d", tc.n, len(out))
		}
		for i, v := range out {
			if v != i*i {
				t.Fatalf("n=%d: out[%d]=%d", tc.n, i, v)
			}
		}
		if want := int32(max(1, min(tc.limit, tc.n))); tc.n > 0 && peak.Load() > want {
			t.Fatalf("n=%d limit=%d: peak %d", tc.n, tc.limit, peak.Load())
		}
	}
}

func TestForEachFirstErrorCancels(t *testing.T) {
	boom := errors.New("boom")
	var started atomic.Int32
	err := ForEach(context.Background(), 100, 2, func(ctx context.Context, i int) error {
		started.Add(1)
		if i == 3 {
			return boom
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Millisecond):
		}
		return nil
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if started.Load() >= 100 {
		t.Fatalf("all items started after an error")
	}
}

func TestForEachParentCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := ForEach(ctx, 10, 2, func(context.Context, int) error { return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}
