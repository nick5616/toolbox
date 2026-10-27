package core

import (
	"sync"
	"testing"
	"time"
)

type progSink struct {
	mu  sync.Mutex
	got []JobProgress
}

func (s *progSink) emit(p JobProgress) {
	s.mu.Lock()
	s.got = append(s.got, p)
	s.mu.Unlock()
}

func (s *progSink) list() []JobProgress {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]JobProgress{}, s.got...)
}

func TestThrottleCoalescesAndDeliversTrailing(t *testing.T) {
	clk := newFakeClock()
	sink := &progSink{}
	th := newProgressThrottle(clk, 100*time.Millisecond, sink.emit)

	th.Offer(JobProgress{ID: "a", Progress: 0.1})
	if got := sink.list(); len(got) != 1 || got[0].Progress != 0.1 {
		t.Fatalf("first offer should emit immediately, got %v", got)
	}
	for i, p := range []float64{0.2, 0.3, 0.4} {
		clk.Advance(10 * time.Millisecond)
		th.Offer(JobProgress{ID: "a", Progress: p})
		if n := len(sink.list()); n != 1 {
			t.Fatalf("offer %d emitted early: %d events", i, n)
		}
	}
	clk.Advance(70 * time.Millisecond) // reaches 100ms after first emit
	got := sink.list()
	if len(got) != 2 || got[1].Progress != 0.4 {
		t.Fatalf("trailing value not delivered: %v", got)
	}
	// After a quiet period the next offer emits immediately.
	clk.Advance(200 * time.Millisecond)
	th.Offer(JobProgress{ID: "a", Progress: 0.9})
	if got := sink.list(); len(got) != 3 || got[2].Progress != 0.9 {
		t.Fatalf("offer after quiet period: %v", got)
	}
}

func TestThrottleKeysIndependentAndNoTrailingWithoutPending(t *testing.T) {
	clk := newFakeClock()
	sink := &progSink{}
	th := newProgressThrottle(clk, 100*time.Millisecond, sink.emit)
	th.Offer(JobProgress{ID: "a", Progress: 0.1})
	th.Offer(JobProgress{ID: "b", Progress: 0.2})
	if n := len(sink.list()); n != 2 {
		t.Fatalf("keys should not throttle each other: %d", n)
	}
	clk.Advance(time.Second)
	if n := len(sink.list()); n != 2 {
		t.Fatalf("no pending value, no trailing emit: %d", n)
	}
}

func TestThrottleForgetAndClose(t *testing.T) {
	clk := newFakeClock()
	sink := &progSink{}
	th := newProgressThrottle(clk, 100*time.Millisecond, sink.emit)
	th.Offer(JobProgress{ID: "a", Progress: 0.1})
	th.Offer(JobProgress{ID: "a", Progress: 0.5})
	th.Forget("a")
	clk.Advance(time.Second)
	if n := len(sink.list()); n != 1 {
		t.Fatalf("Forget should drop pending: %d", n)
	}
	th.Offer(JobProgress{ID: "b", Progress: 0.1})
	th.Offer(JobProgress{ID: "b", Progress: 0.5})
	th.Close()
	clk.Advance(time.Second)
	th.Offer(JobProgress{ID: "c", Progress: 1})
	if n := len(sink.list()); n != 2 {
		t.Fatalf("Close should stop timers and ignore offers: %d", n)
	}
}
