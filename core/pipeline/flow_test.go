package pipeline

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

func TestLinearThreeByThree(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true}, &fakeStep{id: "c", split: true})
	r := e.start()
	_ = r
	p := e.save(pl("Linear",
		step("aaaaaaa1", "a", FromInput, fakeOpts{}),
		step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{}),
		step("ccccccc3", "c", "bbbbbbb2", fakeOpts{})))
	run := e.startRun(p, e.files("one.txt", "two.txt", "three.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	if len(done.Items) != 3 {
		t.Fatalf("items = %d", len(done.Items))
	}
	for i, it := range done.Items {
		var prev int64
		for s, c := range it.Cells {
			eq(t, "cell status", c.Status, core.CellDone)
			if len(c.Files) != 1 {
				t.Fatalf("item %d step %d files = %v", i, s, fileNames(c.Files))
			}
			if c.StartedAt < prev {
				t.Fatalf("item %d step %d started before the previous step finished", i, s)
			}
			prev = c.FinishedAt
		}
		if len(it.Cells[0].JobIDs) != 1 {
			t.Fatalf("job ids = %v", it.Cells[0].JobIDs)
		}
	}
	jobs, _ := e.jobs.List(t.Context(), core.JobFilter{PipelineRunID: run.ID})
	eq(t, "tagged jobs", len(jobs), 9)
	for _, j := range jobs {
		if j.PipelineStepID == "" {
			t.Fatalf("job without step tag: %+v", j)
		}
	}
}

func TestInFlightCap(t *testing.T) {
	newGate("cap")
	a := &fakeStep{id: "a", split: true}
	e := newEnv(t, 4, a)
	e.start()
	p := e.save(pl("Cap", step("aaaaaaa1", "a", FromInput, fakeOpts{Hold: "cap"})))
	var names []string
	for i := 0; i < 10; i++ {
		names = append(names, "f"+string(rune('a'+i))+".txt")
	}
	run := e.startRun(p, e.files(names...)...)
	until(t, "4 running", func() bool { return a.cur.Load() == 4 })
	time.Sleep(100 * time.Millisecond)
	cur, _ := e.r.Run(run.ID)
	active := 0
	for _, it := range cur.Items {
		if isActiveCell(it.Cells[0].Status) {
			active++
		}
	}
	eq(t, "active cells", active, 4)
	release("cap")
	e.waitStatus(run.ID, core.RunDone)
	if a.peak.Load() > 4 {
		t.Fatalf("peak = %d", a.peak.Load())
	}
}

func TestCapIsAtLeastTwo(t *testing.T) {
	newGate("cap2")
	a := &fakeStep{id: "a", split: true}
	e := newEnv(t, 1, a)
	e.start()
	p := e.save(pl("Cap2", step("aaaaaaa1", "a", FromInput, fakeOpts{Hold: "cap2"})))
	run := e.startRun(p, e.files("a.txt", "b.txt", "c.txt", "d.txt")...)
	until(t, "2 cells running", func() bool {
		cur, _ := e.r.Run(run.ID)
		n := 0
		for _, it := range cur.Items {
			if it.Cells[0].Status == core.CellRunning {
				n++
			}
		}
		return n == 2
	})
	release("cap2")
	e.waitStatus(run.ID, core.RunDone)
}

func TestFanOutAndRoleFilter(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	roles := []string{"Vocals", "Drums", "Bass", "Other"}
	s2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})
	s2.Filter = core.StepFilter{Roles: []string{"bass"}}
	p := e.save(pl("Fan", step("aaaaaaa1", "a", FromInput, fakeOpts{Make: 4, Roles: roles}), s2))
	run := e.startRun(p, e.files("song.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "step 1 files", len(cellOf(done, 0, 0).Files), 4)
	in := cellOf(done, 0, 1).Inputs
	if len(in) != 1 || in[0].Role != "bass" || in[0].RoleLabel != "Bass" {
		t.Fatalf("filtered inputs = %+v", in)
	}
}

func TestFromEarlierStep(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true}, &fakeStep{id: "c", split: true})
	e.start()
	p := e.save(pl("Branch",
		step("aaaaaaa1", "a", FromInput, fakeOpts{Ext: ".wav"}),
		step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Ext: ".txt"}),
		step("ccccccc3", "c", "aaaaaaa1", fakeOpts{})))
	run := e.startRun(p, e.files("x.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "step 3 reads step 1's file", cellOf(done, 0, 2).Inputs[0].Path, cellOf(done, 0, 0).Files[0].Path)
	if cellOf(done, 0, 2).Inputs[0].Path == cellOf(done, 0, 1).Files[0].Path {
		t.Fatal("step 3 read step 2's file")
	}
}

func TestSkipsWhenNothingAccepted(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true}, &fakeManual{id: "m"})
	e.start()
	// Step 1 makes .wav; step 2 only reads .txt via a filter on kind=image: nothing left.
	s2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{})
	s2.Filter = core.StepFilter{Kinds: []core.OutputKind{core.KindImage}}
	p := e.save(pl("Skip", step("aaaaaaa1", "a", FromInput, fakeOpts{Ext: ".wav"}), s2,
		step("ccccccc3", "b", "bbbbbbb2", fakeOpts{})))
	run := e.startRun(p, e.files("x.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "status 2", cellOf(done, 0, 1).Status, core.CellSkipped)
	eq(t, "message 2", cellOf(done, 0, 1).Message, "Nothing for this step · 1 file skipped: filtered out")
	eq(t, "status 3", cellOf(done, 0, 2).Status, core.CellSkipped)
}

func TestTogetherMerge(t *testing.T) {
	a := &fakeStep{id: "a", split: true}
	z := &fakeStep{id: "z"}
	e := newEnv(t, 4, a, z, tableStep{})
	e.start()
	p := e.save(pl("Merge",
		step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"who": "{item}"}}),
		step("zzzzzzz2", "z", "aaaaaaa1", fakeOpts{Together: true}),
		step("ttttttt3", "table", FromNone, fakeOpts{})))
	_ = p
	// the table step has its own options type; build it by hand
	p.Steps[2].OptionsJSON = `{"cols":["{item}","{who}"]}`
	p = e.save(p)
	run := e.startRun(p, e.files("a.txt", "b.txt", "c.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "items", len(done.Items), 4)
	m := done.Items[3]
	eq(t, "label", m.Label, "All 3 files")
	eq(t, "mergedAt", m.MergedAt, "zzzzzzz2")
	eq(t, "merged", len(m.Merged), 3)
	statusesWant := []core.CellStatus{core.CellNone, core.CellDone, core.CellDone}
	for i, s := range statuses(done, 3) {
		eq(t, "merged cell", s, statusesWant[i])
	}
	for i := 0; i < 3; i++ {
		got := statuses(done, i)
		want := []core.CellStatus{core.CellDone, core.CellMerged, core.CellNone}
		for k := range want {
			eq(t, "orig cell", got[k], want[k])
		}
	}
	// One job read all three files.
	eq(t, "together inputs", len(cellOf(done, 3, 1).Inputs), 3)
	eq(t, "together jobs", len(cellOf(done, 3, 1).JobIDs), 1)
	// Table: one row per item with that item's variables.
	csvFile := cellOf(done, 3, 2).Files[0].Path
	data, err := os.ReadFile(csvFile)
	must(t, err)
	got := strings.Fields(strings.ReplaceAll(string(data), ",", " "))
	eq(t, "rows", strings.Join(got, "|"), "a|a|b|b|c|c")
}

func TestTogetherReadsPreMergeStep(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true}, &fakeStep{id: "z"})
	e.start()
	p := e.save(pl("Pre",
		step("aaaaaaa1", "a", FromInput, fakeOpts{Ext: ".wav"}),
		step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Ext: ".txt"}),
		step("zzzzzzz3", "z", "aaaaaaa1", fakeOpts{Together: true}),
		step("ccccccc4", "b", "zzzzzzz3", fakeOpts{})))
	run := e.startRun(p, e.files("a.txt", "b.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	in := cellOf(done, 2, 2).Inputs
	eq(t, "inputs", len(in), 2)
	for i, f := range in {
		eq(t, "reads step 1", f.Path, cellOf(done, i, 0).Files[0].Path)
	}
	eq(t, "post-merge step ran on the merged item", cellOf(done, 2, 3).Status, core.CellDone)
}

func TestTogetherLeavesFailedItemsOutAndLateRetrySkips(t *testing.T) {
	flag := filepath.Join(t.TempDir(), "fail")
	must(t, os.WriteFile(flag, nil, 0o644))
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "z"})
	e.start()
	p := e.save(pl("Left",
		step("aaaaaaa1", "a", FromInput, fakeOpts{}),
		step("bbbbbbb2", "a", "aaaaaaa1", fakeOpts{FailOn: "bad", FailFlag: flag}),
		step("zzzzzzz3", "z", "bbbbbbb2", fakeOpts{Together: true})))
	run := e.startRun(p, e.files("good1.txt", "bad.txt", "good2.txt")...)
	partial := e.waitStatus(run.ID, core.RunPartial)
	m := partial.Items[3]
	eq(t, "merged gathers healthy items", len(m.Merged), 2)
	eq(t, "bad item cell", cellOf(partial, 1, 1).Status, core.CellFailed)
	eq(t, "bad item blocked", cellOf(partial, 1, 2).Status, core.CellBlocked)
	eq(t, "together inputs", len(cellOf(partial, 3, 2).Inputs), 2)

	// Fix the problem and retry: the late item stops at the together step.
	must(t, os.Remove(flag))
	_, err := e.r.Retry(run.ID)
	must(t, err)
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "bad item step 2", cellOf(done, 1, 1).Status, core.CellDone)
	eq(t, "late item skipped", cellOf(done, 1, 2).Status, core.CellSkipped)
	eq(t, "late message", cellOf(done, 1, 2).Message, "Finished after the files were gathered")
	eq(t, "merged unchanged", len(cellOf(done, 3, 2).Inputs), 2)
}

func TestPassThroughOnZeroJobs(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	s2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{NoJob: true})
	s2.Keep = false
	p := e.save(pl("Pass", step("aaaaaaa1", "a", FromInput, fakeOpts{}), s2, step("ccccccc3", "a", "bbbbbbb2", fakeOpts{})))
	run := e.startRun(p, e.files("x.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	c1, c2, c3 := cellOf(done, 0, 0), cellOf(done, 0, 1), cellOf(done, 0, 2)
	eq(t, "no jobs", len(c2.JobIDs), 0)
	eq(t, "passed on", len(c2.Files), 1)
	eq(t, "same file", c2.Files[0].Path, c1.Files[0].Path)
	eq(t, "same output id", c2.Files[0].OutputID, c1.Files[0].OutputID)
	eq(t, "step 3 reads it", c3.Inputs[0].Path, c1.Files[0].Path)
}

func TestZeroJobsWithoutInputsMakesNothing(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, tableStep{})
	e.start()
	p := e.save(pl("Nothing", step("aaaaaaa1", "a", FromInput, fakeOpts{})))
	run := e.startRun(p, e.files("x.txt")...)
	e.waitStatus(run.ID, core.RunDone)
}

func TestVariables(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "b", split: true})
	e.start()
	s1 := step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"bpm": "120", "key": "{item}-k", "unsetvar": "<unset>"}})
	s2 := step("bbbbbbb2", "b", "aaaaaaa1", fakeOpts{Vars: map[string]string{"bpm": "130"}, Template: "{bpm}|{key}|{unsetvar}|{n}|{pipeline}|{date}"})
	p := e.save(pl("Vars", s1, s2))
	run := e.startRun(p, e.files("one.txt", "two.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	// Step 2 saw step 1's bpm (accumulation) and its own bpm replaces it (override).
	eq(t, "bpm overridden", done.Items[0].Vars["bpm"], "130")
	eq(t, "key accumulated", done.Items[1].Vars["key"], "two-k")
	eq(t, "item built-in", done.Items[1].Vars["item"], "two")
	eq(t, "n", done.Items[1].Vars["n"], "2")
	eq(t, "pipeline", done.Items[0].Vars["pipeline"], "Vars")
	data, err := os.ReadFile(cellOf(done, 1, 1).Files[0].Path)
	must(t, err)
	today := time.UnixMilli(done.CreatedAt).Local().Format("2006-01-02")
	eq(t, "expanded", string(data), "120|two-k||2|Vars|"+today)
}

func TestMergedItemStartsWithBuiltinsOnly(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "z"})
	e.start()
	p := e.save(pl("Builtin",
		step("aaaaaaa1", "a", FromInput, fakeOpts{Vars: map[string]string{"bpm": "1"}}),
		step("zzzzzzz2", "z", "aaaaaaa1", fakeOpts{Together: true, Template: "[{bpm}]"})))
	run := e.startRun(p, e.files("a.txt", "b.txt")...)
	done := e.waitStatus(run.ID, core.RunDone)
	if _, ok := done.Items[2].Vars["bpm"]; ok {
		t.Fatalf("merged item inherited bpm: %v", done.Items[2].Vars)
	}
	data, _ := os.ReadFile(cellOf(done, 2, 1).Files[0].Path)
	eq(t, "template", string(data), "[]")
}

func TestVariablesAreCappedPerItem(t *testing.T) {
	item := core.RunItem{Vars: map[string]string{}}
	big := strings.Repeat("x", core.MaxVarBytes+10)
	mergeVars(&item, map[string]string{"a": big, "b": big, "c": big, "d": big, "e": big, "Bad": "x"})
	total := 0
	for k, v := range item.Vars {
		if len(v) > core.MaxVarBytes {
			t.Fatalf("%s not capped: %d", k, len(v))
		}
		total += len(v)
	}
	if total > core.MaxItemVarBytes || len(item.Vars) != 5 {
		t.Fatalf("total %d, vars %d", total, len(item.Vars))
	}
}
