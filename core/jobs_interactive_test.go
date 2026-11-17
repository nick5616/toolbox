package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Interactive jobs jump the queue and may use one slot beyond the limit.
func TestInteractiveJobsUseExtraSlotAndGoFirst(t *testing.T) {
	gate := make(chan struct{})
	started := make(chan string, 32)
	run := func(ctx context.Context, jc *JobContext) error {
		started <- jc.Inputs[0]
		<-gate
		return nil
	}
	batch := mod("batch", run)
	batch.d.SplitInputs = true
	ui := mod("ui", run)
	ui.d.SplitInputs = true
	ui.d.Interactive = true
	ui.d.MaxConcurrent = 2
	e := setup(t, 2, batch, ui)
	e.start(t)

	e.submit(t, "batch", "b1", "b2", "b3", "b4")
	recv(t, started)
	recv(t, started)
	if n := e.running(); n != 2 {
		t.Fatalf("running = %d, want 2", n)
	}
	// Two interactive jobs: the first takes the extra slot; the second must
	// wait (limit+1 is taken).
	e.submit(t, "ui", "u1", "u2")
	if got := recv(t, started); got != "u1" {
		t.Fatalf("started %q, want u1", got)
	}
	select {
	case got := <-started:
		t.Fatalf("%q started beyond limit+1", got)
	case <-time.After(150 * time.Millisecond):
	}
	if n := e.running(); n != 3 {
		t.Fatalf("running = %d, want 3", n)
	}
	// Once slots free up, the queued interactive job goes before batch jobs.
	gate <- struct{}{}
	gate <- struct{}{}
	order := []string{recv(t, started)}
	close(gate)
	for range 2 {
		order = append(order, recv(t, started))
	}
	if order[0] != "u2" {
		t.Fatalf("start order = %v, want u2 first", order)
	}
}

// A per-job InteractiveJobs module is honoured.
type perJobMod struct{ *scriptMod }

func (perJobMod) IsInteractive(o json.RawMessage) bool { return string(o) == `{"fast":true}` }

func TestInteractivePerJob(t *testing.T) {
	gate := make(chan struct{})
	started := make(chan string, 8)
	run := func(ctx context.Context, jc *JobContext) error {
		started <- string(jc.Options)
		<-gate
		return nil
	}
	pm := perJobMod{mod("p", run)}
	e := &env{db: newMemDB(), em: newRecEmitter(), reg: NewRegistry(), tmp: filepath.Join(t.TempDir(), "tmp"), lib: t.TempDir()}
	must(t, e.reg.Register(pm))
	e.m = NewJobs(e.db, e.db, e.reg, e.em, func(id string) (string, error) { return id, nil },
		func() Settings { return Settings{LibraryDir: e.lib, Concurrency: 1} }, e.tmp)
	t.Cleanup(func() { close(gate); _ = e.m.Shutdown(5 * time.Second) })
	e.start(t)
	submit := func(o string) {
		_, err := e.m.Submit(context.Background(), "p", []string{"x"}, o)
		must(t, err)
	}
	submit(`{"slow":1}`)
	recv(t, started)
	submit(`{"slow":2}`)
	submit(`{"fast":true}`)
	if got := recv(t, started); got != `{"fast":true}` {
		t.Fatalf("started %s, want the fast job", got)
	}
}

// Outputs coalesce jobs:changed; the final snapshot carries every output and
// observers see each output at once.
func TestOutputsCoalesceJobsChanged(t *testing.T) {
	const n = 40
	release := make(chan struct{})
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		for i := range n {
			p := filepath.Join(jc.OutputDir, fmt.Sprintf("f%02d.txt", i))
			if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
				return err
			}
			if _, err := jc.Output(p); err != nil {
				return err
			}
		}
		<-release
		return nil
	})
	e := setup(t, 1, m)
	seen := make(chan int, 4*n)
	e.m.Observe(func(j Job) { seen <- len(j.Outputs) })
	e.start(t)
	j := e.submit(t, "a", "x")[0]

	deadline := time.After(10 * time.Second)
	for most := 0; most < n; {
		select {
		case v := <-seen:
			most = v
		case <-deadline:
			t.Fatal("observers did not see all outputs")
		}
	}
	changed := 0
	for _, ev := range e.em.named(EventJobsChanged) {
		if ev.Data.(Job).ID == j.ID {
			changed++
		}
	}
	if changed > 5 {
		t.Fatalf("%d jobs:changed events for %d outputs while running", changed, n)
	}
	close(release)
	done := e.em.waitStatus(t, j.ID, JobDone)
	if len(done.Outputs) != n {
		t.Fatalf("final snapshot has %d outputs, want %d", len(done.Outputs), n)
	}
}

// The coalesced emit fires on the timer with the latest snapshot.
func TestOutputEmitTrailingTimer(t *testing.T) {
	e := setup(t, 1)
	fc := newFakeClock()
	e.m.clk = fc
	aj := &activeJob{job: Job{ID: "j1", ModuleID: "none", Outputs: []Output{{ID: "o1"}}}}
	e.m.publishOutput(aj)
	aj.job.Outputs = append(aj.job.Outputs, Output{ID: "o2"})
	e.m.publishOutput(aj) // coalesced into the same timer
	if got := len(e.em.named(EventJobsChanged)); got != 0 {
		t.Fatalf("emitted %d before the timer", got)
	}
	fc.Advance(outputEmitInterval)
	evs := e.em.named(EventJobsChanged)
	if len(evs) != 1 || len(evs[0].Data.(Job).Outputs) != 2 {
		t.Fatalf("events = %+v", evs)
	}
}
