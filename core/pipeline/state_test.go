package pipeline

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

// restart simulates quitting and relaunching: the Runner stops, the job
// manager shuts down (interrupting running jobs) and both are rebuilt on the
// same database.
func (e *env) restart() *Runner {
	e.t.Helper()
	e.r.Stop()
	_ = e.jobs.Shutdown(5 * time.Second)
	e.jobs = core.NewJobs(e.db, e.db, e.reg, e.em, func(id string) (string, error) { return e.tools(id) },
		func() core.Settings { return core.Settings{LibraryDir: e.lib, Concurrency: e.conc} }, filepath.Join(e.dbDir, "tmp"))
	must(e.t, e.jobs.Start(context.Background()))
	return e.start()
}

func TestRestartInterruptedAndQueuedJobs(t *testing.T) {
	newGate("restart1")
	e := newEnv(t, 1, &fakeStep{id: "a", split: true})
	e.start()
	p := e.save(pl("Restart", step("aaaaaaa1", "a", FromInput, fakeOpts{Hold: "restart1"})))
	run := e.startRun(p, e.files("1.txt", "2.txt", "3.txt")...)
	until(t, "two cells running", func() bool {
		cur, _ := e.r.Run(run.ID)
		n := 0
		for _, it := range cur.Items {
			if it.Cells[0].Status == core.CellRunning {
				n++
			}
		}
		return n == 2
	})
	e.restart()
	// Job 1 was interrupted; job 2 (queued) and item 3 carry on by themselves.
	release("restart1")
	partial := e.waitStatus(run.ID, core.RunPartial)
	// Which of the first two items held the running job depends on how their
	// prepares raced; exactly one was interrupted.
	failedItem, doneCount := -1, 0
	for i := range partial.Items {
		switch cellOf(partial, i, 0).Status {
		case core.CellFailed:
			failedItem = i
		case core.CellDone:
			doneCount++
		}
	}
	if failedItem < 0 || failedItem > 1 || doneCount != 2 {
		t.Fatalf("unexpected cells:\n%s", dump(partial))
	}
	c := cellOf(partial, failedItem, 0)
	eq(t, "error", c.Error, "Interrupted when Toolbox quit")

	jobID := c.JobIDs[0]
	_, err := e.r.Retry(run.ID)
	must(t, err)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "same job retried", cellOf(done, failedItem, 0).JobIDs[0], jobID)
}

func TestRestartPreparingCellAndLostSecret(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	in := e.files("x.txt")[0]
	mk := func(id string, steps []core.PipelineStep, st core.CellStatus) core.PipelineRun {
		cells := make([]core.RunCell, len(steps))
		for i, s := range steps {
			cells[i] = core.RunCell{StepID: s.ID, Status: core.CellPending}
		}
		cells[0].Status = st
		cells[0].Inputs = []core.RunFile{inputRunFile(in)}
		return core.PipelineRun{ID: id, PipelineID: "gone", Name: "Crafted", Steps: steps, Status: core.RunRunning, Trigger: "manual",
			Inputs: []string{in}, CreatedAt: time.Now().UnixMilli(),
			Items: []core.RunItem{{Index: 0, Label: "x.txt", Input: in, Cells: cells,
				Vars: builtinVars("x.txt", false, 1, "Crafted", time.Now())}}}
	}
	put := func(r core.PipelineRun) {
		b, _ := json.Marshal(r)
		must(t, e.db.PutRun(context.Background(), r, string(b)))
	}
	put(mk("00000000000000000000000001", []core.PipelineStep{step("aaaaaaa1", "a", FromInput, fakeOpts{}), step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})}, core.CellPreparing))
	put(mk("00000000000000000000000002", []core.PipelineStep{step("aaaaaaa1", "a", FromInput, fakeOpts{Secret: true}), step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})}, core.CellPending))
	e.start()
	done := e.waitStatus("00000000000000000000000001", core.RunDone)
	eq(t, "preparing cell was prepared again", cellOf(done, 0, 0).Status, core.CellDone)
	failed := e.waitStatus("00000000000000000000000002", core.RunFailed)
	c := cellOf(failed, 0, 0)
	eq(t, "lost secret", c.Error, "Passwords aren't kept after a restart")
	eq(t, "hint", c.ErrorHint, "Start the run again")
	eq(t, "later blocked", cellOf(failed, 0, 1).Status, core.CellBlocked)
}

func TestRestartKeepsWaitingManualCell(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	p := manualPipeline(e, true)
	run := e.startRun(p, e.files("song.txt")...)
	w := e.waitCell(run.ID, 0, 1, core.CellWaiting)
	in := cellOf(w, 0, 1).Inputs[0].Path
	e.restart()
	cur, err := e.r.Run(run.ID)
	must(t, err)
	eq(t, "still waiting", cellOf(cur, 0, 1).Status, core.CellWaiting)
	eq(t, "needs you", cur.NeedsYou, 1)
	// Adoption keeps working after the restart.
	e.submitDirect("a", fakeOpts{}, in)
	e.waitStatus(run.ID, core.RunDone)
}

func TestHistoryPrunedAtStart(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	for i := 0; i < KeepFinishedRuns+5; i++ {
		r := core.PipelineRun{ID: core.NewID(), PipelineID: "p", Status: core.RunDone, CreatedAt: int64(1000 + i)}
		b, _ := json.Marshal(r)
		must(t, e.db.PutRun(context.Background(), r, string(b)))
	}
	e.start()
	runs, err := e.r.Runs(core.RunFilter{Limit: 200})
	must(t, err)
	eq(t, "kept", len(runs), KeepFinishedRuns)
	removed := e.em.named(core.EventPipelinesRunsRemoved)
	if len(removed) != 1 || len(removed[0].(core.RunsRemoved).IDs) != 5 {
		t.Fatalf("removed events = %+v", removed)
	}
}

func cleanupEnv(t *testing.T) (*env, []string) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	return e, e.files("x.txt")
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func TestCleanUpAfterDoneRun(t *testing.T) {
	e, in := cleanupEnv(t)
	s1 := step("aaaaaaa1", "a", FromInput, fakeOpts{})
	s2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})
	s3 := step("ccccccc3", "a", "bbbbbbb2", fakeOpts{})
	s1.Keep, s2.Keep = false, false
	p := e.save(pl("Clean", s1, s2, s3))
	run := e.startRun(p, in...)
	done := e.waitStatus(run.ID, core.RunDone)
	until(t, "cleaned", func() bool { r, _ := e.r.Run(run.ID); return r.Cleaned })
	f1, f2, f3 := cellOf(done, 0, 0).Files[0], cellOf(done, 0, 1).Files[0], cellOf(done, 0, 2).Files[0]
	if !f1.Temporary || !f2.Temporary || f3.Temporary {
		t.Fatalf("temporary flags: %v %v %v", f1.Temporary, f2.Temporary, f3.Temporary)
	}
	if exists(f1.Path) || exists(f2.Path) {
		t.Fatal("in-between files were not deleted")
	}
	if !exists(f3.Path) || !exists(in[0]) {
		t.Fatal("kept file or input deleted")
	}
	for _, f := range []core.RunFile{f1, f2} {
		if _, err := e.db.GetOutput(context.Background(), f.OutputID); !core.IsCode(err, core.CodeNotFound) {
			t.Fatalf("library record of %s kept: %v", f.Name, err)
		}
	}
	if _, err := e.db.GetOutput(context.Background(), f3.OutputID); err != nil {
		t.Fatalf("kept record gone: %v", err)
	}
	ev := e.em.named(core.EventLibraryRemoved)
	if len(ev) != 1 || len(ev[0].(core.OutputsRemoved).IDs) != 2 {
		t.Fatalf("library:removed = %+v", ev)
	}
	cur, _ := e.r.Run(run.ID)
	if !cellOf(cur, 0, 0).Files[0].Missing {
		t.Fatal("Missing not computed when the run is read")
	}
}

func TestCleanUpKeepsFilesAKeptCellStillLists(t *testing.T) {
	e, in := cleanupEnv(t)
	s1 := step("aaaaaaa1", "a", FromInput, fakeOpts{})
	s1.Keep = false
	s2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{NoJob: true}) // passes step 1's file on, kept
	p := e.save(pl("Protect", s1, s2))
	run := e.startRun(p, in...)
	done := e.waitStatus(run.ID, core.RunDone)
	until(t, "cleaned", func() bool { r, _ := e.r.Run(run.ID); return r.Cleaned })
	f := cellOf(done, 0, 0).Files[0]
	if !exists(f.Path) {
		t.Fatal("a file listed by a kept cell was deleted")
	}
}

func TestCleanUpManualPartialRunAndRetryRefused(t *testing.T) {
	flag := filepath.Join(t.TempDir(), "f")
	must(t, os.WriteFile(flag, nil, 0o644))
	e, in := cleanupEnv(t)
	s1 := step("aaaaaaa1", "a", FromInput, fakeOpts{})
	s1.Keep = false
	p := e.save(pl("Partial", s1, step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{FailFlag: flag})))
	run := e.startRun(p, in...)
	failed := e.waitStatus(run.ID, core.RunFailed)
	f := cellOf(failed, 0, 0).Files[0]
	time.Sleep(100 * time.Millisecond)
	if !exists(f.Path) || failed.Cleaned {
		t.Fatal("a failed run must keep its files")
	}
	// A missing file doesn't break clean-up.
	other := e.startRun(p, e.files("y.txt")...)
	of := e.waitStatus(other.ID, core.RunFailed)
	must(t, os.Remove(cellOf(of, 0, 0).Files[0].Path))
	n, err := e.r.CleanUp(other.ID)
	must(t, err)
	eq(t, "missing file's record removed", n, 1)

	n, err = e.r.CleanUp(run.ID)
	must(t, err)
	eq(t, "deleted", n, 1)
	if exists(f.Path) {
		t.Fatal("file kept")
	}
	if _, err := e.r.Retry(run.ID); !core.IsCode(err, core.CodeConflict) {
		t.Fatalf("retry of a cleaned run: %v", err)
	}
}

func TestRemoveRun(t *testing.T) {
	newGate("rm")
	e, in := cleanupEnv(t)
	s1 := step("aaaaaaa1", "a", FromInput, fakeOpts{Hold: "rm"})
	s1.Keep = false
	p := e.save(pl("Remove", s1))
	run := e.startRun(p, in...)
	if err := e.r.Remove(run.ID, true); !core.IsCode(err, core.CodeConflict) {
		t.Fatalf("remove while running: %v", err)
	}
	if _, err := e.r.CleanUp(run.ID); !core.IsCode(err, core.CodeConflict) {
		t.Fatalf("clean-up while running: %v", err)
	}
	must(t, e.r.Cancel(run.ID))
	e.waitStatus(run.ID, core.RunCancelled)
	must(t, e.r.Remove(run.ID, false))
	if _, err := e.r.Run(run.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("removed run: %v", err)
	}
	if len(e.em.named(core.EventPipelinesRunsRemoved)) != 1 {
		t.Fatal("no runs-removed event")
	}
	if err := e.r.Remove(run.ID, false); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("remove twice: %v", err)
	}
	// Remove with deleteTemporary deletes in-between files of a finished run.
	t1 := step("aaaaaaa1", "a", FromInput, fakeOpts{})
	t1.Keep = false
	p2 := e.save(pl("Remove2", t1, step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Fail: "x"})))
	run2 := e.startRun(p2, e.files("w.txt")...)
	failed := e.waitStatus(run2.ID, core.RunFailed)
	f := cellOf(failed, 0, 0).Files[0]
	must(t, e.r.Remove(run2.ID, true))
	if exists(f.Path) {
		t.Fatal("Remove with deleteTemporary kept an in-between file")
	}
}

func TestRunStatusTable(t *testing.T) {
	r := New(Config{Reg: core.NewRegistry()})
	l := newLoop(r, context.Background())
	cells := func(sts ...core.CellStatus) []core.RunCell {
		var out []core.RunCell
		for _, s := range sts {
			c := core.RunCell{Status: s}
			if s == core.CellWaiting {
				c.Wait = core.WaitManual
			}
			out = append(out, c)
		}
		return out
	}
	const (
		D, F, C, S, B = core.CellDone, core.CellFailed, core.CellCancelled, core.CellSkipped, core.CellBlocked
		P, R, W       = core.CellPending, core.CellRunning, core.CellWaiting
		M, N          = core.CellMerged, core.CellNone
	)
	cases := []struct {
		name      string
		items     [][]core.CellStatus
		cancelled bool
		cond      bool
		want      core.RunStatus
		needs     int
	}{
		{"all done", [][]core.CellStatus{{D, D}, {D, D}}, false, false, core.RunDone, 0},
		{"skipped counts as success", [][]core.CellStatus{{D, S}, {S, S}}, false, false, core.RunDone, 0},
		{"merge cells", [][]core.CellStatus{{D, M, N}, {N, D, D}}, false, false, core.RunDone, 0},
		{"some failed", [][]core.CellStatus{{D, D}, {F, B}}, false, false, core.RunPartial, 0},
		{"some cancelled", [][]core.CellStatus{{D, D}, {C, B}}, false, false, core.RunPartial, 0},
		{"blocked item", [][]core.CellStatus{{D, D}, {D, B}}, false, false, core.RunPartial, 0},
		{"none succeeded", [][]core.CellStatus{{F, B}, {C, B}}, false, false, core.RunFailed, 0},
		{"running", [][]core.CellStatus{{D, R}, {D, P}}, false, false, core.RunRunning, 0},
		{"failed item but others still going", [][]core.CellStatus{{F, B}, {R, P}}, false, false, core.RunRunning, 0},
		{"waiting for the user", [][]core.CellStatus{{D, W}, {D, R}}, false, false, core.RunWaiting, 1},
		{"user cancelled", [][]core.CellStatus{{R, P}, {W, P}}, true, false, core.RunCancelled, 1},
		{"cancelled and finished", [][]core.CellStatus{{C, B}, {D, D}}, true, false, core.RunCancelled, 0},
		{"condition wait isn't the user's", [][]core.CellStatus{{D, W}}, false, true, core.RunRunning, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			run := core.PipelineRun{ID: "r", PipelineID: "p", Status: core.RunRunning, CreatedAt: 1}
			for i, sts := range c.items {
				cs := cells(sts...)
				if c.cond {
					for k := range cs {
						if cs[k].Status == core.CellWaiting {
							cs[k].Wait = core.WaitCondition
						}
					}
				}
				run.Items = append(run.Items, core.RunItem{Index: i, Cells: cs})
			}
			rs := &runState{r: run, tIdx: -1, rt: map[[2]int]*cellRT{}, cancelled: c.cancelled}
			l.runs[run.ID] = rs
			l.recompute(rs)
			eq(t, "status", rs.r.Status, c.want)
			eq(t, "needs you", rs.r.NeedsYou, c.needs)
			if isTerminalRun(c.want) && rs.r.FinishedAt == 0 {
				t.Fatal("finished run without FinishedAt")
			}
			if !isTerminalRun(c.want) && rs.r.FinishedAt != 0 {
				t.Fatal("active run with FinishedAt")
			}
		})
	}
}

func TestRunEventsAreThrottled(t *testing.T) {
	e := newEnv(t, 8, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	r := e.newRunner()
	r.emitEvery = 150 * time.Millisecond
	must(t, r.Start(context.Background()))
	t.Cleanup(r.Stop)
	e.r = r
	p := e.save(pl("Events", step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"big": strings.Repeat("é", 1000)}}), step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})))
	names := []string{}
	for i := 0; i < 12; i++ {
		names = append(names, "f"+string(rune('a'+i))+".txt")
	}
	t0 := time.Now()
	run := e.startRun(p, e.files(names...)...)
	e.waitStatus(run.ID, core.RunDone)
	until(t, "final event", func() bool {
		evs := e.em.named(core.EventPipelinesRun)
		return len(evs) > 0 && evs[len(evs)-1].(core.PipelineRun).Status == core.RunDone
	})
	elapsed := time.Since(t0)
	evs := e.em.named(core.EventPipelinesRun)
	if max := int(elapsed/r.emitEvery) + 2; len(evs) > max {
		t.Fatalf("%d events in %s (limit %d)", len(evs), elapsed, max)
	}
	last := evs[len(evs)-1].(core.PipelineRun)
	for _, it := range last.Items {
		if n := len([]rune(it.Vars["big"])); n > 301 {
			t.Fatalf("variable preview is %d characters", n)
		}
		eq(t, "latest snapshot delivered", it.Cells[1].Status, core.CellDone)
	}
	// The full values are persisted.
	state, err := e.db.GetRun(context.Background(), run.ID)
	must(t, err)
	var saved core.PipelineRun
	must(t, json.Unmarshal([]byte(state), &saved))
	eq(t, "persisted full value", len([]rune(saved.Items[0].Vars["big"])), 1000)
	eq(t, "persisted status", saved.Status, core.RunDone)
}

func TestRunStateSizeCap(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	r := e.newRunner()
	r.maxStateBytes = 150 << 10
	must(t, r.Start(context.Background()))
	t.Cleanup(r.Stop)
	e.r = r
	big := strings.Repeat("x", 100<<10)
	p := e.save(pl("Big", step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"big": big}})))
	run := e.startRun(p, e.files("a.txt", "b.txt")...)
	e.waitStatus(run.ID, core.RunDone)
	until(t, "persisted", func() bool {
		s, err := e.db.GetRun(context.Background(), run.ID)
		return err == nil && strings.Contains(s, `"done"`) && len(s) < 150<<10
	})
}

func TestStopIsIdempotentAndCommandsFailAfter(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	r := e.start()
	p := e.save(pl("Stop", step("aaaaaaa1", "a", FromInput, fakeOpts{})))
	r.Stop()
	r.Stop()
	if _, err := r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: e.files("z.txt")}, "manual"); err == nil {
		t.Fatal("StartRun after Stop")
	}
	if err := r.Cancel("x"); err == nil {
		t.Fatal("Cancel after Stop")
	}
}
