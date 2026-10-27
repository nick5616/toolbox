package core

import (
	"sync"
	"time"
)

// clock abstracts time so throttling and log batching are testable.
type clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) timerHandle
}

type timerHandle interface{ Stop() bool }

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }
func (realClock) AfterFunc(d time.Duration, f func()) timerHandle {
	return time.AfterFunc(d, f)
}

const (
	progressInterval = 100 * time.Millisecond
	logEventInterval = 150 * time.Millisecond
	logFlushInterval = 500 * time.Millisecond
)

type throttleEntry struct {
	last    time.Time
	pending *JobProgress
	timer   timerHandle
}

// progressThrottle emits at most one JobProgress per interval per job and
// always delivers the trailing value.
type progressThrottle struct {
	clk      clock
	interval time.Duration
	emit     func(JobProgress)

	mu     sync.Mutex
	ents   map[string]*throttleEntry
	closed bool

	emitMu sync.Mutex // keeps emissions ordered
}

func newProgressThrottle(clk clock, interval time.Duration, emit func(JobProgress)) *progressThrottle {
	return &progressThrottle{clk: clk, interval: interval, emit: emit, ents: map[string]*throttleEntry{}}
}

// Offer submits a value; it is emitted now, or coalesced into a trailing emit.
func (t *progressThrottle) Offer(p JobProgress) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	e := t.ents[p.ID]
	if e == nil {
		e = &throttleEntry{}
		t.ents[p.ID] = e
	}
	now := t.clk.Now()
	if e.timer == nil && (e.last.IsZero() || now.Sub(e.last) >= t.interval) {
		e.last = now
		t.emitMu.Lock() // taken before releasing mu to preserve order
		t.mu.Unlock()
		t.emit(p)
		t.emitMu.Unlock()
		return
	}
	e.pending = &p
	if e.timer == nil {
		id := p.ID
		e.timer = t.clk.AfterFunc(t.interval-now.Sub(e.last), func() { t.fire(id) })
	}
	t.mu.Unlock()
}

func (t *progressThrottle) fire(id string) {
	t.mu.Lock()
	e := t.ents[id]
	if t.closed || e == nil {
		t.mu.Unlock()
		return
	}
	e.timer = nil
	p := e.pending
	e.pending = nil
	if p == nil {
		t.mu.Unlock()
		return
	}
	e.last = t.clk.Now()
	t.emitMu.Lock()
	t.mu.Unlock()
	t.emit(*p)
	t.emitMu.Unlock()
}

// Forget discards pending state for id (job finished).
func (t *progressThrottle) Forget(id string) {
	t.mu.Lock()
	if e := t.ents[id]; e != nil && e.timer != nil {
		e.timer.Stop()
	}
	delete(t.ents, id)
	t.mu.Unlock()
}

// Close stops all timers; later Offers are ignored.
func (t *progressThrottle) Close() {
	t.mu.Lock()
	t.closed = true
	for _, e := range t.ents {
		if e.timer != nil {
			e.timer.Stop()
		}
	}
	t.ents = map[string]*throttleEntry{}
	t.mu.Unlock()
}
