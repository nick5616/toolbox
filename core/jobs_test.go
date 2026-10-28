package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type env struct {
	m   *Jobs
	db  *memDB
	em  *recEmitter
	reg *Registry
	tmp string
	lib string
}

func mod(id string, run func(ctx context.Context, jc *JobContext) error) *scriptMod {
	return &scriptMod{d: Descriptor{ID: id, Name: "Mod " + id, Status: StatusReady, OutputSubdir: "out"}, run: run}
}

func setup(t *testing.T, conc int, mods ...*scriptMod) *env {
	t.Helper()
	e := &env{db: newMemDB(), em: newRecEmitter(), reg: NewRegistry(), tmp: filepath.Join(t.TempDir(), "tmp"), lib: t.TempDir()}
	for _, m := range mods {
		must(t, e.reg.Register(m))
	}
	e.m = NewJobs(e.db, e.db, e.reg, e.em, func(id string) (string, error) { return "/bin/" + id, nil },
		func() Settings { return Settings{LibraryDir: e.lib, Concurrency: conc} }, e.tmp)
	t.Cleanup(func() { _ = e.m.Shutdown(5 * time.Second) })
	return e
}

func (e *env) start(t *testing.T) {
	t.Helper()
	must(t, e.m.Start(context.Background()))
}

func (e *env) submit(t *testing.T, mod string, inputs ...string) []Job {
	t.Helper()
	jobs, err := e.m.Submit(context.Background(), mod, inputs, "")
	must(t, err)
	return jobs
}

func (e *env) running() int {
	e.m.mu.Lock()
	defer e.m.mu.Unlock()
	n := 0
	for _, aj := range e.m.active {
		if aj.job.Status == JobRunning {
			n++
		}
	}
	return n
}

func recv(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting on channel")
		return ""
	}
}

func TestSubmitFIFOAndSplit(t *testing.T) {
	var mu sync.Mutex
	var order []string
	m := mod("a", func(_ context.Context, jc *JobContext) error {
		mu.Lock()
		order = append(order, jc.Inputs[0])
		mu.Unlock()
		return nil
	})
	m.d.SplitInputs = true
	e := setup(t, 1, m)
	e.start(t)
	in := []string{"1", "2", "3", "4", "5", "6"}
	jobs := e.submit(t, "a", in...)
	if len(jobs) != 6 {
		t.Fatalf("want 6 jobs, got %d", len(jobs))
	}
	for _, j := range jobs {
		e.em.waitStatus(t, j.ID, JobDone)
	}
	if !slices.Equal(order, in) {
		t.Fatalf("order = %v", order)
	}
}

func TestSubmitNormalisesInputs(t *testing.T) {
	e := setup(t, 1, mod("a", nil))
	jobs := e.submit(t, "a", "  x ", "", "y", "x", "   ")
	if len(jobs) != 1 || !slices.Equal(jobs[0].Inputs, []string{"x", "y"}) {
		t.Fatalf("jobs = %+v", jobs)
	}
	if jobs[0].Title != "x" || jobs[0].Status != JobQueued || jobs[0].Attempt != 1 || jobs[0].OptionsJSON != "{}" {
		t.Fatalf("job = %+v", jobs[0])
	}
	none := e.submit(t, "a")
	if len(none) != 1 || none[0].Title != "Mod a" {
		t.Fatalf("no-input job = %+v", none)
	}
}

func TestSubmitErrorsCreateNoJobs(t *testing.T) {
	bad := ValidationError("nope", map[string]string{"x": "y"})
	m := mod("a", nil)
	m.validate = func([]string, json.RawMessage) error { return bad }
	e := setup(t, 1, m)
	must(t, e.reg.RegisterPlaceholder(Descriptor{ID: "soon", Name: "Soon"}))

	_, err := e.m.Submit(context.Background(), "a", []string{"x"}, "")
	if err != bad {
		t.Fatalf("validate error not returned unchanged: %v", err)
	}
	if _, err := e.m.Submit(context.Background(), "zzz", nil, ""); !IsCode(err, CodeNotFound) {
		t.Fatalf("unknown module: %v", err)
	}
	_, err = e.m.Submit(context.Background(), "soon", nil, "")
	if !IsCode(err, CodeValidation) || !strings.Contains(err.Error(), "Soon is coming soon") {
		t.Fatalf("placeholder: %v", err)
	}
	e2 := setup(t, 1, mod("b", nil))
	if _, err := e2.m.Submit(context.Background(), "b", nil, "{bad"); !IsCode(err, CodeValidation) {
		t.Fatalf("bad json: %v", err)
	}
	for _, x := range []*env{e, e2} {
		if jobs, _ := x.m.List(context.Background(), JobFilter{}); len(jobs) != 0 {
			t.Fatalf("jobs created despite error: %v", jobs)
		}
	}
}

func TestConcurrencyLimitNeverExceeded(t *testing.T) {
	var cur, peak atomic.Int32
	started := make(chan string, 20)
	gate := make(chan struct{})
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		n := cur.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		started <- jc.ID
		<-gate
		cur.Add(-1)
		return nil
	})
	m.d.SplitInputs = true
	e := setup(t, 3, m)
	e.start(t)
	var ins []string
	for i := range 10 {
		ins = append(ins, fmt.Sprint(i))
	}
	jobs := e.submit(t, "a", ins...)
	for range 3 {
		recv(t, started)
	}
	e.m.kick()
	if n := e.running(); n != 3 {
		t.Fatalf("running = %d, want 3", n)
	}
	close(gate)
	for _, j := range jobs {
		e.em.waitStatus(t, j.ID, JobDone)
	}
	if peak.Load() != 3 {
		t.Fatalf("peak = %d, want 3", peak.Load())
	}
}

func TestSetConcurrencyUpAndDown(t *testing.T) {
	var cur atomic.Int32
	started := make(chan string, 10)
	gate := make(chan struct{})
	curAtStart := map[string]int32{}
	var mu sync.Mutex
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		n := cur.Add(1)
		mu.Lock()
		curAtStart[jc.Inputs[0]] = n
		mu.Unlock()
		started <- jc.Inputs[0]
		<-gate
		cur.Add(-1)
		return nil
	})
	m.d.SplitInputs = true
	e := setup(t, 1, m)
	e.start(t)
	jobs := e.submit(t, "a", "1", "2", "3", "4")
	recv(t, started)
	e.m.SetConcurrency(3) // up: two more start
	recv(t, started)
	recv(t, started)
	e.m.SetConcurrency(1) // down: running jobs are kept
	e.m.kick()
	if n := e.running(); n != 3 {
		t.Fatalf("lowering killed jobs: running = %d", n)
	}
	gate <- struct{}{}
	gate <- struct{}{}
	gate <- struct{}{}
	recv(t, started) // job 4 only after all three finished
	mu.Lock()
	if curAtStart["4"] != 1 {
		t.Errorf("job 4 started with %d running", curAtStart["4"])
	}
	mu.Unlock()
	gate <- struct{}{}
	for _, j := range jobs {
		e.em.waitStatus(t, j.ID, JobDone)
	}
	e.m.SetConcurrency(100)
	e.m.mu.Lock()
	lim := e.m.limit
	e.m.mu.Unlock()
	if lim != MaxConcurrency {
		t.Fatalf("limit = %d", lim)
	}
}

func TestMaxConcurrentDoesNotBlockOtherModules(t *testing.T) {
	startedA := make(chan string, 5)
	startedB := make(chan string, 5)
	gate := make(chan struct{})
	var curA, peakA atomic.Int32
	a := mod("a", func(ctx context.Context, jc *JobContext) error {
		n := curA.Add(1)
		if n > peakA.Load() {
			peakA.Store(n)
		}
		startedA <- jc.Inputs[0]
		<-gate
		curA.Add(-1)
		return nil
	})
	a.d.SplitInputs = true
	a.d.MaxConcurrent = 1
	b := mod("b", func(ctx context.Context, jc *JobContext) error {
		startedB <- "b"
		<-gate
		return nil
	})
	e := setup(t, 3, a, b)
	e.start(t)
	ja := e.submit(t, "a", "1", "2")
	jb := e.submit(t, "b", "x")
	recv(t, startedA)
	recv(t, startedB) // b runs although a2 is queued ahead of it
	e.m.kick()
	if n := e.running(); n != 2 {
		t.Fatalf("running = %d, want 2", n)
	}
	close(gate)
	recv(t, startedA)
	for _, j := range append(ja, jb...) {
		e.em.waitStatus(t, j.ID, JobDone)
	}
	if peakA.Load() != 1 {
		t.Fatalf("module a peak = %d", peakA.Load())
	}
}

func TestCancelQueued(t *testing.T) {
	started := make(chan string, 2)
	gate := make(chan struct{})
	var ran atomic.Int32
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		ran.Add(1)
		started <- jc.Inputs[0]
		<-gate
		return nil
	})
	m.d.SplitInputs = true
	e := setup(t, 1, m)
	e.start(t)
	jobs := e.submit(t, "a", "1", "2")
	recv(t, started)
	must(t, e.m.Cancel(jobs[1].ID))
	j, _ := e.m.Get(context.Background(), jobs[1].ID)
	if j.Status != JobCancelled || j.FinishedAt == 0 {
		t.Fatalf("job = %+v", j)
	}
	if stored := e.db.jobs[jobs[1].ID]; stored.Status != JobCancelled {
		t.Fatalf("not persisted: %v", stored.Status)
	}
	close(gate)
	e.em.waitStatus(t, jobs[0].ID, JobDone)
	if ran.Load() != 1 {
		t.Fatalf("cancelled job ran")
	}
	must(t, e.m.Cancel(jobs[0].ID)) // finished: no-op
	if err := e.m.Cancel("nope"); !IsCode(err, CodeNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}

func TestCancelRunningWinsOverError(t *testing.T) {
	started := make(chan string, 1)
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		started <- "x"
		<-ctx.Done()
		return errors.New("boom")
	})
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	recv(t, started)
	must(t, e.m.Cancel(j.ID))
	got := e.em.waitStatus(t, j.ID, JobCancelled)
	if !got.CancelRequested || got.Error != "" || got.ErrorCode != "" {
		t.Fatalf("job = %+v", got)
	}
}

func TestCancelAll(t *testing.T) {
	started := make(chan string, 4)
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		started <- "x"
		<-ctx.Done()
		return ctx.Err()
	})
	m.d.SplitInputs = true
	e := setup(t, 2, m)
	e.start(t)
	jobs := e.submit(t, "a", "1", "2", "3", "4")
	recv(t, started)
	recv(t, started)
	e.m.CancelAll()
	for _, j := range jobs {
		e.em.waitStatus(t, j.ID, JobCancelled)
	}
	if e.m.HasActive("a") {
		t.Fatal("still active")
	}
}

func TestPanicBecomesInternalAndTempRemoved(t *testing.T) {
	m := mod("a", func(ctx context.Context, jc *JobContext) error { panic("kaboom") })
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	got := e.em.waitStatus(t, j.ID, JobFailed)
	if got.ErrorCode != CodeInternal {
		t.Fatalf("job = %+v", got)
	}
	// manager survives and keeps scheduling
	j2 := e.submit(t, "a", "y")[0]
	e.em.waitStatus(t, j2.ID, JobFailed)
}

func TestTempDirRemovedInAllOutcomes(t *testing.T) {
	var mu sync.Mutex
	dirs := map[string]string{}
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		if st, err := os.Stat(jc.TempDir); err != nil || !st.IsDir() {
			return fmt.Errorf("temp dir missing: %v", err)
		}
		if st, err := os.Stat(jc.OutputDir); err != nil || !st.IsDir() {
			return fmt.Errorf("output dir missing: %v", err)
		}
		must(t, os.WriteFile(filepath.Join(jc.TempDir, "junk"), []byte("x"), 0o644))
		mu.Lock()
		dirs[jc.Inputs[0]] = jc.TempDir
		mu.Unlock()
		switch jc.Inputs[0] {
		case "fail":
			return errors.New("x")
		case "panic":
			panic("x")
		case "cancel":
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	})
	m.d.SplitInputs = true
	e := setup(t, 4, m)
	e.start(t)
	jobs := e.submit(t, "a", "ok", "fail", "panic", "cancel")
	e.em.waitStatus(t, jobs[0].ID, JobDone)
	e.em.waitStatus(t, jobs[1].ID, JobFailed)
	e.em.waitStatus(t, jobs[2].ID, JobFailed)
	e.em.waitFor(t, "cancel job running", func(evs []recEvent) bool {
		j, _ := lastJob(evs, jobs[3].ID)
		return j.Status == JobRunning
	})
	mu.Lock()
	ready := len(dirs) == 4
	mu.Unlock()
	for !ready { // wait until the cancel job has recorded its dir
		time.Sleep(time.Millisecond)
		mu.Lock()
		ready = len(dirs) == 4
		mu.Unlock()
	}
	must(t, e.m.Cancel(jobs[3].ID))
	e.em.waitStatus(t, jobs[3].ID, JobCancelled)
	mu.Lock()
	defer mu.Unlock()
	for in, d := range dirs {
		if _, err := os.Stat(d); !os.IsNotExist(err) {
			t.Errorf("%s: temp dir %s still exists", in, d)
		}
	}
}

func TestLibraryDirUnavailable(t *testing.T) {
	e := setup(t, 1, mod("a", nil))
	file := filepath.Join(t.TempDir(), "file")
	must(t, os.WriteFile(file, []byte("x"), 0o644))
	e.lib = filepath.Join(file, "sub") // a path below a regular file
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	got := e.em.waitStatus(t, j.ID, JobFailed)
	if got.ErrorCode != CodeValidation || !strings.HasPrefix(got.Error, "Library folder unavailable: ") {
		t.Fatalf("job = %+v", got)
	}
}

func TestProgressMonotonicAndOverlay(t *testing.T) {
	step := make(chan struct{})
	next := make(chan struct{})
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		jc.Progress(0.5, "half")
		step <- struct{}{}
		<-next
		jc.Progress(0.3, "back")
		step <- struct{}{}
		<-next
		jc.Progress(1.7, "over")
		step <- struct{}{}
		<-next
		jc.Progress(IndeterminateProgress, "unknown")
		step <- struct{}{}
		<-next
		return nil
	})
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	check := func(want float64, msg string) {
		t.Helper()
		<-step
		g, err := e.m.Get(context.Background(), j.ID)
		must(t, err)
		if g.Progress != want || g.Message != msg {
			t.Fatalf("progress = %v %q, want %v %q", g.Progress, g.Message, want, msg)
		}
		l, _ := e.m.List(context.Background(), JobFilter{})
		if l[0].Progress != want {
			t.Fatalf("list overlay = %v", l[0].Progress)
		}
		next <- struct{}{}
	}
	check(0.5, "half")
	check(0.5, "back")
	check(1, "over")
	check(-1, "unknown")
	done := e.em.waitStatus(t, j.ID, JobDone)
	// A finished job keeps the module's last message (e.g. "Already up to date").
	if done.Progress != 1 || done.Message != "unknown" {
		t.Fatalf("done job = %+v", done)
	}
}

func TestProgressEventsThrottled(t *testing.T) {
	clk := newFakeClock()
	gate := make(chan struct{})
	reported := make(chan struct{})
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		for i := 1; i <= 10; i++ {
			jc.Progress(float64(i)/10, "p")
		}
		close(reported)
		<-gate
		return nil
	})
	e := setup(t, 1, m)
	e.m.clk = clk
	e.m.prog = newProgressThrottle(clk, progressInterval, func(p JobProgress) { e.em.Emit(EventJobsProgress, p) })
	e.start(t)
	e.submit(t, "a", "x")
	<-reported
	evs := e.em.named(EventJobsProgress)
	if len(evs) != 1 {
		t.Fatalf("want 1 immediate progress event, got %d", len(evs))
	}
	clk.Advance(progressInterval)
	evs = e.em.named(EventJobsProgress)
	if len(evs) != 2 || evs[1].Data.(JobProgress).Progress != 1 {
		t.Fatalf("trailing not delivered: %v", evs)
	}
	close(gate)
}

func TestLogCapAndTruncation(t *testing.T) {
	long := strings.Repeat("é", 5000)
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		jc.Log(StreamStdout, long)
		for i := 1; i < 10050; i++ {
			jc.Log(StreamStdout, fmt.Sprintf("line %d", i))
		}
		return nil
	})
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	e.em.waitStatus(t, j.ID, JobDone)

	lines, err := e.m.Logs(context.Background(), j.ID)
	must(t, err)
	if len(lines) != maxPersistedLogs+1 {
		t.Fatalf("persisted %d lines, want %d", len(lines), maxPersistedLogs+1)
	}
	last := lines[len(lines)-1]
	if last.Text != logTruncatedMessage || last.Stream != StreamSystem {
		t.Fatalf("last = %+v", last)
	}
	if !strings.HasSuffix(lines[0].Text, "…") || len(lines[0].Text) > maxLogLineBytes+len("…") {
		t.Fatalf("long line not truncated: %d bytes", len(lines[0].Text))
	}
	for i, l := range lines {
		if l.Seq != i+1 {
			t.Fatalf("seq[%d] = %d", i, l.Seq)
		}
	}
	// live events still carry the dropped lines
	total := 0
	for _, ev := range e.em.named(EventJobsLog) {
		total += len(ev.Data.(JobLogBatch).Lines)
	}
	if total != 10050+1 {
		t.Fatalf("live lines = %d, want %d", total, 10051)
	}
}

func TestLogsIncludeBufferedAndNotFound(t *testing.T) {
	started := make(chan struct{})
	gate := make(chan struct{})
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		jc.Logf("one")
		jc.Log(StreamStderr, "two")
		close(started)
		<-gate
		return nil
	})
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	<-started
	lines, err := e.m.Logs(context.Background(), j.ID)
	must(t, err)
	if len(lines) != 2 || lines[0].Text != "one" || lines[1].Stream != StreamStderr {
		t.Fatalf("lines = %+v", lines)
	}
	close(gate)
	e.em.waitStatus(t, j.ID, JobDone)
	if e.db.logCount(j.ID) != 2 {
		t.Fatalf("logs not flushed on finish")
	}
	if _, err := e.m.Logs(context.Background(), "nope"); !IsCode(err, CodeNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestLogBatchingTimers(t *testing.T) {
	clk := newFakeClock()
	db := newMemDB()
	em := newRecEmitter()
	l := newJobLog("j", 0, db, em, clk)
	l.add(StreamStdout, "a")
	l.add(StreamStdout, "b")
	if len(em.named(EventJobsLog)) != 0 || db.logCount("j") != 0 {
		t.Fatal("flushed too early")
	}
	clk.Advance(logEventInterval)
	evs := em.named(EventJobsLog)
	if len(evs) != 1 || len(evs[0].Data.(JobLogBatch).Lines) != 2 || db.logCount("j") != 0 {
		t.Fatalf("event batch: %v, persisted %d", evs, db.logCount("j"))
	}
	clk.Advance(logFlushInterval)
	if db.logCount("j") != 2 {
		t.Fatalf("persisted %d", db.logCount("j"))
	}
	l.add(StreamStdout, "c")
	l.finish()
	if db.logCount("j") != 3 || len(em.named(EventJobsLog)) != 2 {
		t.Fatal("finish should flush")
	}
	l.add(StreamStdout, "ignored")
	clk.Advance(time.Second)
	if db.logCount("j") != 3 {
		t.Fatal("add after finish")
	}
}

func TestRetry(t *testing.T) {
	var attempts atomic.Int32
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		jc.Logf("work %d", jc.Attempt)
		p := filepath.Join(jc.OutputDir, "file.txt")
		must(t, os.WriteFile(p, []byte("x"), 0o644))
		if _, err := jc.Output(p); err != nil {
			return err
		}
		if attempts.Add(1) == 1 {
			return ValidationError("first fails", nil).WithHint("try again")
		}
		return nil
	})
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	failed := e.em.waitStatus(t, j.ID, JobFailed)
	if failed.Error != "first fails" || failed.ErrorHint != "try again" || failed.ErrorCode != CodeValidation {
		t.Fatalf("failed = %+v", failed)
	}
	if len(failed.Outputs) != 1 {
		t.Fatalf("outputs = %v", failed.Outputs)
	}
	r, err := e.m.Retry(context.Background(), j.ID)
	must(t, err)
	if r.Attempt != 2 || r.Status != JobQueued || r.Error != "" || r.FinishedAt != 0 || r.Progress != 0 {
		t.Fatalf("retried = %+v", r)
	}
	done := e.em.waitStatus(t, j.ID, JobDone)
	if done.Attempt != 2 || len(done.Outputs) != 1 {
		t.Fatalf("done = %+v", done)
	}
	lines, _ := e.m.Logs(context.Background(), j.ID)
	var texts []string
	for i, l := range lines {
		texts = append(texts, l.Text)
		if l.Seq != i+1 {
			t.Fatalf("seq not continuous: %+v", lines)
		}
	}
	want := []string{"work 1", "── attempt 2 ──", "work 2"}
	if !slices.Equal(texts, want) {
		t.Fatalf("logs = %v, want %v", texts, want)
	}
	// conflicts
	if _, err := e.m.Retry(context.Background(), j.ID); !IsCode(err, CodeConflict) {
		t.Fatalf("retry done: %v", err)
	}
	if _, err := e.m.Retry(context.Background(), "nope"); !IsCode(err, CodeNotFound) {
		t.Fatalf("retry unknown: %v", err)
	}
}

func TestRetryRunningConflict(t *testing.T) {
	started := make(chan string, 1)
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		started <- "x"
		<-ctx.Done()
		return nil
	})
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	recv(t, started)
	if _, err := e.m.Retry(context.Background(), j.ID); !IsCode(err, CodeConflict) {
		t.Fatalf("retry running: %v", err)
	}
	if err := e.m.Remove(context.Background(), j.ID); !IsCode(err, CodeConflict) {
		t.Fatalf("remove running: %v", err)
	}
	if !e.m.HasActive("a") || e.m.HasActive("other") {
		t.Fatal("HasActive wrong")
	}
	must(t, e.m.Cancel(j.ID))
	e.em.waitStatus(t, j.ID, JobCancelled)
}

func TestRemoveAndClearFinished(t *testing.T) {
	started := make(chan string, 1)
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		switch jc.Inputs[0] {
		case "hold":
			started <- "x"
			<-ctx.Done()
			return nil
		case "fail":
			return errors.New("x")
		case "out":
			p := filepath.Join(jc.OutputDir, "o.txt")
			must(t, os.WriteFile(p, []byte("x"), 0o644))
			_, err := jc.Output(p)
			return err
		}
		return nil
	})
	m.d.SplitInputs = true
	e := setup(t, 4, m)
	e.start(t)
	jobs := e.submit(t, "a", "ok", "fail", "out")
	for i, st := range []JobStatus{JobDone, JobFailed, JobDone} {
		e.em.waitStatus(t, jobs[i].ID, st)
	}
	hold := e.submit(t, "a", "hold")[0]
	recv(t, started)

	ctx := context.Background()
	must(t, e.m.Remove(ctx, jobs[2].ID))
	if _, err := e.m.Get(ctx, jobs[2].ID); !IsCode(err, CodeNotFound) {
		t.Fatalf("removed job still present: %v", err)
	}
	e.db.mu.Lock()
	for _, o := range e.db.outputs {
		if o.JobID != "" {
			t.Errorf("output still linked to removed job")
		}
	}
	nOut := len(e.db.outputs)
	e.db.mu.Unlock()
	if nOut != 1 {
		t.Fatalf("output was deleted")
	}
	if got := e.em.named(EventJobsRemoved); len(got) != 1 {
		t.Fatalf("removed events = %d", len(got))
	}
	n, err := e.m.ClearFinished(ctx)
	must(t, err)
	if n != 2 {
		t.Fatalf("cleared %d, want 2", n)
	}
	if _, err := e.m.Get(ctx, hold.ID); err != nil {
		t.Fatalf("running job was cleared: %v", err)
	}
	if n, _ := e.m.ClearFinished(ctx); n != 0 {
		t.Fatalf("second clear = %d", n)
	}
	must(t, e.m.Cancel(hold.ID))
	e.em.waitStatus(t, hold.ID, JobCancelled)
}

func TestOutputHookRegistersAndEmits(t *testing.T) {
	var tool string
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		jc.SetTitle("Nice title")
		p := filepath.Join(jc.OutputDir, "song.mp3")
		must(t, os.WriteFile(p, []byte("abc"), 0o644))
		o1, err := jc.Output(p)
		if err != nil {
			return err
		}
		o2, err := jc.Output(p) // same path: same ID, no duplicate
		if err != nil || o1.ID != o2.ID {
			return fmt.Errorf("re-register: %v %v", err, o2.ID)
		}
		if _, err := jc.Output(filepath.Join(jc.OutputDir, "missing.mp3")); err == nil {
			return errors.New("missing file accepted")
		}
		tool, _ = jc.Tool("ffmpeg")
		return nil
	})
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	done := e.em.waitStatus(t, j.ID, JobDone)
	if len(done.Outputs) != 1 || done.Outputs[0].Kind != KindAudio || done.Outputs[0].JobID != j.ID {
		t.Fatalf("outputs = %+v", done.Outputs)
	}
	if done.Title != "Nice title" {
		t.Fatalf("title = %q", done.Title)
	}
	if tool != "/bin/ffmpeg" {
		t.Fatalf("tool = %q", tool)
	}
	added := e.em.named(EventLibraryAdded)
	if len(added) < 1 || added[0].Data.(Output).Name != "song.mp3" {
		t.Fatalf("library:added = %v", added)
	}
	if !strings.HasPrefix(done.Outputs[0].Path, filepath.Join(e.lib, "out")) {
		t.Fatalf("path = %s", done.Outputs[0].Path)
	}
	stored, _ := e.db.GetJob(context.Background(), j.ID)
	if len(stored.Outputs) != 1 || stored.Title != "Nice title" {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestStartupRecovery(t *testing.T) {
	var mu sync.Mutex
	var order []string
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		mu.Lock()
		order = append(order, jc.Inputs[0])
		mu.Unlock()
		return nil
	})
	e := setup(t, 1, m)
	junk := filepath.Join(e.tmp, "old-job")
	must(t, os.MkdirAll(junk, 0o755))
	must(t, os.WriteFile(filepath.Join(junk, "f"), []byte("x"), 0o644))

	ctx := context.Background()
	mk := func(id string, st JobStatus, created int64) {
		must(t, e.db.InsertJob(ctx, Job{ID: id, ModuleID: "a", Title: id, Status: st, Inputs: []string{id}, OptionsJSON: "{}", Attempt: 1, CreatedAt: created, StartedAt: created}))
	}
	mk("r", JobRunning, 10)
	mk("q3", JobQueued, 30)
	mk("q1", JobQueued, 20)
	mk("q2", JobQueued, 25)
	e.start(t)
	for _, id := range []string{"q1", "q2", "q3"} {
		e.em.waitStatus(t, id, JobDone)
	}
	if !slices.Equal(order, []string{"q1", "q2", "q3"}) {
		t.Fatalf("order = %v", order)
	}
	r, _ := e.db.GetJob(ctx, "r")
	if r.Status != JobFailed || r.ErrorCode != CodeInterrupted || r.Error != "Interrupted when Toolbox quit" || r.ErrorHint != "Retry to run it again" || r.FinishedAt == 0 {
		t.Fatalf("recovered = %+v", r)
	}
	if _, err := os.Stat(junk); !os.IsNotExist(err) {
		t.Fatal("tmp not cleaned")
	}
	if _, err := os.Stat(e.tmp); err != nil {
		t.Fatal("tmp dir itself should remain")
	}
}

func TestShutdownCancelsAndWaits(t *testing.T) {
	started := make(chan string, 2)
	var returned atomic.Int32
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		started <- "x"
		<-ctx.Done()
		time.Sleep(20 * time.Millisecond)
		returned.Add(1)
		return ctx.Err()
	})
	m.d.SplitInputs = true
	e := setup(t, 2, m)
	e.start(t)
	jobs := e.submit(t, "a", "1", "2", "3")
	recv(t, started)
	recv(t, started)
	must(t, e.m.Shutdown(5*time.Second))
	if returned.Load() != 2 {
		t.Fatalf("returned = %d", returned.Load())
	}
	must(t, e.m.Shutdown(time.Second)) // idempotent
	for _, id := range []string{jobs[0].ID, jobs[1].ID} {
		j, _ := e.db.GetJob(context.Background(), id)
		if j.Status != JobFailed || j.ErrorCode != CodeInterrupted {
			t.Fatalf("job after shutdown = %+v", j)
		}
	}
	if j, _ := e.db.GetJob(context.Background(), jobs[2].ID); j.Status != JobQueued {
		t.Fatalf("queued job should stay queued, got %s", j.Status)
	}
}

func TestShutdownTimeout(t *testing.T) {
	started := make(chan string, 1)
	release := make(chan struct{})
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		started <- "x"
		<-release
		return nil
	})
	e := setup(t, 1, m)
	e.start(t)
	e.submit(t, "a", "x")
	recv(t, started)
	if err := e.m.Shutdown(30 * time.Millisecond); err == nil {
		t.Fatal("expected timeout error")
	}
	close(release)
	must(t, e.m.Shutdown(5*time.Second))
}

func TestResultPersistedAndClearedOnRetry(t *testing.T) {
	var attempts atomic.Int32
	m := mod("a", func(ctx context.Context, jc *JobContext) error {
		must(t, jc.SetResult(map[string]int{"n": int(attempts.Add(1))}))
		if attempts.Load() == 1 {
			return ValidationError("first fails", nil)
		}
		return nil
	})
	e := setup(t, 1, m)
	e.start(t)
	j := e.submit(t, "a", "x")[0]
	failed := e.em.waitStatus(t, j.ID, JobFailed)
	if failed.ResultJSON != `{"n":1}` {
		t.Fatalf("failed result = %q", failed.ResultJSON)
	}
	r, err := e.m.Retry(context.Background(), j.ID)
	must(t, err)
	if r.ResultJSON != "" {
		t.Fatalf("retry kept result %q", r.ResultJSON)
	}
	done := e.em.waitStatus(t, j.ID, JobDone)
	if done.ResultJSON != `{"n":2}` {
		t.Fatalf("done result = %q", done.ResultJSON)
	}
	got, err := e.m.Get(context.Background(), j.ID)
	must(t, err)
	if got.ResultJSON != `{"n":2}` {
		t.Fatalf("persisted result = %q", got.ResultJSON)
	}
}

func TestMaxInputs(t *testing.T) {
	m := mod("a", func(ctx context.Context, jc *JobContext) error { return nil })
	m.d.MaxInputs = 2
	e := setup(t, 1, m)
	e.start(t)
	_, err := e.m.Submit(context.Background(), "a", []string{"1", "2", "3"}, "{}")
	if ae := AsAppError(err); ae.Code != CodeValidation || ae.Fields["inputs"] == "" {
		t.Fatalf("err = %v", err)
	}
	if _, err := e.m.Submit(context.Background(), "a", []string{"1", "2", "2"}, "{}"); err != nil {
		t.Fatalf("dedupe should bring it under the cap: %v", err)
	}
}

func TestSubmitRejectsJobLessModules(t *testing.T) {
	m := mod("clip", nil)
	m.d.JobLess = true
	e := setup(t, 1, m)
	if _, err := e.m.Submit(context.Background(), "clip", nil, ""); !IsCode(err, CodeValidation) || !strings.Contains(err.Error(), "doesn't run jobs") {
		t.Fatalf("job-less submit: %v", err)
	}
	if jobs, _ := e.m.List(context.Background(), JobFilter{}); len(jobs) != 0 {
		t.Fatalf("jobs created: %v", jobs)
	}
}
