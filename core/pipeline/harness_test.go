package pipeline

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/store"
)

// recEm records emitted events.
type recEm struct {
	mu  sync.Mutex
	evs []struct {
		name string
		data any
	}
}

func (e *recEm) Emit(name string, data any) {
	e.mu.Lock()
	e.evs = append(e.evs, struct {
		name string
		data any
	}{name, data})
	e.mu.Unlock()
}

func (e *recEm) named(name string) []any {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []any
	for _, ev := range e.evs {
		if ev.name == name {
			out = append(out, ev.data)
		}
	}
	return out
}

type env struct {
	t     *testing.T
	db    *store.DB
	jobs  *core.Jobs
	reg   *core.Registry
	em    *recEm
	lib   string
	in    string // run inputs live here (outside the library)
	r     *Runner
	conc  int
	dbDir string
	tools func(string) (string, error)
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// newEnv builds a Jobs manager over a real SQLite store with the given
// modules. The Runner is built (and started) with start().
func newEnv(t *testing.T, conc int, mods ...core.Module) *env {
	t.Helper()
	e := &env{t: t, em: &recEm{}, reg: core.NewRegistry(), lib: t.TempDir(), in: t.TempDir(), conc: conc,
		dbDir: t.TempDir(), tools: func(string) (string, error) { return "/bin/x", nil }}
	db, err := store.Open(filepath.Join(e.dbDir, "t.db"))
	must(t, err)
	e.db = db
	t.Cleanup(func() { db.Close() })
	for _, m := range mods {
		must(t, e.reg.Register(m))
	}
	e.jobs = core.NewJobs(db, db, e.reg, e.em, func(id string) (string, error) { return e.tools(id) },
		func() core.Settings { return core.Settings{LibraryDir: e.lib, Concurrency: e.conc} }, filepath.Join(e.dbDir, "tmp"))
	must(t, e.jobs.Start(context.Background()))
	t.Cleanup(func() { _ = e.jobs.Shutdown(5 * time.Second) })
	return e
}

func (e *env) newRunner() *Runner {
	r := New(Config{
		Store: e.db, Outputs: e.db, Jobs: e.jobs, Reg: e.reg, Em: e.em,
		Tools:    func(id string) (string, error) { return e.tools(id) },
		Settings: func() core.Settings { return core.Settings{LibraryDir: e.lib, Concurrency: e.conc} },
	})
	r.waitRetry = 30 * time.Millisecond
	r.persistEvery = 20 * time.Millisecond
	r.emitEvery = 20 * time.Millisecond
	r.watchEvery = time.Hour
	r.stableAge = 0
	must(e.t, r.RegisterBuiltin(core.StepType{ID: CheckType, Name: "Check", Auto: true, Accepts: core.Accepts{Any: true, Extensions: []string{}}, DefaultsJSON: "{}"}, nil))
	return r
}

// start builds and starts the Runner.
func (e *env) start() *Runner {
	e.t.Helper()
	r := e.newRunner()
	must(e.t, r.Start(context.Background()))
	e.t.Cleanup(r.Stop)
	e.r = r
	return r
}

// files makes n .txt inputs outside the library.
func (e *env) files(names ...string) []string {
	e.t.Helper()
	var out []string
	for _, n := range names {
		p := filepath.Join(e.in, n)
		must(e.t, os.WriteFile(p, []byte("hello "+n), 0o644))
		out = append(out, p)
	}
	return out
}

func opts(o fakeOpts) string {
	b, _ := json.Marshal(o)
	return string(b)
}

// step builds a step. id must be 8 chars of [a-z0-9].
func step(id, typ, from string, o fakeOpts) core.PipelineStep {
	return core.PipelineStep{ID: id, Type: typ, From: from, OptionsJSON: opts(o), Keep: true}
}

func pl(name string, steps ...core.PipelineStep) core.Pipeline {
	return core.Pipeline{Name: name, Steps: steps}
}

func (e *env) save(p core.Pipeline) core.Pipeline {
	e.t.Helper()
	ent, err := e.r.Save(p)
	must(e.t, err)
	return ent.Pipeline
}

func (e *env) startRun(p core.Pipeline, inputs ...string) core.PipelineRun {
	e.t.Helper()
	run, err := e.r.StartRun(core.RunRequest{PipelineID: p.ID, Inputs: inputs}, "manual")
	must(e.t, err)
	return run
}

// waitRun polls until pred holds.
func (e *env) waitRun(id string, what string, pred func(core.PipelineRun) bool) core.PipelineRun {
	e.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last core.PipelineRun
	for time.Now().Before(deadline) {
		run, err := e.r.Run(id)
		if err == nil {
			last = run
			if pred(run) {
				return run
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatalf("timed out waiting for %s; status %s, cells:\n%s", what, last.Status, dump(last))
	return last
}

func (e *env) waitStatus(id string, st core.RunStatus) core.PipelineRun {
	e.t.Helper()
	return e.waitRun(id, "status "+string(st), func(r core.PipelineRun) bool { return r.Status == st })
}

func dump(r core.PipelineRun) string {
	var sb strings.Builder
	for _, it := range r.Items {
		sb.WriteString(it.Label + ":")
		for _, c := range it.Cells {
			sb.WriteString(" " + string(c.Status))
			if c.Error != "" {
				sb.WriteString("(" + c.Error + ")")
			}
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

func cellOf(r core.PipelineRun, item, step int) core.RunCell { return r.Items[item].Cells[step] }

func statuses(r core.PipelineRun, item int) []core.CellStatus {
	var out []core.CellStatus
	for _, c := range r.Items[item].Cells {
		out = append(out, c.Status)
	}
	return out
}

func eq[T comparable](t *testing.T, what string, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
}

func fileNames(fs []core.RunFile) []string {
	out := []string{}
	for _, f := range fs {
		out = append(out, f.Name)
	}
	return out
}

// until polls cond with a deadline.
func until(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// tableStep is a together, no-files Chainable that writes one CSV row per
// merged item from the item's variables.
type tableStep struct{}

type tableOpts struct {
	Rows [][]string `json:"rows"`
	Cols []string   `json:"cols"`
}

func (tableStep) Descriptor() core.Descriptor {
	return core.Descriptor{ID: "table", Name: "Table", Icon: "box", Category: core.CategoryUtility, Status: core.StatusReady,
		Accepts: core.Accepts{Extensions: []string{".txt"}}, OutputSubdir: "table"}
}
func (tableStep) Validate([]string, json.RawMessage) error { return nil }
func (tableStep) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[tableOpts](job)
	if err != nil {
		return err
	}
	p := core.UniquePath(job.OutputDir, "table", ".csv")
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	w := csv.NewWriter(f)
	_ = w.WriteAll(o.Rows)
	f.Close()
	_, err = job.Output(p)
	return err
}
func (tableStep) StepDefaults() any { return tableOpts{} }
func (tableStep) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	return core.StepInfo{Accepts: core.Accepts{Extensions: []string{".txt"}}, Together: true, NoFiles: true,
		Templates: []string{"/cols/*"}, Produces: []core.StepProduct{{Kind: core.KindDocument, Exts: []string{".csv"}}}}, nil
}
func (tableStep) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := core.DecodeOptionsJSON[tableOpts](req.Options)
	if err != nil {
		return nil, err
	}
	for _, it := range req.Items {
		var row []string
		for _, c := range o.Cols {
			v, _ := core.ExpandVars(c, it.Vars)
			row = append(row, v)
		}
		o.Rows = append(o.Rows, row)
	}
	return []core.StepJob{{Options: o}}, nil
}
func (tableStep) StepOutputs(job core.Job) (core.StepResult, error) {
	var res core.StepResult
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID, Role: "table"})
	}
	return res, nil
}
