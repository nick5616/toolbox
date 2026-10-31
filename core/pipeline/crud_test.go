package pipeline

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"toolbox/core"
)

func TestSaveFillsAndPersists(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	e.start()
	p := pl("  First  ", core.PipelineStep{Type: "a", From: FromInput}, core.PipelineStep{Type: "a", From: "input"})
	p.Steps[1].From = FromInput
	ent, err := e.r.Save(p)
	must(t, err)
	got := ent.Pipeline
	if got.ID == "" || got.CreatedAt == 0 || got.UpdatedAt == 0 || got.Name != "First" {
		t.Fatalf("saved = %+v", got)
	}
	re := regexp.MustCompile(`^[a-z0-9]{8}$`)
	if !re.MatchString(got.Steps[0].ID) || !re.MatchString(got.Steps[1].ID) || got.Steps[0].ID == got.Steps[1].ID {
		t.Fatalf("step ids = %q %q", got.Steps[0].ID, got.Steps[1].ID)
	}
	eq(t, "options default", got.Steps[0].OptionsJSON, "{}")
	evs := e.em.named(core.EventPipelinesChanged)
	if len(evs) != 1 || len(evs[0].(core.PipelinesChanged).Pipelines) != 1 {
		t.Fatalf("events = %+v", evs)
	}

	// Update keeps CreatedAt and the ID.
	got.Name = "Renamed"
	upd, err := e.r.Save(got)
	must(t, err)
	eq(t, "id", upd.Pipeline.ID, got.ID)
	eq(t, "created", upd.Pipeline.CreatedAt, got.CreatedAt)
	eq(t, "count", len(e.r.List()), 1)

	// A new Runner on the same database sees it.
	r2 := e.newRunner()
	list := r2.List()
	if len(list) != 1 || list[0].Pipeline.Name != "Renamed" {
		t.Fatalf("reloaded = %+v", list)
	}
}

func TestSaveProblemsDontBlock(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	e.start()
	ent, err := e.r.Save(pl("Broken", core.PipelineStep{Type: "nosuch", From: FromInput}))
	must(t, err)
	if ent.Check.Ready || len(ent.Check.Steps[0].Problems) == 0 {
		t.Fatalf("check = %+v", ent.Check)
	}
}

func TestSaveValidation(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	e.start()
	e.save(pl("Taken", step("aaaaaaa1", "a", FromInput, fakeOpts{})))
	ok := step("aaaaaaa1", "a", FromInput, fakeOpts{})
	var thirtyOne []core.PipelineStep
	for i := 0; i < 31; i++ {
		thirtyOne = append(thirtyOne, core.PipelineStep{Type: "a", From: FromInput})
	}
	mut := func(f func(*core.PipelineStep)) core.PipelineStep { s := ok; f(&s); return s }
	cases := []struct {
		name string
		p    core.Pipeline
	}{
		{"empty name", pl(" ", ok)},
		{"long name", pl(strings.Repeat("x", 81), ok)},
		{"duplicate name ignoring case", pl("tAKEN", ok)},
		{"long description", func() core.Pipeline { p := pl("D", ok); p.Description = strings.Repeat("d", 301); return p }()},
		{"no steps", pl("Z")},
		{"31 steps", pl("Many", thirtyOne...)},
		{"bad step id", pl("B", mut(func(s *core.PipelineStep) { s.ID = "ABC" }))},
		{"reserved id input", pl("B", mut(func(s *core.PipelineStep) { s.ID = "input" }))},
		{"duplicate ids", pl("B", ok, ok)},
		{"no type", pl("B", mut(func(s *core.PipelineStep) { s.Type = "" }))},
		{"long label", pl("B", mut(func(s *core.PipelineStep) { s.Label = strings.Repeat("l", 61) }))},
		{"long note", pl("B", mut(func(s *core.PipelineStep) { s.Note = strings.Repeat("n", 201) }))},
		{"invalid json", pl("B", mut(func(s *core.PipelineStep) { s.OptionsJSON = "{nope" }))},
		{"from nothing", pl("B", mut(func(s *core.PipelineStep) { s.From = "" }))},
		{"from itself", pl("B", mut(func(s *core.PipelineStep) { s.From = "aaaaaaa1" }))},
		{"from a later step", pl("B", mut(func(s *core.PipelineStep) { s.From = "bbbbbbb2" }), step("bbbbbbb2", "a", FromInput, fakeOpts{}))},
		{"options over 1 MiB", pl("B", mut(func(s *core.PipelineStep) { s.OptionsJSON = `{"x":"` + strings.Repeat("y", MaxOptionsBytes) + `"}` }))},
		{"unknown id on update", func() core.Pipeline { p := pl("Ghost", ok); p.ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"; return p }()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := e.r.Save(c.p)
			if err == nil {
				t.Fatal("saved")
			}
			if core.AsAppError(err).Code != core.CodeValidation && core.AsAppError(err).Code != core.CodeNotFound {
				t.Fatalf("error = %v", err)
			}
		})
	}
	eq(t, "nothing else saved", len(e.r.List()), 1)
}

func TestPipelineLimit(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	r := e.newRunner()
	e.r = r // Save and List work before Start
	for i := 0; i < MaxPipelines; i++ {
		_, err := r.Save(pl(fmt.Sprintf("P%d", i), step("aaaaaaa1", "a", FromInput, fakeOpts{})))
		must(t, err)
	}
	if _, err := r.Save(pl("One too many", step("aaaaaaa1", "a", FromInput, fakeOpts{}))); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("101st pipeline: %v", err)
	}
}

func TestDuplicateAndDelete(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	e.start()
	p := pl("Base", step("aaaaaaa1", "a", FromInput, fakeOpts{}))
	p.Watch = core.WatchConfig{Enabled: true, Folder: t.TempDir()}
	p = e.save(p)
	d1, err := e.r.Duplicate(p.ID)
	must(t, err)
	d2, err := e.r.Duplicate(p.ID)
	must(t, err)
	eq(t, "first copy", d1.Pipeline.Name, "Base copy")
	eq(t, "second copy", d2.Pipeline.Name, "Base copy 2")
	eq(t, "copy doesn't watch", d1.Pipeline.Watch.Enabled, false)
	if d1.Pipeline.ID == p.ID {
		t.Fatal("same id")
	}
	must(t, e.r.Delete(d1.Pipeline.ID))
	if _, err := e.r.Get(d1.Pipeline.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("get deleted: %v", err)
	}
	if err := e.r.Delete(d1.Pipeline.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
	if _, err := e.r.Duplicate("nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("duplicate unknown: %v", err)
	}
	eq(t, "left", len(e.r.List()), 2)
	last := e.em.named(core.EventPipelinesChanged)
	eq(t, "last event lists the rest", len(last[len(last)-1].(core.PipelinesChanged).Pipelines), 2)
}

func TestEntryLastRun(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true})
	e.start()
	p := e.save(pl("Last", step("aaaaaaa1", "a", FromInput, fakeOpts{})))
	if e.r.List()[0].LastRun != nil {
		t.Fatal("last run before any run")
	}
	run := e.startRun(p, e.files("x.txt")...)
	e.waitStatus(run.ID, core.RunDone)
	until(t, "last run done", func() bool {
		lr := e.r.List()[0].LastRun
		return lr != nil && lr.ID == run.ID && lr.Status == core.RunDone
	})
	run2 := e.startRun(p, e.files("y.txt")...)
	e.waitStatus(run2.ID, core.RunDone)
	until(t, "newest run", func() bool { return e.r.List()[0].LastRun.ID == run2.ID })
	// The newest run is still the last one after a restart.
	r2 := e.restart()
	eq(t, "after restart", r2.List()[0].LastRun.ID, run2.ID)
}

func TestPreflightRefusals(t *testing.T) {
	e := newEnv(t, 4,
		&fakeStep{id: "a", split: true},
		&fakeStep{id: "needy", split: true, requires: []string{"ffmpeg", "deno"}},
		&fakeStep{id: "wav", split: true, accepts: []string{".wav"}})
	e.start()
	good := e.save(pl("Good", step("aaaaaaa1", "a", FromInput, fakeOpts{})))
	bad := e.save(pl("Bad", step("aaaaaaa1", "nosuch", FromInput, fakeOpts{})))
	secret := e.save(pl("Secret", step("aaaaaaa1", "a", FromInput, fakeOpts{Secret: true})))
	needy := e.save(pl("Needy", step("aaaaaaa1", "needy", FromInput, fakeOpts{})))
	wav := e.save(pl("Wav", step("aaaaaaa1", "wav", FromInput, fakeOpts{})))
	e.tools = func(id string) (string, error) {
		if id == "ffmpeg" || id == "deno" {
			return "", fmt.Errorf("missing")
		}
		return "/bin/" + id, nil
	}
	in := e.files("x.txt")
	var many []string
	for i := 0; i < MaxItems+1; i++ {
		many = append(many, fmt.Sprintf("f%d.txt", i))
	}
	cases := []struct {
		name   string
		req    core.RunRequest
		code   core.ErrorCode
		msg    string // substring
		hint   string
		absent bool
	}{
		{"unknown pipeline", core.RunRequest{PipelineID: "nope", Inputs: in}, core.CodeNotFound, "Pipeline not found", "", false},
		{"no inputs", core.RunRequest{PipelineID: good.ID}, core.CodeValidation, "Add at least one file", "", false},
		{"blank inputs", core.RunRequest{PipelineID: good.ID, Inputs: []string{"  ", ""}}, core.CodeValidation, "Add at least one file", "", false},
		{"too many", core.RunRequest{PipelineID: good.ID, Inputs: many}, core.CodeValidation, "At most 200 files per run", "", false},
		{"not ready", core.RunRequest{PipelineID: bad.ID, Inputs: in}, core.CodeValidation, "Step 1: This step's tool isn't available", "Fix the problems in the pipeline first", false},
		{"missing tools", core.RunRequest{PipelineID: needy.ID, Inputs: in}, core.CodeDependencyMissing, "Needs ffmpeg, deno", "Install them in Settings → Tool packs", false},
		{"missing secret", core.RunRequest{PipelineID: secret.ID, Inputs: in}, core.CodeValidation, "Needs Step 1 · Password", "", false},
		{"nothing accepted", core.RunRequest{PipelineID: wav.ID, Inputs: in}, core.CodeValidation, "This pipeline can't use these files", "Drop files of a kind its first steps read", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := e.r.StartRun(c.req, "manual")
			ae := core.AsAppError(err)
			if err == nil || ae.Code != c.code || !strings.Contains(ae.Message, c.msg) || ae.Hint != c.hint {
				t.Fatalf("error = %+v", ae)
			}
		})
	}
	runs, _ := e.r.Runs(core.RunFilter{})
	eq(t, "no run was created", len(runs), 0)
}

func TestPreflightLeavesOutUnusableInputsAndKeepsSecretsInMemory(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "a", split: true}, &fakeStep{id: "wavonly", split: true, accepts: []string{".wav"}})
	e.start()
	p := e.save(pl("Left", step("aaaaaaa1", "a", FromInput, fakeOpts{Secret: true, Template: "{item}"})))
	ins := e.files("x.txt", "y.txt")
	ins = append(ins, e.files("doc.pdf", "pic.png")...)
	ins = append(ins, ins[0]) // duplicates are dropped
	run, err := e.r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: ins, Secrets: map[string]string{"aaaaaaa1.pw": "hunter2-secret"}}, "")
	must(t, err)
	eq(t, "accepted", len(run.Items), 2)
	eq(t, "trigger defaults to manual", run.Trigger, "manual")
	if !strings.Contains(run.Error, "2 files left out") || !strings.Contains(run.Error, "doc.pdf") {
		t.Fatalf("note = %q", run.Error)
	}
	e.waitStatus(run.ID, core.RunDone)
	// The secret reached PrepareStep (the fake fails without it) but is never stored.
	state, err := e.db.GetRun(context.Background(), run.ID)
	must(t, err)
	if strings.Contains(state, "hunter2-secret") {
		t.Fatal("secret persisted in the run")
	}
	jobs, _ := e.jobs.List(context.Background(), core.JobFilter{PipelineRunID: run.ID})
	for _, j := range jobs {
		if strings.Contains(j.OptionsJSON, "hunter2-secret") {
			t.Fatal("secret in job options")
		}
	}
}
