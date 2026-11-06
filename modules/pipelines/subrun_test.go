package pipelines

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/pipeline"
	"toolbox/core/store"
)

// echoMod is a tiny Chainable tool: it copies each .txt input to
// "<name> (echo).txt" in its output folder; it can fail or hold.
type echoMod struct{ hold chan struct{} }

type echoOpts struct {
	Fail bool `json:"fail"`
	Hold bool `json:"hold"`
}

func (m *echoMod) Descriptor() core.Descriptor {
	return core.Descriptor{ID: "echo", Name: "Echo", Icon: "box", Category: core.CategoryUtility, Status: core.StatusReady,
		Accepts: core.Accepts{Extensions: []string{".txt"}}, OutputSubdir: "echo", SplitInputs: true}
}

func (m *echoMod) Validate(_ []string, o json.RawMessage) error {
	_, err := core.DecodeOptionsJSON[echoOpts](o)
	return err
}

func (m *echoMod) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[echoOpts](job)
	if err != nil {
		return err
	}
	if o.Hold {
		select {
		case <-m.hold:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if o.Fail {
		return core.ValidationError("echo failed", nil)
	}
	for _, in := range job.Inputs {
		p := core.UniquePath(job.OutputDir, core.StemName(in)+" (echo)", ".txt")
		if err := os.WriteFile(p, []byte("echo"), 0o644); err != nil {
			return err
		}
		if _, err := job.Output(p); err != nil {
			return err
		}
	}
	return nil
}

func (m *echoMod) StepDefaults() any { return echoOpts{} }
func (m *echoMod) DescribeStep(o json.RawMessage) (core.StepInfo, error) {
	if _, err := core.DecodeOptionsJSON[echoOpts](o); err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{Accepts: m.Descriptor().Accepts, Produces: []core.StepProduct{{Kind: core.KindDocument, Exts: []string{".txt"}}}}, nil
}
func (m *echoMod) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := core.DecodeOptionsJSON[echoOpts](req.Options)
	if err != nil {
		return nil, err
	}
	in := []string{}
	for _, f := range req.Item.Files {
		in = append(in, f.Path)
	}
	return []core.StepJob{{Inputs: in, Options: o}}, nil
}
func (m *echoMod) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Vars: map[string]string{}}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID})
	}
	return res, nil
}

type subEnv struct {
	t    *testing.T
	r    *pipeline.Runner
	echo *echoMod
	in   string
}

func newSubEnv(t *testing.T) *subEnv {
	t.Helper()
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	reg := core.NewRegistry()
	echo := &echoMod{hold: make(chan struct{})}
	if err := reg.Register(echo); err != nil {
		t.Fatal(err)
	}
	lib := filepath.Join(dir, "lib")
	settings := func() core.Settings { return core.Settings{LibraryDir: lib, Concurrency: 4} }
	jobs := core.NewJobs(db, db, reg, core.NopEmitter{}, func(string) (string, error) { return "x", nil }, settings, filepath.Join(dir, "tmp"))
	if err := jobs.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = jobs.Shutdown(5 * time.Second) })
	r := pipeline.New(pipeline.Config{Store: db, Outputs: db, Jobs: jobs, Reg: reg, Settings: settings})
	if _, err := Register(reg, Config{Runner: r, Outputs: db, LibraryDir: func() string { return lib }}); err != nil {
		t.Fatal(err)
	}
	// The module's poll interval is internal to the step; shorten it.
	if pm, ok := reg.Get(ModuleID); ok {
		pm.(*Module).subPoll = 10 * time.Millisecond
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Stop)
	in := filepath.Join(dir, "in")
	if err := os.MkdirAll(in, 0o755); err != nil {
		t.Fatal(err)
	}
	return &subEnv{t: t, r: r, echo: echo, in: in}
}

func (e *subEnv) file(name string) string {
	e.t.Helper()
	p := filepath.Join(e.in, name)
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		e.t.Fatal(err)
	}
	return p
}

func (e *subEnv) save(p core.Pipeline) core.Pipeline {
	e.t.Helper()
	ent, err := e.r.Save(p)
	if err != nil {
		e.t.Fatal(err)
	}
	return ent.Pipeline
}

func echoStep(id string, o echoOpts, keep bool) core.PipelineStep {
	b, _ := json.Marshal(o)
	return core.PipelineStep{ID: id, Type: "echo", From: pipeline.FromInput, OptionsJSON: string(b), Keep: keep}
}

func runStep(id, target string) core.PipelineStep {
	b, _ := json.Marshal(RunStep{PipelineID: target})
	return core.PipelineStep{ID: id, Type: TypeRun, From: pipeline.FromInput, OptionsJSON: string(b)}
}

func (e *subEnv) waitRun(id string, pred func(core.PipelineRun) bool) core.PipelineRun {
	e.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last core.PipelineRun
	for time.Now().Before(deadline) {
		if r, err := e.r.Run(id); err == nil {
			last = r
			if pred(r) {
				return r
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatalf("timed out; status %s", last.Status)
	return last
}

func TestRunAnotherPipelineCarriesTheKeptFiles(t *testing.T) {
	e := newSubEnv(t)
	inner := e.save(core.Pipeline{Name: "Inner", Steps: []core.PipelineStep{echoStep("inner001", echoOpts{}, true)}})
	outer := e.save(core.Pipeline{Name: "Outer", Steps: []core.PipelineStep{runStep("outer001", inner.ID)}})
	if check := e.r.Describe(outer); !check.Ready {
		t.Fatalf("outer isn't ready: %v %v", check.Problems, check.Steps[0].Problems)
	}
	run, err := e.r.StartRun(core.RunRequest{PipelineID: outer.ID, Inputs: []string{e.file("a.txt")}}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	done := e.waitRun(run.ID, func(r core.PipelineRun) bool { return r.Status == core.RunDone })
	files := done.Items[0].Cells[0].Files
	if len(files) != 1 || !strings.Contains(files[0].Name, "(echo)") {
		t.Fatalf("outer step files = %+v", files)
	}
	if _, err := os.Stat(files[0].Path); err != nil {
		t.Errorf("the carried file is missing: %v", err)
	}
	runs, err := e.r.Runs(core.RunFilter{PipelineID: inner.ID})
	if err != nil || len(runs) != 1 || runs[0].Trigger != "pipeline" || runs[0].Status != core.RunDone {
		t.Fatalf("sub-runs = %+v, %v", runs, err)
	}
}

func TestRunAnotherPipelineFailureNamesThePipeline(t *testing.T) {
	e := newSubEnv(t)
	inner := e.save(core.Pipeline{Name: "Breaks", Steps: []core.PipelineStep{echoStep("inner001", echoOpts{Fail: true}, true)}})
	outer := e.save(core.Pipeline{Name: "Outer", Steps: []core.PipelineStep{runStep("outer001", inner.ID)}})
	run, err := e.r.StartRun(core.RunRequest{PipelineID: outer.ID, Inputs: []string{e.file("a.txt")}}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	failed := e.waitRun(run.ID, func(r core.PipelineRun) bool { return r.Status == core.RunFailed })
	c := failed.Items[0].Cells[0]
	if c.Status != core.CellFailed || !strings.Contains(c.Error, "Breaks") || !strings.Contains(c.Error, "echo failed") {
		t.Fatalf("cell = %+v", c)
	}
}

func TestCancellingTheOuterRunCancelsTheSubRun(t *testing.T) {
	e := newSubEnv(t)
	inner := e.save(core.Pipeline{Name: "Slow", Steps: []core.PipelineStep{echoStep("inner001", echoOpts{Hold: true}, true)}})
	outer := e.save(core.Pipeline{Name: "Outer", Steps: []core.PipelineStep{runStep("outer001", inner.ID)}})
	run, err := e.r.StartRun(core.RunRequest{PipelineID: outer.ID, Inputs: []string{e.file("a.txt")}}, "manual")
	if err != nil {
		t.Fatal(err)
	}
	var subID string
	deadline := time.Now().Add(10 * time.Second)
	for subID == "" && time.Now().Before(deadline) {
		if runs, _ := e.r.Runs(core.RunFilter{PipelineID: inner.ID}); len(runs) > 0 {
			subID = runs[0].ID
		}
		time.Sleep(5 * time.Millisecond)
	}
	if subID == "" {
		t.Fatal("the sub-run never started")
	}
	if err := e.r.Cancel(run.ID); err != nil {
		t.Fatal(err)
	}
	e.waitRun(subID, func(r core.PipelineRun) bool { return r.Status == core.RunCancelled })
}

func TestRunStepDescribeProblems(t *testing.T) {
	e := newSubEnv(t)
	for _, tc := range []struct {
		name, opts, want string
	}{
		{"nothing chosen", `{}`, "Choose a pipeline"},
		{"deleted pipeline", `{"pipelineId":"gone"}`, "doesn't exist"},
		{"bad options", `{"nope":1}`, "Invalid"},
	} {
		check := e.r.Describe(core.Pipeline{Name: "X", Steps: []core.PipelineStep{{ID: "step0001", Type: TypeRun, From: pipeline.FromInput, OptionsJSON: tc.opts}}})
		if check.Ready || !strings.Contains(strings.Join(check.Steps[0].Problems, "|"), tc.want) {
			t.Errorf("%s: problems = %v", tc.name, check.Steps[0].Problems)
		}
	}
}

func TestKeptFiles(t *testing.T) {
	cell := func(status core.CellStatus, paths ...string) core.RunCell {
		c := core.RunCell{Status: status}
		for _, p := range paths {
			c.Files = append(c.Files, core.RunFile{Path: p, Temporary: true})
		}
		return c
	}
	run := core.PipelineRun{
		Steps: []core.PipelineStep{{ID: "s1", Keep: true}, {ID: "s2"}, {ID: "s3"}},
		Items: []core.RunItem{
			{Cells: []core.RunCell{cell(core.CellDone, "a1"), cell(core.CellDone, "a2"), cell(core.CellDone, "a3")}},
			{Cells: []core.RunCell{cell(core.CellDone, "a1", "b1"), cell(core.CellFailed), cell(core.CellBlocked)}},
		},
	}
	got := keptFiles(run)
	if len(got) != 2 || got[0].Path != "a1" || got[1].Path != "b1" || got[0].Temporary {
		t.Fatalf("keep step files = %+v", got)
	}
	run.Steps[0].Keep = false // nothing kept: the last step's files
	got = keptFiles(run)
	if len(got) != 1 || got[0].Path != "a3" {
		t.Fatalf("last step files = %+v", got)
	}
}

func TestLocalChatStepKeepsItsOldID(t *testing.T) {
	e := newSubEnv(t)
	var chat, legacy bool
	for _, st := range e.r.Catalog() {
		switch st.ID {
		case TypeChat:
			chat = st.Name == "Local Chat" && st.Auto && st.Builtin
		case TypeChatLegacy:
			legacy = true
		}
	}
	if !chat || legacy {
		t.Fatalf("catalogue: chat=%v legacy listed=%v", chat, legacy)
	}
	p := e.save(core.Pipeline{Name: "Old chat", Steps: []core.PipelineStep{{
		ID: "chat0001", Type: TypeChatLegacy, From: pipeline.FromNone, OptionsJSON: `{"prompt":"hi","mode":"write","outputName":"x","format":"md","temperature":0.3,"fields":[]}`,
	}}})
	if p.Steps[0].Type != TypeChat {
		t.Fatalf("saved as %q", p.Steps[0].Type)
	}
}
