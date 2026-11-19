package mediaindex_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core"
	mi "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
	"toolbox/core/store"
)

// The toy model: 6 dimensions. Axes: 0 apple, 1 dog, 2 documents/screens
// (the text gate), 3 "other things" (no label), 4 pear, 5 words nothing looks like.
const toyDim = 6

const toyVocab = `# test vocabulary
food	food	food	a photo of food
fruit	food	fruit	a photo of fruit	food
apple	food	apple	a photo of an apple|an apple	fruit
dog	animals	dog	a photo of a dog|{}
pear	food	pear	a photo of a pear	fruit
`

func axis(i int) []float32 {
	v := make([]float32, toyDim)
	v[i] = 1
	return v
}

// toyAxis maps a text to its axis the way a model would.
func toyAxis(text string) int {
	l := strings.ToLower(text)
	switch {
	case strings.Contains(l, "apple"):
		return 0
	case strings.Contains(l, "dog"):
		return 1
	case strings.Contains(l, "pear"):
		return 4
	}
	for _, g := range mi.GatePrompts {
		if l == g {
			return 2
		}
	}
	return 5 // fruit, food and anything else: no picture looks like it
}

type fakeCaller struct {
	mu    sync.Mutex
	calls int
	texts []string
	err   error
	gate  chan struct{} // when set, calls wait for it to be closed
}

func (c *fakeCaller) Call(ctx context.Context, method string, params any, _ func(sidecar.Event)) (json.RawMessage, error) {
	if c.gate != nil {
		select {
		case <-c.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.err != nil {
		return nil, c.err
	}
	p := params.(map[string]any)
	texts := p["texts"].([]string)
	c.texts = append(c.texts, texts...)
	out := struct {
		Dim     int      `json:"dim"`
		Vectors []string `json:"vectors"`
	}{Dim: toyDim}
	for _, t := range texts {
		out.Vectors = append(out.Vectors, base64.StdEncoding.EncodeToString(mi.EncodeVec(axis(toyAxis(t)))))
	}
	raw, _ := json.Marshal(out)
	return raw, nil
}

func (c *fakeCaller) callCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

type fakeJobs struct {
	mu        sync.Mutex
	jobs      []core.Job
	n         int
	cancelled []string
	submitErr error
}

func (j *fakeJobs) Submit(_ context.Context, moduleID string, inputs []string, opts string) ([]core.Job, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.submitErr != nil {
		return nil, j.submitErr
	}
	j.n++
	job := core.Job{ID: "j" + string(rune('0'+j.n/10)) + string(rune('0'+j.n%10)), ModuleID: moduleID, Inputs: inputs, OptionsJSON: opts,
		Status: core.JobQueued, Quiet: true, CreatedAt: time.Now().UnixMilli()}
	j.jobs = append(j.jobs, job)
	return []core.Job{job}, nil
}

func (j *fakeJobs) Observe(func(core.Job)) func() { return func() {} }

func (j *fakeJobs) List(_ context.Context, f core.JobFilter) ([]core.Job, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	var out []core.Job
	for _, job := range j.jobs {
		for _, s := range f.Statuses {
			if job.Status == s {
				out = append(out, job)
			}
		}
	}
	return out, nil
}

func (j *fakeJobs) Cancel(id string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cancelled = append(j.cancelled, id)
	return nil
}

// set changes a job's status and returns the snapshot for TestJob.
func (j *fakeJobs) set(id string, st core.JobStatus, mut func(*core.Job)) core.Job {
	j.mu.Lock()
	defer j.mu.Unlock()
	for i := range j.jobs {
		if j.jobs[i].ID == id {
			j.jobs[i].Status = st
			if mut != nil {
				mut(&j.jobs[i])
			}
			return j.jobs[i]
		}
	}
	panic("no job " + id)
}

// addUser adds a user (non-quiet) job.
func (j *fakeJobs) addUser(id string, st core.JobStatus, createdAt int64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.jobs = append(j.jobs, core.Job{ID: id, ModuleID: "converter", Status: st, CreatedAt: createdAt})
}

func (j *fakeJobs) last(module string) (core.Job, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for i := len(j.jobs) - 1; i >= 0; i-- {
		if j.jobs[i].ModuleID == module {
			return j.jobs[i], true
		}
	}
	return core.Job{}, false
}

func (j *fakeJobs) count(module string) int {
	j.mu.Lock()
	defer j.mu.Unlock()
	n := 0
	for _, job := range j.jobs {
		if job.ModuleID == module {
			n++
		}
	}
	return n
}

type recEmitter struct {
	mu     sync.Mutex
	events []string
	ready  []core.SearchReady
	idx    []core.SearchIndexed
}

func (r *recEmitter) Emit(name string, data any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, name)
	switch d := data.(type) {
	case core.SearchReady:
		r.ready = append(r.ready, d)
	case core.SearchIndexed:
		r.idx = append(r.idx, d)
	}
}

func (r *recEmitter) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.events {
		if e == name {
			n++
		}
	}
	return n
}

type fx struct {
	t      *testing.T
	ix     *mi.Index
	db     *store.DB
	lib    string
	jobs   *fakeJobs
	caller *fakeCaller
	em     *recEmitter

	installed   atomic.Bool
	speechReady atomic.Bool
	model       atomic.Value // string id
	mu          sync.Mutex
	outs        map[string]*core.Output
	projects    []mi.Project
	vocab       string
}

func newFx(t *testing.T) *fx {
	t.Helper()
	f := &fx{t: t, jobs: &fakeJobs{}, caller: &fakeCaller{}, em: &recEmitter{}, outs: map[string]*core.Output{}, vocab: toyVocab}
	db, err := store.Open(filepath.Join(t.TempDir(), "db", "toolbox.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	f.db = db
	f.lib = filepath.Join(t.TempDir(), "Toolbox")
	if err := os.MkdirAll(f.lib, 0o755); err != nil {
		t.Fatal(err)
	}
	f.installed.Store(true)
	f.speechReady.Store(true)
	f.model.Store("toy-1")
	f.ix = f.newIndex(f.vocab)
	f.ix.TestLoad(context.Background())
	return f
}

func (f *fx) newIndex(vocab string) *mi.Index {
	ix := mi.New(mi.Config{
		Store: f.db.MediaIndex(), Jobs: f.jobs, Caller: f.caller, Emitter: f.em,
		LibraryDir: func() string { return f.lib },
		Model: func() mi.Model {
			return mi.Model{ID: f.model.Load().(string), Dim: toyDim, Scale: 20, Bias: -10, Dir: "/models/toy"}
		},
		Vocabulary:  []byte(vocab),
		Installed:   f.installed.Load,
		SpeechReady: f.speechReady.Load,
		Projects: func(context.Context) ([]mi.Project, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return append([]mi.Project(nil), f.projects...), nil
		},
		Outputs: func(_ context.Context, paths []string) (map[string]*core.Output, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			m := map[string]*core.Output{}
			for _, p := range paths {
				if o, ok := f.outs[p]; ok {
					m[p] = o
				}
			}
			return m, nil
		},
	})
	f.t.Cleanup(ix.Close)
	return ix
}

func (f *fx) path(rel string) string { return filepath.Join(f.lib, filepath.FromSlash(rel)) }

// write creates a file under the library.
func (f *fx) write(rel string, size int) string {
	f.t.Helper()
	p := f.path(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func (f *fx) setMod(path string, t time.Time) {
	f.t.Helper()
	if err := os.Chtimes(path, t, t); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fx) reconcile() { f.ix.TestReconcile(context.Background()) }

// res builds a successful ItemResult from the file as it is on disk.
func (f *fx) res(path, kind string, vecs ...mi.VectorAt) mi.ItemResult {
	f.t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		f.t.Fatal(err)
	}
	return mi.ItemResult{Path: path, Kind: kind, Size: fi.Size(), ModMs: fi.ModTime().UnixMilli(), Vectors: vecs}
}

func at(pos int64, axisIdx int) mi.VectorAt { return mi.VectorAt{Pos: pos, Vec: axis(axisIdx)} }

// store runs StoreBatch (the labels are loaded first, as the scheduler does).
func (f *fx) store(rs ...mi.ItemResult) {
	f.t.Helper()
	if err := f.ix.TestLabels(context.Background()); err != nil {
		f.t.Fatal(err)
	}
	if err := f.ix.StoreBatch(context.Background(), rs); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fx) query(q core.SearchQuery) core.SearchPage {
	f.t.Helper()
	p, err := f.ix.Query(context.Background(), q)
	if err != nil {
		f.t.Fatal(err)
	}
	return p
}

func paths(hits []core.SearchHit) []string {
	out := make([]string, len(hits))
	for i, h := range hits {
		out[i] = filepath.Base(h.Path)
	}
	return out
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
