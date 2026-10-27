package core

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"
)

// memDB is an in-memory JobStore + OutputStore mirroring core/interfaces.go.
type memDB struct {
	mu      sync.Mutex
	jobs    map[string]Job
	logs    map[string][]LogLine
	outputs map[string]Output
}

func newMemDB() *memDB {
	return &memDB{jobs: map[string]Job{}, logs: map[string][]LogLine{}, outputs: map[string]Output{}}
}

func (d *memDB) withOutputs(j Job) Job {
	outs := []Output{}
	for _, o := range d.outputs {
		if o.JobID == j.ID {
			outs = append(outs, o)
		}
	}
	sort.Slice(outs, func(a, b int) bool {
		return outs[a].CreatedAt < outs[b].CreatedAt || (outs[a].CreatedAt == outs[b].CreatedAt && outs[a].ID < outs[b].ID)
	})
	j.Outputs = outs
	return j
}

func (d *memDB) InsertJob(_ context.Context, j Job) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.jobs[j.ID]; ok {
		return fmt.Errorf("duplicate job %s", j.ID)
	}
	d.jobs[j.ID] = j
	return nil
}

func (d *memDB) UpdateJob(_ context.Context, j Job) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.jobs[j.ID]; !ok {
		return Errorf(CodeNotFound, "job not found")
	}
	d.jobs[j.ID] = j
	return nil
}

func (d *memDB) GetJob(_ context.Context, id string) (Job, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	j, ok := d.jobs[id]
	if !ok {
		return Job{}, Errorf(CodeNotFound, "job not found")
	}
	return d.withOutputs(j), nil
}

func (d *memDB) ListJobs(_ context.Context, f JobFilter) ([]Job, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []Job{}
	for _, j := range d.jobs {
		if f.ModuleID != "" && j.ModuleID != f.ModuleID {
			continue
		}
		if len(f.Statuses) > 0 {
			ok := false
			for _, s := range f.Statuses {
				ok = ok || s == j.Status
			}
			if !ok {
				continue
			}
		}
		out = append(out, d.withOutputs(j))
	}
	sort.Slice(out, func(a, b int) bool {
		if out[a].CreatedAt != out[b].CreatedAt {
			return out[a].CreatedAt > out[b].CreatedAt
		}
		return out[a].ID > out[b].ID
	})
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (d *memDB) DeleteJobs(_ context.Context, ids []string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, id := range ids {
		delete(d.jobs, id)
		delete(d.logs, id)
		for k, o := range d.outputs {
			if o.JobID == id {
				o.JobID = ""
				d.outputs[k] = o
			}
		}
	}
	return nil
}

func (d *memDB) AppendLogs(_ context.Context, id string, lines []LogLine) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.logs[id] = append(d.logs[id], lines...)
	return nil
}

func (d *memDB) Logs(_ context.Context, id string) ([]LogLine, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]LogLine{}, d.logs[id]...), nil
}

func (d *memDB) CountLogs(_ context.Context, id string) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.logs[id]), nil
}

func (d *memDB) UpsertOutput(_ context.Context, o Output) (Output, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for id, ex := range d.outputs {
		if ex.Path == o.Path {
			ex.JobID, ex.ModuleID, ex.SizeBytes, ex.CreatedAt = o.JobID, o.ModuleID, o.SizeBytes, o.CreatedAt
			d.outputs[id] = ex
			return ex, nil
		}
	}
	d.outputs[o.ID] = o
	return o, nil
}

func (d *memDB) GetOutput(_ context.Context, id string) (Output, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	o, ok := d.outputs[id]
	if !ok {
		return Output{}, Errorf(CodeNotFound, "output not found")
	}
	return o, nil
}

func (d *memDB) ListOutputs(context.Context, OutputQuery) (OutputPage, error) {
	return OutputPage{Items: []Output{}}, nil
}

func (d *memDB) DeleteOutput(_ context.Context, id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.outputs, id)
	return nil
}

func (d *memDB) logCount(id string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.logs[id])
}

// recEmitter records events and lets tests wait for conditions.
type recEvent struct {
	Name string
	Data any
}

type recEmitter struct {
	mu     sync.Mutex
	events []recEvent
	notify chan struct{}
}

func newRecEmitter() *recEmitter { return &recEmitter{notify: make(chan struct{})} }

func (r *recEmitter) Emit(name string, data any) {
	r.mu.Lock()
	r.events = append(r.events, recEvent{name, data})
	old := r.notify
	r.notify = make(chan struct{})
	r.mu.Unlock()
	close(old)
}

func (r *recEmitter) all() []recEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recEvent{}, r.events...)
}

func (r *recEmitter) named(name string) []recEvent {
	var out []recEvent
	for _, e := range r.all() {
		if e.Name == name {
			out = append(out, e)
		}
	}
	return out
}

// waitFor blocks until pred(events) is true.
func (r *recEmitter) waitFor(t *testing.T, what string, pred func([]recEvent) bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		r.mu.Lock()
		ok := pred(r.events)
		ch := r.notify
		r.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-ch:
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// lastJob returns the last jobs:changed payload for id.
func lastJob(evs []recEvent, id string) (Job, bool) {
	var out Job
	found := false
	for _, e := range evs {
		if e.Name != EventJobsChanged {
			continue
		}
		if j, ok := e.Data.(Job); ok && j.ID == id {
			out, found = j, true
		}
	}
	return out, found
}

func (r *recEmitter) waitStatus(t *testing.T, id string, st JobStatus) Job {
	t.Helper()
	r.waitFor(t, fmt.Sprintf("job %s to be %s", id, st), func(evs []recEvent) bool {
		j, ok := lastJob(evs, id)
		return ok && j.Status == st
	})
	j, _ := lastJob(r.all(), id)
	return j
}

// scriptMod is a Module whose behaviour is supplied by the test.
type scriptMod struct {
	d        Descriptor
	validate func([]string, json.RawMessage) error
	run      func(ctx context.Context, jc *JobContext) error
}

func (m *scriptMod) Descriptor() Descriptor { return m.d }
func (m *scriptMod) Validate(in []string, o json.RawMessage) error {
	if m.validate != nil {
		return m.validate(in, o)
	}
	return nil
}
func (m *scriptMod) Run(ctx context.Context, jc *JobContext) error {
	if m.run != nil {
		return m.run(ctx, jc)
	}
	return nil
}

// fakeClock is a manual clock for throttle tests.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	c       *fakeClock
	when    time.Time
	f       func()
	stopped bool
	fired   bool
}

func newFakeClock() *fakeClock { return &fakeClock{now: time.Unix(1000, 0)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) timerHandle {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{c: c, when: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

func (t *fakeTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	was := !t.stopped && !t.fired
	t.stopped = true
	return was
}

// Advance moves time forward, firing due timers in order.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	target := c.now.Add(d)
	for {
		var next *fakeTimer
		for _, t := range c.timers {
			if !t.stopped && !t.fired && !t.when.After(target) && (next == nil || t.when.Before(next.when)) {
				next = t
			}
		}
		if next == nil {
			break
		}
		next.fired = true
		c.now = next.when
		c.mu.Unlock()
		next.f()
		c.mu.Lock()
	}
	c.now = target
	c.mu.Unlock()
}
