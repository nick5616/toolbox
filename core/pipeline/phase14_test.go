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

// ---- helpers ----

// startWith builds the env's Runner with tweaks (clipboard hooks) before it starts.
func (e *env) startWith(tweak func(*Runner)) *Runner {
	e.t.Helper()
	r := e.newRunner()
	tweak(r)
	must(e.t, r.Start(context.Background()))
	e.t.Cleanup(r.Stop)
	e.r = r
	return r
}

func (e *env) eventuallyRuns(p core.Pipeline, n int) []core.PipelineRun {
	e.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if runs := e.runsOf(p); len(runs) >= n {
			return runs
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatalf("timed out waiting for %d runs of %s", n, p.Name)
	return nil
}

func textItem(id, text string) core.ClipItem {
	return core.ClipItem{ID: id, Kind: core.ClipText, Text: text}
}

// ---- the clipboard trigger ----

func clipPipe(accepts []string, c core.ClipTrigger) (core.Pipeline, *fakeStep) {
	f := &fakeStep{id: "a", split: true, accepts: accepts}
	p := pl("On copy", step("aaaaaaa1", "a", FromInput, fakeOpts{}))
	p.Clip = c
	return p, f
}

func TestClipTriggerStartsRunWithTextFile(t *testing.T) {
	p, f := clipPipe(nil, core.ClipTrigger{Enabled: true, Kinds: []string{"text"}, Pattern: `invoice \d+`})
	e := newEnv(t, 4, f)
	tmp := t.TempDir()
	e.startWith(func(r *Runner) {
		r.cfg.TmpDir = tmp
		r.cfg.ClipboardOn = func() bool { return true }
	})
	p = e.save(p)
	eq(t, "state", e.r.List()[0].Clip.Active, true)

	e.r.ClipboardCopied(textItem("c1", "Please pay invoice 42 today"))
	runs := e.eventuallyRuns(p, 1)
	eq(t, "trigger", runs[0].Trigger, "clipboard")
	eq(t, "one input", len(runs[0].Inputs), 1)
	in := runs[0].Inputs[0]
	if filepath.Dir(in) != filepath.Join(tmp, clipRunsDir) || filepath.Ext(in) != ".txt" {
		t.Fatalf("input = %s", in)
	}
	b, err := os.ReadFile(in)
	must(t, err)
	eq(t, "text", string(b), "Please pay invoice 42 today")
	e.waitStatus(runs[0].ID, core.RunDone)
}

func TestClipTriggerPrivacyAndMatching(t *testing.T) {
	p, f := clipPipe([]string{".txt", ".png"}, core.ClipTrigger{Enabled: true, Kinds: []string{"text", "image"}, Pattern: "secret-word"})
	e := newEnv(t, 4, f)
	on := true
	e.startWith(func(r *Runner) {
		r.cfg.TmpDir = t.TempDir()
		r.cfg.ClipboardOn = func() bool { return on }
	})
	p = e.save(p)

	// Recording off: nothing fires, however well the copy matches.
	on = false
	eq(t, "state says why", e.r.List()[0].Clip.Message != "", true)
	e.r.fireClip(textItem("c1", "has secret-word in it"))
	eq(t, "no run while recording is off", len(e.runsOf(p)), 0)
	on = true

	// Text that doesn't match the pattern, and a link when links aren't a kind.
	e.r.fireClip(textItem("c2", "nothing to see"))
	e.r.fireClip(textItem("c3", "https://example.com/a"))
	// An image that is gone from disk can't start a run.
	e.r.fireClip(core.ClipItem{ID: "c4", Kind: core.ClipImage, ImagePath: filepath.Join(t.TempDir(), "missing.png")})
	eq(t, "no run for non-matches", len(e.runsOf(p)), 0)

	// A real image: the saved PNG is the input.
	png := filepath.Join(t.TempDir(), "c5.png")
	must(t, os.WriteFile(png, []byte("png"), 0o644))
	e.r.fireClip(core.ClipItem{ID: "c5", Kind: core.ClipImage, ImagePath: png})
	runs := e.eventuallyRuns(p, 1)
	eq(t, "image input", runs[0].Inputs[0], png)
	e.waitStatus(runs[0].ID, core.RunDone)

	// A disabled trigger never fires.
	p.Clip.Enabled = false
	p = e.save(p)
	e.r.fireClip(textItem("c6", "secret-word"))
	eq(t, "disabled", len(e.runsOf(p)), 1)
}

func TestClipTriggerNeverBeforeStartOrNilGuard(t *testing.T) {
	p, f := clipPipe(nil, core.ClipTrigger{Enabled: true, Kinds: []string{"text"}, Pattern: "x"})
	e := newEnv(t, 4, f)
	e.start() // no ClipboardOn: the trigger never fires
	p = e.save(p)
	e.r.ClipboardCopied(textItem("c1", "x"))
	e.r.fireClip(textItem("c1", "x"))
	eq(t, "no run without a recording signal", len(e.runsOf(p)), 0)
	eq(t, "state", e.r.List()[0].Clip.Active, false)
}

func TestClipTriggerOneRunAtATime(t *testing.T) {
	newGate("clip-hold")
	f := &fakeStep{id: "a", split: true}
	p := pl("Slow", step("aaaaaaa1", "a", FromInput, fakeOpts{Hold: "clip-hold"}))
	p.Clip = core.ClipTrigger{Enabled: true, Kinds: []string{"text"}, Pattern: "go"}
	e := newEnv(t, 4, f)
	e.startWith(func(r *Runner) {
		r.cfg.TmpDir = t.TempDir()
		r.cfg.ClipboardOn = func() bool { return true }
	})
	p = e.save(p)
	e.r.fireClip(textItem("c1", "go 1"))
	e.eventuallyRuns(p, 1)
	e.r.fireClip(textItem("c2", "go 2"))
	eq(t, "the second copy waits for the first run", len(e.runsOf(p)), 1)
	release("clip-hold")
	e.waitStatus(e.runsOf(p)[0].ID, core.RunDone)
	e.r.fireClip(textItem("c3", "go 3"))
	e.eventuallyRuns(p, 2)
}

func TestClipMatchKinds(t *testing.T) {
	c := core.ClipTrigger{Enabled: true, Kinds: []string{"link", "text"}, Pattern: `^note:`}
	for _, tc := range []struct {
		name string
		it   core.ClipItem
		want string
	}{
		{"link", textItem("1", " https://a.example/x \n"), "link"},
		{"two words with a link are text", textItem("2", "see https://a.example/x"), ""},
		{"pattern", textItem("3", "note: buy milk"), "text"},
		{"no match", textItem("4", "buy milk"), ""},
		{"image not a kind", core.ClipItem{Kind: core.ClipImage, ImagePath: "/x.png"}, ""},
	} {
		eq(t, tc.name, clipMatch(c, tc.it), tc.want)
	}
	c.Enabled = false
	eq(t, "disabled", clipMatch(c, textItem("1", "note: x")), "")
	c = core.ClipTrigger{Enabled: true, Kinds: []string{"text"}}
	eq(t, "text needs a pattern", clipMatch(c, textItem("1", "anything")), "")
}

func TestClipTriggerSaveAndDescribeProblems(t *testing.T) {
	f := &fakeStep{id: "a", split: true}
	e := newEnv(t, 2, f)
	e.start()
	p := pl("Clip", step("aaaaaaa1", "a", FromInput, fakeOpts{}))

	p.Clip = core.ClipTrigger{Enabled: true, Kinds: []string{"nope"}}
	if _, err := e.r.Save(p); err == nil {
		t.Fatal("unknown kind saved")
	}
	p.Clip = core.ClipTrigger{Enabled: true, Kinds: []string{"text"}, Pattern: "("}
	if _, err := e.r.Save(p); err == nil {
		t.Fatal("bad regexp saved")
	}
	for _, tc := range []struct {
		c    core.ClipTrigger
		want string
	}{
		{core.ClipTrigger{Enabled: true}, "Choose what to react to"},
		{core.ClipTrigger{Enabled: true, Kinds: []string{"text"}}, "pattern"},
		{core.ClipTrigger{Enabled: true, Kinds: []string{"link"}}, "links"},
		{core.ClipTrigger{Enabled: true, Kinds: []string{"image"}}, "images"},
	} {
		p.Clip = tc.c
		check := e.r.Describe(p)
		if check.Ready || !strings.Contains(strings.Join(check.Problems, "|"), tc.want) {
			t.Errorf("%+v: problems = %v", tc.c, check.Problems)
		}
	}
	p.Clip = core.ClipTrigger{Enabled: true, Kinds: []string{"text"}, Pattern: "x"}
	if check := e.r.Describe(p); !check.Ready {
		t.Errorf("valid trigger: %v", check.Problems)
	}
}

func TestPruneClipRuns(t *testing.T) {
	f := &fakeStep{id: "a", split: true}
	e := newEnv(t, 2, f)
	tmp := t.TempDir()
	dir := filepath.Join(tmp, clipRunsDir)
	must(t, os.MkdirAll(dir, 0o755))
	oldP, newP := filepath.Join(dir, "old.txt"), filepath.Join(dir, "new.txt")
	must(t, os.WriteFile(oldP, []byte("x"), 0o644))
	must(t, os.WriteFile(newP, []byte("x"), 0o644))
	past := time.Now().Add(-10 * 24 * time.Hour)
	must(t, os.Chtimes(oldP, past, past))
	e.startWith(func(r *Runner) { r.cfg.TmpDir = tmp })
	if _, err := os.Stat(oldP); err == nil {
		t.Error("an old copied-text file survived")
	}
	if _, err := os.Stat(newP); err != nil {
		t.Error("a new copied-text file was deleted")
	}
}

// ---- cycles ----

func mkPipe(id, name string, targets ...string) core.Pipeline {
	p := core.Pipeline{ID: id, Name: name}
	for i, t := range targets {
		b, _ := json.Marshal(map[string]string{"pipelineId": t})
		p.Steps = append(p.Steps, core.PipelineStep{ID: "step000" + string(rune('a'+i)), Type: RunPipelineType, OptionsJSON: string(b), From: FromInput})
	}
	return p
}

func TestCycleThrough(t *testing.T) {
	a, b, c := mkPipe("A", "A", "B"), mkPipe("B", "B", "C"), mkPipe("C", "C")
	all := []core.Pipeline{a, b, c}
	eq(t, "a chain is fine", len(cycleThrough(a, all)), 0)

	c2 := mkPipe("C", "C", "A")
	got := cycleThrough(c2, all)
	eq(t, "A → B → C → A found from C", strings.Join(got, " → "), "C → A → B → C")
	eq(t, "found from A", strings.Join(cycleThrough(mkPipe("A", "A", "B"), []core.Pipeline{a, b, c2}), " → "), "A → B → C → A")

	self := mkPipe("S", "S", "S")
	eq(t, "self", strings.Join(cycleThrough(self, []core.Pipeline{self}), " → "), "S → S")

	eq(t, "unsaved pipelines can't be in a cycle", len(cycleThrough(mkPipe("", "New", "A"), all)), 0)
	eq(t, "a missing target is not a cycle", len(cycleThrough(mkPipe("X", "X", "gone"), all)), 0)

	// The saved copy of the pipeline being checked is replaced by the new one.
	a2 := mkPipe("A", "A") // A no longer runs B
	eq(t, "replaced", len(cycleThrough(c2, []core.Pipeline{a2, b, c2})), 0)

	// A diamond is not a cycle.
	d1, d2, d3, d4 := mkPipe("1", "1", "2", "3"), mkPipe("2", "2", "4"), mkPipe("3", "3", "4"), mkPipe("4", "4")
	eq(t, "diamond", len(cycleThrough(d1, []core.Pipeline{d1, d2, d3, d4})), 0)
}

func TestSaveRefusesCyclesAndDescribeFlagsThem(t *testing.T) {
	f := &fakeStep{id: "a", split: true}
	e := newEnv(t, 2, f)
	e.start()
	runOf := func(target string) core.PipelineStep {
		b, _ := json.Marshal(map[string]string{"pipelineId": target})
		return core.PipelineStep{ID: "runstep1", Type: RunPipelineType, OptionsJSON: string(b), From: FromInput}
	}
	a := e.save(pl("A", step("aaaaaaa1", "a", FromInput, fakeOpts{})))
	b := e.save(core.Pipeline{Name: "B", Steps: []core.PipelineStep{runOf(a.ID)}})

	a.Steps = []core.PipelineStep{runOf(b.ID)}
	_, err := e.r.Save(a)
	if err == nil || !core.IsCode(err, core.CodeValidation) || !strings.Contains(err.Error(), "A → B → A") {
		t.Fatalf("A → B → A saved: %v", err)
	}
	self := a
	self.Steps = []core.PipelineStep{runOf(a.ID)}
	if _, err := e.r.Save(self); err == nil {
		t.Fatal("a pipeline that runs itself saved")
	}
	// Describe also flags a loop that got into storage some other way.
	check := e.r.Describe(a)
	if check.Ready || !strings.Contains(strings.Join(check.Steps[0].Problems, "|"), "A → B → A") {
		t.Fatalf("describe: %v", check.Steps[0].Problems)
	}
	if got := e.r.Cycle(a); got != "A → B → A" {
		t.Fatalf("Cycle = %q", got)
	}
	// Running B from a third pipeline is fine.
	e.save(core.Pipeline{Name: "C", Steps: []core.PipelineStep{runOf(b.ID)}})
}

// ---- aliases, step providers, Chainable modules that take no drops ----

func TestAliasResolvesIsHiddenAndRewritten(t *testing.T) {
	f := &fakeStep{id: "a", split: true}
	e := newEnv(t, 2, f)
	r := e.start()
	r.RegisterAlias("old-a", "a")
	for _, st := range r.Catalog() {
		if st.ID == "old-a" {
			t.Fatal("the alias is listed")
		}
	}
	p := e.save(pl("Old", step("aaaaaaa1", "old-a", FromInput, fakeOpts{})))
	eq(t, "rewritten to the canonical ID", p.Steps[0].Type, "a")
	check := r.Describe(core.Pipeline{Name: "x", Steps: []core.PipelineStep{{ID: "bbbbbbb1", Type: "old-a", From: FromInput, OptionsJSON: "{}"}}})
	eq(t, "old IDs still describe", len(check.Steps[0].Problems), 0)
	// An already-saved pipeline with the old ID runs.
	run := e.startRun(p, e.files("x.txt")[0])
	e.waitStatus(run.ID, core.RunDone)
}

// provMod is a job-less tool that is a step through a companion module.
type provMod struct{ *fakeStep }

func (p provMod) Descriptor() core.Descriptor {
	d := p.fakeStep.Descriptor()
	d.JobLess, d.Accepts = true, core.Accepts{}
	return d
}

func (p provMod) StepType() core.StepType {
	return core.StepType{ModuleID: "comp", Name: "Prov step", Accepts: core.Accepts{Extensions: []string{".txt"}}}
}

func TestStepProviderRunsOnItsCompanion(t *testing.T) {
	comp := &fakeStep{id: "comp", split: true}
	prov := provMod{&fakeStep{id: "prov", split: true}}
	e := newEnv(t, 2, comp, prov)
	r := e.start()
	var st *core.StepType
	for _, s := range r.Catalog() {
		if s.ID == "prov" {
			s := s
			st = &s
		}
	}
	if st == nil {
		t.Fatal("the provider isn't in the catalogue")
	}
	eq(t, "name", st.Name, "Prov step")
	eq(t, "jobs run on the companion", st.ModuleID, "comp")
	eq(t, "auto", st.Auto, true)
	p := e.save(pl("Prov", step("aaaaaaa1", "prov", FromInput, fakeOpts{})))
	run := e.startRun(p, e.files("x.txt")[0])
	done := e.waitStatus(run.ID, core.RunDone)
	eq(t, "made a file", len(cellOf(done, 0, 0).Files), 1)
	jobs, _ := e.jobs.List(t.Context(), core.JobFilter{PipelineRunID: run.ID})
	if len(jobs) != 1 || jobs[0].ModuleID != "comp" {
		t.Errorf("the job didn't run on the companion module: %+v", jobs)
	}
}

type noDrop struct{ *fakeStep }

func (n noDrop) Descriptor() core.Descriptor {
	d := n.fakeStep.Descriptor()
	d.Accepts = core.Accepts{}
	return d
}

func TestChainableWithoutDropsIsAStep(t *testing.T) {
	m := noDrop{&fakeStep{id: "nd", split: true}}
	e := newEnv(t, 2, m)
	r := e.start()
	var st *core.StepType
	for _, s := range r.Catalog() {
		if s.ID == "nd" {
			s := s
			st = &s
		}
	}
	if st == nil {
		t.Fatal("a Chainable module with no drops isn't a step")
	}
	eq(t, "accepts come from the step", len(st.Accepts.Extensions), 2)
	// A module with nothing to read and no adapter is not a step.
	if _, _, ok := moduleStep(core.Descriptor{ID: "z", Status: core.StatusReady}, &fakeManual{id: "z"}); ok {
		t.Error("a module that reads nothing is a step")
	}
}
