package pipeline

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

func (e *env) waitCell(runID string, item, step int, st core.CellStatus) core.PipelineRun {
	e.t.Helper()
	return e.waitRun(runID, "cell status "+string(st), func(r core.PipelineRun) bool {
		return item < len(r.Items) && r.Items[item].Cells[step].Status == st
	})
}

func manualPipeline(e *env, auto bool) core.Pipeline {
	s2 := step("bbbbbbb2", "a", "aaaaaaa1", fakeOpts{})
	s2.Manual, s2.AutoContinue = true, auto
	s2.OptionsJSON = "{}"
	return e.save(pl("Manual", step("aaaaaaa1", "a", FromInput, fakeOpts{}), s2, step("ccccccc3", "b", "bbbbbbb2", fakeOpts{})))
}

func (e *env) submitDirect(module string, o fakeOpts, inputs ...string) []core.Job {
	e.t.Helper()
	jobs, err := e.jobs.Submit(context.Background(), module, inputs, opts(o))
	must(e.t, err)
	return jobs
}

func TestManualAdoptionAndAutoContinue(t *testing.T) {
	a := &fakeStep{id: "a", split: true}
	e := newEnv(t, 4, a, &fakeStep{id: "b", split: true}, &fakeStep{id: "other", split: true})
	var mu sync.Mutex
	var needs []int
	r := e.newRunner()
	r.OnNeedsYou(func(total int, first string) {
		mu.Lock()
		needs = append(needs, total)
		mu.Unlock()
	})
	must(t, r.Start(context.Background()))
	t.Cleanup(r.Stop)
	e.r = r
	p := manualPipeline(e, true)
	run := e.startRun(p, e.files("song.txt")...)
	waiting := e.waitCell(run.ID, 0, 1, core.CellWaiting)
	eq(t, "wait kind", cellOf(waiting, 0, 1).Wait, core.WaitManual)
	eq(t, "run waiting", waiting.Status, core.RunWaiting)
	eq(t, "needs you", waiting.NeedsYou, 1)
	until(t, "tray told", func() bool { mu.Lock(); defer mu.Unlock(); return len(needs) > 0 && needs[len(needs)-1] == 1 })
	in := cellOf(waiting, 0, 1).Inputs
	eq(t, "inputs", len(in), 1)

	// A job of another module on the same file, and the right module on another file, are not adopted.
	other := e.files("unrelated.txt")[0]
	e.submitDirect("other", fakeOpts{}, in[0].Path)
	e.submitDirect("a", fakeOpts{}, other)
	time.Sleep(150 * time.Millisecond)
	cur, _ := e.r.Run(run.ID)
	eq(t, "still waiting", cellOf(cur, 0, 1).Status, core.CellWaiting)
	eq(t, "nothing adopted", len(cellOf(cur, 0, 1).JobIDs), 0)

	// A failing adopted job does not fail the cell.
	bad := e.submitDirect("a", fakeOpts{Fail: "nope"}, in[0].Path)[0]
	until(t, "adopted", func() bool { c, _ := e.r.Run(run.ID); return len(cellOf(c, 0, 1).JobIDs) == 1 })
	j, _ := e.jobs.Get(context.Background(), bad.ID)
	eq(t, "tagged", j.PipelineRunID, run.ID)
	eq(t, "tag step", j.PipelineStepID, "bbbbbbb2")
	until(t, "job failed", func() bool { j, _ := e.jobs.Get(context.Background(), bad.ID); return j.Status == core.JobFailed })
	time.Sleep(100 * time.Millisecond)
	cur, _ = e.r.Run(run.ID)
	eq(t, "failed adopted job leaves the cell waiting", cellOf(cur, 0, 1).Status, core.CellWaiting)

	// A job that finishes done with files continues the run by itself.
	good := e.submitDirect("a", fakeOpts{Template: "x"}, in[0].Path)[0]
	done := e.waitStatus(run.ID, core.RunDone)
	c := cellOf(done, 0, 1)
	eq(t, "manual cell done", c.Status, core.CellDone)
	eq(t, "adopted jobs", len(c.JobIDs), 2)
	eq(t, "one file", len(c.Files), 1)
	eq(t, "step 3 reads it", cellOf(done, 0, 2).Inputs[0].Path, c.Files[0].Path)
	_ = good
	until(t, "tray cleared", func() bool { mu.Lock(); defer mu.Unlock(); return needs[len(needs)-1] == 0 })
}

func TestAutoContinueNeedsFiles(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	p := manualPipeline(e, true)
	run := e.startRun(p, e.files("song.txt")...)
	w := e.waitCell(run.ID, 0, 1, core.CellWaiting)
	in := cellOf(w, 0, 1).Inputs[0].Path
	empty := e.submitDirect("a", fakeOpts{NoOutput: true}, in)[0]
	e.waitJob(empty.ID, core.JobDone)
	time.Sleep(100 * time.Millisecond)
	cur, _ := e.r.Run(run.ID)
	eq(t, "done without files keeps waiting", cellOf(cur, 0, 1).Status, core.CellWaiting)
	e.submitDirect("a", fakeOpts{}, in)
	e.waitStatus(run.ID, core.RunDone)
}

func (e *env) waitJob(id string, st core.JobStatus) {
	e.t.Helper()
	until(e.t, "job "+string(st), func() bool {
		j, err := e.jobs.Get(context.Background(), id)
		return err == nil && j.Status == st
	})
}

func TestManualContinueWithKeepSubset(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	p := manualPipeline(e, false)
	run := e.startRun(p, e.files("song.txt")...)
	w := e.waitCell(run.ID, 0, 1, core.CellWaiting)
	in := cellOf(w, 0, 1).Inputs[0].Path
	j1 := e.submitDirect("a", fakeOpts{Make: 2}, in)[0]
	e.waitJob(j1.ID, core.JobDone)
	until(t, "adopted", func() bool { c, _ := e.r.Run(run.ID); return len(cellOf(c, 0, 1).JobIDs) == 1 })
	time.Sleep(100 * time.Millisecond)
	cur, _ := e.r.Run(run.ID)
	eq(t, "no auto continue", cellOf(cur, 0, 1).Status, core.CellWaiting)
	job, _ := e.jobs.Get(context.Background(), j1.ID)
	eq(t, "two outputs", len(job.Outputs), 2)
	// Nothing to continue with before keeping a valid subset? Keep one.
	must(t, e.r.Continue(core.ContinueRequest{RunID: run.ID, Item: 0, StepID: "bbbbbbb2", Keep: []string{job.Outputs[1].Path}}))
	done := e.waitStatus(run.ID, core.RunDone)
	files := cellOf(done, 0, 1).Files
	eq(t, "kept one", len(files), 1)
	eq(t, "the chosen one", files[0].Path, job.Outputs[1].Path)
}

func TestManualContinueWithoutOutputsAndPassThrough(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	p := manualPipeline(e, false)
	run := e.startRun(p, e.files("one.txt", "two.txt", "three.txt")...)
	w := e.waitRun(run.ID, "all waiting", func(r core.PipelineRun) bool {
		return r.NeedsYou == 3
	})
	err := e.r.Continue(core.ContinueRequest{RunID: run.ID, Item: 0, StepID: "bbbbbbb2"})
	if !core.IsCode(err, core.CodeConflict) {
		t.Fatalf("continue with nothing: %v", err)
	}
	// Pass-through carries the inputs on.
	must(t, e.r.Continue(core.ContinueRequest{RunID: run.ID, Item: 0, StepID: "bbbbbbb2", PassThrough: true}))
	// Skip does the same for another item.
	must(t, e.r.SkipStep(run.ID, 1, "bbbbbbb2"))
	// StopItem cancels the third.
	must(t, e.r.StopItem(run.ID, 2))
	final := e.waitStatus(run.ID, core.RunPartial)
	eq(t, "item 0 files", cellOf(final, 0, 1).Files[0].Path, cellOf(w, 0, 1).Inputs[0].Path)
	eq(t, "item 1 files", cellOf(final, 1, 1).Files[0].Path, cellOf(w, 1, 1).Inputs[0].Path)
	eq(t, "skip message", cellOf(final, 1, 1).Message, "Skipped")
	eq(t, "item 2 cancelled", cellOf(final, 2, 1).Status, core.CellCancelled)
	eq(t, "item 2 blocked", cellOf(final, 2, 2).Status, core.CellBlocked)
	eq(t, "item 0 ran step 3", cellOf(final, 0, 2).Status, core.CellDone)
	eq(t, "needs you cleared", final.NeedsYou, 0)
}

func TestManualNonChainableModule(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeManual{id: "man"})
	e.start()
	s2 := step("bbbbbbb2", "man", "aaaaaaa1", fakeOpts{})
	s2.Manual, s2.AutoContinue, s2.OptionsJSON = true, true, "{}"
	p := e.save(pl("ManualGeneric", step("aaaaaaa1", "a", FromInput, fakeOpts{}), s2))
	run := e.startRun(p, e.files("song.txt")...)
	w := e.waitCell(run.ID, 0, 1, core.CellWaiting)
	in := cellOf(w, 0, 1).Inputs[0].Path
	_, err := e.jobs.Submit(context.Background(), "man", []string{in}, "{}")
	must(t, err)
	done := e.waitStatus(run.ID, core.RunDone)
	f := cellOf(done, 0, 1).Files[0]
	eq(t, "kind from extension", f.Kind, core.KindDocument)
	if f.OutputID == "" || f.Temporary != !s2.Keep {
		t.Fatalf("file = %+v", f)
	}
}

func TestManualStepMustBeAllowed(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	r := e.start()
	p := pl("Bad manual", step("aaaaaaa1", "a", FromInput, fakeOpts{}))
	p.Steps[0].Manual = true
	check := r.Describe(p)
	if !check.Ready {
		t.Fatalf("manual on a module should be fine: %v", check.Steps[0].Problems)
	}
}

func TestCheckKeepSubsetAndNone(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	chk := core.PipelineStep{ID: "kkkkkkk2", Type: CheckType, From: "aaaaaaa1", OptionsJSON: "{}", Note: "Look"}
	p := e.save(pl("Check", step("aaaaaaa1", "a", FromInput, fakeOpts{Make: 3}), chk, step("ccccccc3", "b", "kkkkkkk2", fakeOpts{})))
	run := e.startRun(p, e.files("x.txt", "y.txt")...)
	w := e.waitRun(run.ID, "both checks waiting", func(r core.PipelineRun) bool { return r.NeedsYou == 2 })
	eq(t, "wait", cellOf(w, 0, 1).Wait, core.WaitCheck)
	eq(t, "inputs", len(cellOf(w, 0, 1).Inputs), 3)
	keep := []string{cellOf(w, 0, 1).Inputs[2].Path, cellOf(w, 0, 1).Inputs[0].Path}
	must(t, e.r.Continue(core.ContinueRequest{RunID: run.ID, Item: 0, StepID: "kkkkkkk2", Keep: keep}))
	must(t, e.r.Continue(core.ContinueRequest{RunID: run.ID, Item: 1, StepID: "kkkkkkk2", Keep: []string{}}))
	done := e.waitStatus(run.ID, core.RunDone)
	files := cellOf(done, 0, 1).Files
	eq(t, "kept in input order", files[0].Path, cellOf(w, 0, 1).Inputs[0].Path)
	eq(t, "kept two", len(files), 2)
	eq(t, "step 3 got the kept", len(cellOf(done, 0, 2).Inputs), 2)
	eq(t, "kept none: done", cellOf(done, 1, 1).Status, core.CellDone)
	eq(t, "kept none: no files", len(cellOf(done, 1, 1).Files), 0)
	eq(t, "kept none: later skipped", cellOf(done, 1, 2).Status, core.CellSkipped)
	eq(t, "message", cellOf(done, 1, 2).Message, "You kept nothing")
}

func TestCheckSkipKeepsEverything(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	e.start()
	chk := core.PipelineStep{ID: "kkkkkkk2", Type: CheckType, From: "aaaaaaa1", OptionsJSON: "{}"}
	p := e.save(pl("CheckSkip", step("aaaaaaa1", "a", FromInput, fakeOpts{Make: 2}), chk))
	run := e.startRun(p, e.files("x.txt")...)
	e.waitCell(run.ID, 0, 1, core.CellWaiting)
	must(t, e.r.SkipStep(run.ID, 0, "kkkkkkk2"))
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "files", len(cellOf(done, 0, 1).Files), 2)
	if err := e.r.Continue(core.ContinueRequest{RunID: run.ID, Item: 0, StepID: "kkkkkkk2"}); !core.IsCode(err, core.CodeConflict) {
		t.Fatalf("continuing a done cell: %v", err)
	}
}

func TestConditionWait(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	var mu sync.Mutex
	maxNeeds := 0
	r := e.newRunner()
	r.OnNeedsYou(func(total int, _ string) {
		mu.Lock()
		maxNeeds = max(maxNeeds, total)
		mu.Unlock()
	})
	must(t, r.Start(context.Background()))
	t.Cleanup(r.Stop)
	e.r = r
	flag := filepath.Join(t.TempDir(), "locked")
	must(t, os.WriteFile(flag, nil, 0o644))
	p := e.save(pl("Cond", step("aaaaaaa1", "a", FromInput, fakeOpts{}),
		step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Wait: "Unlock the Vault to continue", WaitFlag: flag})))
	run := e.startRun(p, e.files("x.txt")...)
	w := e.waitCell(run.ID, 0, 1, core.CellWaiting)
	eq(t, "kind", cellOf(w, 0, 1).Wait, core.WaitCondition)
	eq(t, "message", cellOf(w, 0, 1).Message, "Unlock the Vault to continue")
	eq(t, "run keeps running", w.Status, core.RunRunning)
	eq(t, "not counted", w.NeedsYou, 0)
	time.Sleep(200 * time.Millisecond) // several retries
	cur, _ := e.r.Run(run.ID)
	eq(t, "still waiting", cellOf(cur, 0, 1).Status, core.CellWaiting)
	must(t, os.Remove(flag))
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "message cleared", cellOf(done, 0, 1).Message, "")
	mu.Lock()
	defer mu.Unlock()
	eq(t, "tray never asked", maxNeeds, 0)
}

func TestConditionWaitRetryNow(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	r := e.newRunner()
	r.waitRetry = time.Hour
	must(t, r.Start(context.Background()))
	t.Cleanup(r.Stop)
	e.r = r
	flag := filepath.Join(t.TempDir(), "locked")
	must(t, os.WriteFile(flag, nil, 0o644))
	p := e.save(pl("CondNow", step("aaaaaaa1", "a", FromInput, fakeOpts{Wait: "Locked", WaitFlag: flag})))
	run := e.startRun(p, e.files("x.txt")...)
	e.waitCell(run.ID, 0, 0, core.CellWaiting)
	must(t, os.Remove(flag))
	_, err := e.r.Retry(run.ID)
	must(t, err)
	e.waitStatus(run.ID, core.RunDone)
}

func TestCancelRun(t *testing.T) {
	newGate("never")
	a := &fakeStep{id: "a", split: true}
	e := newEnv(t, 2, a, &fakeStep{id: "b", split: true})
	e.start()
	p := e.save(pl("Cancel", step("aaaaaaa1", "a", FromInput, fakeOpts{Hold: "never"}), step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})))
	run := e.startRun(p, e.files("1.txt", "2.txt", "3.txt", "4.txt")...)
	until(t, "2 running", func() bool { return a.cur.Load() == 2 })
	must(t, e.r.Cancel(run.ID))
	c := e.waitRun(run.ID, "all jobs cancelled", func(r core.PipelineRun) bool {
		for _, it := range r.Items {
			if it.Cells[0].Status != core.CellCancelled && it.Cells[0].Status != core.CellBlocked {
				return false
			}
		}
		return true
	})
	eq(t, "status", c.Status, core.RunCancelled)
	for _, it := range c.Items {
		eq(t, "later cell blocked", it.Cells[1].Status, core.CellBlocked)
	}
	until(t, "jobs stopped", func() bool { return a.cur.Load() == 0 })
	// Nothing new starts.
	time.Sleep(100 * time.Millisecond)
	eq(t, "started", int(a.started.Load()), 2)
	// Retry resumes it.
	release("never")
	_, err := e.r.Retry(run.ID)
	must(t, err)
	e.waitStatus(run.ID, core.RunDone)
}

func TestRetryRun(t *testing.T) {
	flag := filepath.Join(t.TempDir(), "fail")
	prep := filepath.Join(t.TempDir(), "prep")
	must(t, os.WriteFile(flag, nil, 0o644))
	must(t, os.WriteFile(prep, nil, 0o644))
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true}, &fakeStep{id: "c", split: true})
	e.start()
	p := e.save(pl("Retry",
		step("aaaaaaa1", "a", FromInput, fakeOpts{FailFlag: flag, Fail: "disk full"}),
		step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})))
	run := e.startRun(p, e.files("x.txt")...)
	failed := e.waitStatus(run.ID, core.RunFailed)
	c0, c1 := cellOf(failed, 0, 0), cellOf(failed, 0, 1)
	eq(t, "job failed", c0.Status, core.CellFailed)
	eq(t, "error", c0.Error, "disk full")
	eq(t, "blocked", c1.Status, core.CellBlocked)
	jobID := c0.JobIDs[0]

	must(t, os.Remove(flag))
	retried, err := e.r.Retry(run.ID)
	must(t, err)
	eq(t, "running again", retried.Status, core.RunRunning)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "same job retried", cellOf(done, 0, 0).JobIDs[0], jobID)
	j, _ := e.jobs.Get(context.Background(), jobID)
	eq(t, "attempt", j.Attempt, 2)
	eq(t, "blocked step ran", cellOf(done, 0, 1).Status, core.CellDone)

	// A prepare error has no job: Retry prepares it again.
	p2 := e.save(pl("RetryPrep",
		step("aaaaaaa1", "a", FromInput, fakeOpts{PrepFail: "cannot prepare", PrepFailFlag: prep}),
		step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})))
	run2 := e.startRun(p2, e.files("y.txt")...)
	failed2 := e.waitStatus(run2.ID, core.RunFailed)
	eq(t, "prepare failed", cellOf(failed2, 0, 0).Status, core.CellFailed)
	eq(t, "message", cellOf(failed2, 0, 0).Error, "cannot prepare")
	eq(t, "no job", len(cellOf(failed2, 0, 0).JobIDs), 0)
	must(t, os.Remove(prep))
	_, err = e.r.Retry(run2.ID)
	must(t, err)
	done2 := e.waitStatus(run2.ID, core.RunDone)
	eq(t, "re-prepared", cellOf(done2, 0, 0).Status, core.CellDone)
	eq(t, "unblocked", cellOf(done2, 0, 1).Status, core.CellDone)
}

func TestRetryFromJobTrayResumesItem(t *testing.T) {
	flag := filepath.Join(t.TempDir(), "fail")
	must(t, os.WriteFile(flag, nil, 0o644))
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	p := e.save(pl("Tray",
		step("aaaaaaa1", "a", FromInput, fakeOpts{FailFlag: flag}),
		step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})))
	run := e.startRun(p, e.files("x.txt")...)
	failed := e.waitStatus(run.ID, core.RunFailed)
	jobID := cellOf(failed, 0, 0).JobIDs[0]
	must(t, os.Remove(flag))
	_, err := e.jobs.Retry(context.Background(), jobID)
	must(t, err)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "resumed", cellOf(done, 0, 1).Status, core.CellDone)
}

func TestLinkInputsAndTitleLabel(t *testing.T) {
	e := newEnv(t, 4, &linkStep{fakeStep: fakeStep{id: "downloader", split: true}}, &fakeStep{id: "b", split: true})
	e.start()
	p := e.save(pl("Links", step("aaaaaaa1", "downloader", FromInput, fakeOpts{}), step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})))
	url := "https://example.test/v/abc"
	run := e.startRun(p, url)
	eq(t, "initial label", run.Items[0].Label, url)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "title becomes the label", done.Items[0].Label, "Great Title")
	eq(t, "item var", done.Items[0].Vars["item"], "Great Title")
	in := cellOf(done, 0, 0).Inputs[0]
	eq(t, "link path", in.Path, url)
	eq(t, "link name", in.Name, url)
	eq(t, "link kind", in.Kind, core.KindOther)
}

// linkStep is a fake downloader: it takes links and titles its job.
type linkStep struct{ fakeStep }

func (l *linkStep) Descriptor() core.Descriptor {
	d := l.fakeStep.Descriptor()
	d.Accepts = core.Accepts{URLs: true}
	return d
}

func (l *linkStep) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	info, err := l.fakeStep.DescribeStep(options)
	info.Accepts = core.Accepts{URLs: true}
	return info, err
}

func (l *linkStep) Run(ctx context.Context, job *core.JobContext) error {
	job.SetTitle("Great Title")
	return l.fakeStep.Run(ctx, job)
}
