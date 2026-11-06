package pipeline

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core"
)

// fakeClock is an injectable wall clock.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock(t time.Time) *fakeClock { return &fakeClock{t: t} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

func (c *fakeClock) Add(d time.Duration) { c.Set(c.Now().Add(d)) }

// timerStep is a no-files Chainable whose PrepareStep is a function the test
// sets; it records every request.
type timerStep struct {
	mu   sync.Mutex
	reqs []core.StepRequest
	fn   func(req core.StepRequest) ([]core.StepJob, error)
}

func (t *timerStep) Descriptor() core.Descriptor {
	return core.Descriptor{ID: "timer", Name: "Timer", Icon: "box", Category: core.CategoryUtility, Status: core.StatusReady,
		Accepts: core.Accepts{Any: true}, OutputSubdir: "timer"}
}
func (t *timerStep) Validate([]string, json.RawMessage) error          { return nil }
func (t *timerStep) Run(ctx context.Context, _ *core.JobContext) error { return nil }
func (t *timerStep) StepDefaults() any                                 { return struct{}{} }
func (t *timerStep) DescribeStep(json.RawMessage) (core.StepInfo, error) {
	return core.StepInfo{Accepts: core.Accepts{Any: true, Extensions: []string{}}, NoFiles: true,
		Templates: []string{"/args"}, Produces: []core.StepProduct{{Many: true}}}, nil
}
func (t *timerStep) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	t.mu.Lock()
	t.reqs = append(t.reqs, req)
	fn := t.fn
	t.mu.Unlock()
	if fn == nil {
		return nil, nil
	}
	return fn(req)
}
func (t *timerStep) StepOutputs(core.Job) (core.StepResult, error) { return core.StepResult{}, nil }

func (t *timerStep) calls() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.reqs)
}

func (t *timerStep) request(i int) core.StepRequest {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.reqs[i]
}

// waitUntil returns a PrepareStep function that waits for a deadline fixed at
// the first call (req.Until afterwards), judged by now().
func waitUntil(first func() time.Time, now func() time.Time) func(core.StepRequest) ([]core.StepJob, error) {
	return func(req core.StepRequest) ([]core.StepJob, error) {
		if req.SkipWait {
			return nil, nil
		}
		until := time.UnixMilli(req.Until)
		if req.Until == 0 {
			until = first()
		}
		if !now().Before(until) {
			return nil, nil
		}
		return nil, core.ErrWaitingUntil("Waiting", "", until)
	}
}

// startAt starts a Runner on a fake clock.
func (e *env) startAt(clk *fakeClock, tweak func(*Runner)) *Runner {
	e.t.Helper()
	r := e.newRunner()
	r.cfg.Clock = clk.Now
	r.cfg.Location = time.UTC
	r.wallEvery = 20 * time.Millisecond
	if tweak != nil {
		tweak(r)
	}
	must(e.t, r.Start(context.Background()))
	e.t.Cleanup(r.Stop)
	e.r = r
	return r
}

func timerPipeline(name string) core.Pipeline {
	return core.Pipeline{Name: name, Steps: []core.PipelineStep{{ID: "aaaaaaaa", Type: "timer", From: FromNone, OptionsJSON: "{}", Keep: true}}}
}

func startNoFiles(t *testing.T, e *env, p core.Pipeline) core.PipelineRun {
	t.Helper()
	run, err := e.r.StartRun(core.RunRequest{PipelineID: p.ID}, "manual")
	must(t, err)
	return run
}

func TestTimeWaitRetriedAtUntil(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	e.start()
	until := time.Now().Add(500 * time.Millisecond)
	ts.fn = waitUntil(func() time.Time { return until }, time.Now)
	p := e.save(timerPipeline("tw"))
	run := startNoFiles(t, e, p)

	waiting := e.waitRun(run.ID, "time wait", func(r core.PipelineRun) bool {
		c := cellOf(r, 0, 0)
		return c.Status == core.CellWaiting && c.Wait == core.WaitTime
	})
	eq(t, "until", cellOf(waiting, 0, 0).Until, until.UnixMilli())
	eq(t, "needs you", waiting.NeedsYou, 0)
	eq(t, "run status", waiting.Status, core.RunRunning)
	// ErrWaiting would retry every 30 ms here; a time wait sleeps until Until.
	time.Sleep(300 * time.Millisecond)
	eq(t, "calls before the deadline", ts.calls(), 1)
	e.waitStatus(run.ID, core.RunDone)
	eq(t, "calls", ts.calls(), 2)
	eq(t, "stored Until is cleared", cellOf(mustRun(t, e, run.ID), 0, 0).Until, int64(0))
}

func mustRun(t *testing.T, e *env, id string) core.PipelineRun {
	t.Helper()
	r, err := e.r.Run(id)
	must(t, err)
	return r
}

func TestPlainWaitingStillRetriesFast(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	e.start()
	var n atomic.Int32
	ts.fn = func(core.StepRequest) ([]core.StepJob, error) {
		if n.Add(1) < 4 {
			return nil, core.ErrWaiting("not yet", "")
		}
		return nil, nil
	}
	p := e.save(timerPipeline("plain"))
	run := startNoFiles(t, e, p)
	e.waitStatus(run.ID, core.RunDone)
	eq(t, "calls", ts.calls(), 4)
}

func TestWallClockCheckFiresAMissedTimer(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	clk := newFakeClock(time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC))
	e.startAt(clk, nil)
	ts.fn = waitUntil(func() time.Time { return clk.Now().Add(time.Hour) }, clk.Now)
	p := e.save(timerPipeline("wall"))
	run := startNoFiles(t, e, p)
	e.waitRun(run.ID, "time wait", func(r core.PipelineRun) bool { return cellOf(r, 0, 0).Wait == core.WaitTime })
	time.Sleep(100 * time.Millisecond)
	eq(t, "still waiting", ts.calls(), 1)
	// The machine "slept": the monotonic timer (1 h away) never fired, but
	// the wall clock moved past the deadline.
	clk.Add(2 * time.Hour)
	e.waitStatus(run.ID, core.RunDone)
}

func TestResumedChecksTimeWaits(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	clk := newFakeClock(time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC))
	e.startAt(clk, func(r *Runner) { r.wallEvery = time.Hour })
	ts.fn = waitUntil(func() time.Time { return clk.Now().Add(time.Hour) }, clk.Now)
	p := e.save(timerPipeline("resume"))
	run := startNoFiles(t, e, p)
	e.waitRun(run.ID, "time wait", func(r core.PipelineRun) bool { return cellOf(r, 0, 0).Wait == core.WaitTime })
	clk.Add(2 * time.Hour)
	e.r.Resumed()
	e.waitStatus(run.ID, core.RunDone)
}

func TestPersistedUntilSurvivesARestart(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	clk := newFakeClock(time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC))
	first := e.startAt(clk, nil)
	ts.fn = waitUntil(func() time.Time { return clk.Now().Add(25 * time.Minute) }, clk.Now)
	p := e.save(timerPipeline("restart"))
	run := startNoFiles(t, e, p)
	waiting := e.waitRun(run.ID, "time wait", func(r core.PipelineRun) bool { return cellOf(r, 0, 0).Wait == core.WaitTime })
	deadline := clk.Now().Add(25 * time.Minute).UnixMilli()
	eq(t, "until", cellOf(waiting, 0, 0).Until, deadline)
	until(t, "persisted", func() bool {
		s, err := e.db.GetRun(context.Background(), run.ID)
		return err == nil && strings.Contains(s, `"until":`+itoa(int(deadline)))
	})
	first.Stop()

	// Ten minutes later a new Runner takes over: the deadline is the same.
	clk.Add(10 * time.Minute)
	e.startAt(clk, nil)
	time.Sleep(100 * time.Millisecond)
	eq(t, "not prepared again before the deadline", ts.calls(), 1)
	clk.Add(20 * time.Minute) // 5 minutes past the original deadline
	e.waitStatus(run.ID, core.RunDone)
	eq(t, "req.Until after restart", ts.request(ts.calls()-1).Until, deadline)
}

func TestContinueNowSetsSkipWait(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	e.start()
	ts.fn = waitUntil(func() time.Time { return time.Now().Add(time.Hour) }, time.Now)
	p := e.save(timerPipeline("skip"))
	run := startNoFiles(t, e, p)
	e.waitRun(run.ID, "time wait", func(r core.PipelineRun) bool { return cellOf(r, 0, 0).Wait == core.WaitTime })
	must(t, e.r.Continue(core.ContinueRequest{RunID: run.ID, Item: 0, StepID: "aaaaaaaa"}))
	e.waitStatus(run.ID, core.RunDone)
	last := ts.request(ts.calls() - 1)
	if !last.SkipWait {
		t.Fatalf("the last request lacks SkipWait: %+v", last)
	}
	if ts.request(0).SkipWait {
		t.Fatal("the first request must not skip")
	}
}

func TestTimeWaitsDontCountInNeedsYou(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	r := e.newRunner()
	var mu sync.Mutex
	maxTotal := 0
	r.OnNeedsYou(func(total int, _ string) {
		mu.Lock()
		if total > maxTotal {
			maxTotal = total
		}
		mu.Unlock()
	})
	must(t, r.Start(context.Background()))
	t.Cleanup(r.Stop)
	e.r = r
	ts.fn = waitUntil(func() time.Time { return time.Now().Add(150 * time.Millisecond) }, time.Now)
	p := e.save(timerPipeline("needs"))
	run := startNoFiles(t, e, p)
	e.waitRun(run.ID, "time wait", func(r core.PipelineRun) bool { return cellOf(r, 0, 0).Wait == core.WaitTime })
	e.waitStatus(run.ID, core.RunDone)
	mu.Lock()
	defer mu.Unlock()
	eq(t, "NeedsYou total", maxTotal, 0)
}

func TestWakeTimeWaitsPreparesAgainNow(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	e.start()
	var released atomic.Bool
	ts.fn = func(req core.StepRequest) ([]core.StepJob, error) {
		if released.Load() {
			return nil, nil
		}
		return nil, core.ErrWaitingUntil("Waiting", "", time.Now().Add(time.Hour))
	}
	p := e.save(timerPipeline("wake"))
	run := startNoFiles(t, e, p)
	e.waitRun(run.ID, "time wait", func(r core.PipelineRun) bool { return cellOf(r, 0, 0).Wait == core.WaitTime })
	released.Store(true)
	e.r.WakeTimeWaits()
	e.waitStatus(run.ID, core.RunDone)
}

func TestOnRunFinishedOncePerRun(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	r := e.newRunner()
	var mu sync.Mutex
	seen := map[string][]core.RunStatus{}
	r.OnRunFinished(func(run core.PipelineRun) {
		mu.Lock()
		seen[run.ID] = append(seen[run.ID], run.Status)
		mu.Unlock()
	})
	must(t, r.Start(context.Background()))
	t.Cleanup(r.Stop)
	e.r = r

	p := e.save(timerPipeline("fin"))
	done := startNoFiles(t, e, p)
	e.waitStatus(done.ID, core.RunDone)

	ts.fn = waitUntil(func() time.Time { return time.Now().Add(time.Hour) }, time.Now)
	cancelled := startNoFiles(t, e, p)
	e.waitRun(cancelled.ID, "time wait", func(r core.PipelineRun) bool { return cellOf(r, 0, 0).Wait == core.WaitTime })
	must(t, r.Cancel(cancelled.ID))
	e.waitStatus(cancelled.ID, core.RunCancelled)

	until(t, "hooks", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(seen[done.ID]) >= 1 && len(seen[cancelled.ID]) >= 1
	})
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	eq(t, "done run calls", len(seen[done.ID]), 1)
	eq(t, "cancelled run calls", len(seen[cancelled.ID]), 1)
	eq(t, "done status", seen[done.ID][0], core.RunDone)
	eq(t, "cancelled status", seen[cancelled.ID][0], core.RunCancelled)
}

// --- runs without files ---

func TestRunWithoutFilesHasOneItem(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	e.start()
	p := e.save(timerPipeline("Morning v1.2"))
	ent, err := e.r.Save(p)
	must(t, err)
	eq(t, "takes files", ent.Check.TakesFiles, false)
	run := startNoFiles(t, e, p)
	eq(t, "items", len(run.Items), 1)
	it := run.Items[0]
	eq(t, "label", it.Label, "Morning v1.2")
	eq(t, "input", it.Input, "")
	eq(t, "merged at", it.MergedAt, "")
	eq(t, "merged", len(it.Merged), 0)
	eq(t, "{item}", it.Vars["item"], "Morning v1.2")
	eq(t, "{name}", it.Vars["name"], "Morning v1.2")
	eq(t, "inputs", len(run.Inputs), 0)
	e.waitStatus(run.ID, core.RunDone)
}

func TestRunWithoutFilesRefusesInputs(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	e.start()
	p := e.save(timerPipeline("nofiles"))
	_, err := e.r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: e.files("a.txt")}, "manual")
	if err == nil || !strings.Contains(core.AsAppError(err).Message, "doesn't take files") {
		t.Fatalf("err = %v", err)
	}
}

func TestPipelineWithFilesStillNeedsThem(t *testing.T) {
	e := newEnv(t, 2, &fakeStep{id: "a", split: true})
	e.start()
	p := e.save(pl("files", step("aaaaaaaa", "a", FromInput, fakeOpts{})))
	_, err := e.r.StartRun(core.RunRequest{PipelineID: p.ID}, "manual")
	if err == nil || !strings.Contains(core.AsAppError(err).Message, "Add at least one file") {
		t.Fatalf("err = %v", err)
	}
	ent, err := e.r.Save(p)
	must(t, err)
	eq(t, "takes files", ent.Check.TakesFiles, true)
}

func TestTogetherStepInAnInputlessRun(t *testing.T) {
	e := newEnv(t, 2, tableStep{})
	e.start()
	cols, _ := json.Marshal(tableOpts{Cols: []string{"{item}", "{weekday}"}})
	p := e.save(core.Pipeline{Name: "Daily table", Steps: []core.PipelineStep{
		{ID: "aaaaaaaa", Type: "table", From: FromNone, OptionsJSON: string(cols), Keep: true}}})
	run := startNoFiles(t, e, p)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "items (one + merged)", len(done.Items), 2)
	eq(t, "item 0 cell", cellOf(done, 0, 0).Status, core.CellMerged)
	m := done.Items[1]
	eq(t, "merged at", m.MergedAt, "aaaaaaaa")
	eq(t, "merged", len(m.Merged), 1)
	eq(t, "merged cell", m.Cells[0].Status, core.CellDone)
	if len(m.Cells[0].Files) != 1 {
		t.Fatalf("files = %+v", m.Cells[0].Files)
	}
	f, err := os.Open(m.Cells[0].Files[0].Path)
	must(t, err)
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	must(t, err)
	eq(t, "rows", len(rows), 1)
	eq(t, "row[0]", rows[0][0], "Daily table")
	if len(rows[0][1]) != 3 {
		t.Fatalf("weekday = %q", rows[0][1])
	}
}

func TestNoFilesPipelineCantWatchOrCopyTrigger(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	e.start()
	p := timerPipeline("triggers")
	p.Watch = core.WatchConfig{Enabled: true, Folder: e.in}
	p.Clip = core.ClipTrigger{Enabled: true, Kinds: []string{core.ClipTriggerLink}}
	chk := e.r.Describe(p)
	has := func(sub string) bool {
		for _, pr := range chk.Problems {
			if strings.Contains(pr, sub) {
				return true
			}
		}
		return false
	}
	if !has("takes no files, so it can't watch a folder") || !has("takes no files, so it can't start from a copy") {
		t.Fatalf("problems = %v", chk.Problems)
	}
	if chk.Ready {
		t.Fatal("must not be ready")
	}
}

func TestWeekdayBuiltin(t *testing.T) {
	// 2026-11-05 is a Thursday.
	vars := builtinVars("x.txt", false, 1, "p", time.Date(2026, 11, 5, 12, 0, 0, 0, time.Local))
	eq(t, "weekday", vars["weekday"], "Thu")
	found := false
	for _, v := range builtinVarList {
		if v.Name == "weekday" && v.Type == core.ValueText {
			found = true
		}
	}
	if !found {
		t.Fatal("weekday missing from builtinVarList")
	}
}
