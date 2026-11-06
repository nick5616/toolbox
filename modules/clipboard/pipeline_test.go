package clipboard

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

// seen collects what OnRecorded passes on.
type seen struct {
	mu    sync.Mutex
	items []core.ClipItem
}

func (s *seen) add(it core.ClipItem) {
	s.mu.Lock()
	s.items = append(s.items, it)
	s.mu.Unlock()
}

func (s *seen) texts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, it := range s.items {
		out = append(out, it.Text)
	}
	return out
}

func (s *seen) count() int { return len(s.texts()) }

// ---- the trigger's feed: privacy ----

func TestOnRecordedSeesRecordedCopiesOnly(t *testing.T) {
	e := newEnv(t, enabled)
	var s seen
	e.h.OnRecorded(s.add)
	e.start()
	e.waitRecording()

	e.recordText("hello there")
	if got := s.texts(); len(got) != 1 || got[0] != "hello there" {
		t.Fatalf("seen = %v", got)
	}
	if s.items[0].ID == "" || s.items[0].Kind != core.ClipText {
		t.Errorf("item = %+v", s.items[0])
	}

	// Sensitive copies are never recorded, so they never reach the trigger.
	e.src.send(t, change{Kind: core.ClipText, Bytes: []byte("hunter2"), Sensitive: true})
	// Neither do oversized or blank ones.
	e.src.send(t, change{Kind: core.ClipText, Bytes: []byte(" \n ")})
	e.recordText("after")
	if got := s.texts(); len(got) != 2 || got[1] != "after" {
		t.Fatalf("seen = %v (a skipped copy reached the trigger)", got)
	}
	for _, txt := range s.texts() {
		if strings.Contains(txt, "hunter2") {
			t.Fatal("a sensitive copy reached the trigger")
		}
	}

	// A re-copy of the same text is a copy too.
	e.clk.advance(time.Minute)
	e.recordText("after")
	if s.count() != 3 {
		t.Errorf("seen = %v", s.texts())
	}
}

func TestOnRecordedSilentWhileOffOrPaused(t *testing.T) {
	// Recording off (the default): nothing is watched, nothing is passed on.
	off := newEnv(t, core.DefaultClipboardSettings())
	var s seen
	off.h.OnRecorded(s.add)
	off.start()
	time.Sleep(30 * time.Millisecond)
	if off.src.watchCount() != 0 || s.count() != 0 {
		t.Fatal("the feed is live while recording is off")
	}

	// Paused: the watcher stops, so the feed stops.
	on := newEnv(t, enabled)
	var s2 seen
	on.h.OnRecorded(s2.add)
	on.start()
	on.waitRecording()
	on.recordText("one")
	if err := on.h.Pause(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "paused", func() bool { return !on.h.State().Recording })
	// Even a copy that races in after the pause isn't passed on.
	on.h.notifyRecorded(core.ClipItem{Kind: core.ClipText, Text: "late"})
	if got := s2.texts(); len(got) != 1 || got[0] != "one" {
		t.Fatalf("seen = %v", got)
	}
}

func TestCopyTextQuietIsRecordedButStartsNothing(t *testing.T) {
	e := newEnv(t, enabled)
	var s seen
	e.h.OnRecorded(s.add)
	e.start()
	e.waitRecording()

	if err := e.h.CopyTextQuiet(context.Background(), "from a pipeline\n"); err != nil {
		t.Fatal(err)
	}
	if len(e.src.writes) != 1 || string(e.src.writes[0].data) != "from a pipeline\n" {
		t.Fatalf("writes = %+v", e.src.writes)
	}
	// The OS reports our own write: it is in the history but not passed on.
	e.recordText("from a pipeline")
	if items := e.list(); len(items) != 1 {
		t.Fatalf("history = %+v", items)
	}
	if s.count() != 0 {
		t.Fatalf("a pipeline's own copy reached the trigger: %v", s.texts())
	}
	// One-shot: the user copying the same words later does trigger.
	e.clk.advance(time.Minute)
	e.recordText("from a pipeline")
	if s.count() != 1 {
		t.Fatalf("seen = %v", s.texts())
	}
	// A write that fails leaves no marker behind.
	e.src.writeErr = os.ErrPermission
	if err := e.h.CopyTextQuiet(context.Background(), "nope"); err == nil {
		t.Fatal("write error swallowed")
	}
	e.src.writeErr = nil
	e.clk.advance(time.Minute)
	e.recordText("nope")
	if s.count() != 2 {
		t.Fatalf("seen = %v", s.texts())
	}
}

// ---- the Copy to clipboard step ----

func TestCopyStepDescribe(t *testing.T) {
	m := Module{}
	info, err := m.DescribeStep(json.RawMessage(`{}`))
	if err != nil || info.NoFiles || info.Summary != "Copy the first text file" {
		t.Fatalf("default = %+v, %v", info, err)
	}
	if len(info.Accepts.Extensions) != 2 {
		t.Errorf("accepts = %+v", info.Accepts)
	}
	info, err = m.DescribeStep(json.RawMessage(`{"text":"{reply}"}`))
	if err != nil || !info.NoFiles || len(info.Templates) != 1 || info.Templates[0] != "/text" {
		t.Fatalf("with text = %+v, %v", info, err)
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"nope":1}`)); err == nil {
		t.Error("unknown option accepted")
	}
	st := m.StepType()
	if st.ModuleID != CopyModuleID || st.Name != "Copy to clipboard" {
		t.Errorf("step type = %+v", st)
	}
}

func prep(t *testing.T, opts string, vars map[string]string, files ...core.RunFile) ([]core.StepJob, error) {
	t.Helper()
	return Module{}.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(opts), Item: core.StepItem{Files: files, Vars: vars},
	})
}

func TestCopyStepPrepare(t *testing.T) {
	dir := t.TempDir()
	notes := filepath.Join(dir, "notes.md")
	other := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(notes, []byte("the notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte("second"), 0o644); err != nil {
		t.Fatal(err)
	}
	img := filepath.Join(dir, "p.png")

	// No text option: the first .txt/.md file.
	jobs, err := prep(t, `{}`, nil, core.RunFile{Path: img}, core.RunFile{Path: notes}, core.RunFile{Path: other})
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v, %v", jobs, err)
	}
	o := jobs[0].Options.(CopyOptions)
	if o.Text != "the notes" || len(jobs[0].Inputs) != 1 || jobs[0].Inputs[0] != notes || len(o.Carry) != 3 {
		t.Errorf("job = %+v %+v", jobs[0].Inputs, o)
	}

	// A template over a step variable needs no file.
	jobs, err = prep(t, `{"text":"Total: {total} for {item}"}`, map[string]string{"total": "42", "item": "Trip"})
	if err != nil || jobs[0].Options.(CopyOptions).Text != "Total: 42 for Trip" || len(jobs[0].Inputs) != 0 {
		t.Fatalf("template = %+v, %v", jobs, err)
	}

	for _, tc := range []struct {
		name, opts string
		files      []core.RunFile
		want       string
	}{
		{"no text file", `{}`, []core.RunFile{{Path: img}}, "no text"},
		{"empty variable", `{"text":"{missing}"}`, nil, "no text"},
		{"empty file", `{}`, []core.RunFile{{Path: writeEmpty(t, dir)}}, "no text"},
		{"unreadable", `{}`, []core.RunFile{{Path: filepath.Join(dir, "gone.txt")}}, "Can't read"},
	} {
		if _, err := prep(t, tc.opts, nil, tc.files...); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want %q", tc.name, err, tc.want)
		}
	}
	long := filepath.Join(dir, "long.txt")
	if err := os.WriteFile(long, []byte(strings.Repeat("x", core.MaxVarBytes+10)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := prep(t, `{}`, nil, core.RunFile{Path: long}); err == nil || !strings.Contains(err.Error(), "too long") {
		t.Errorf("long text: %v", err)
	}
}

func writeEmpty(t *testing.T, dir string) string {
	t.Helper()
	p := filepath.Join(dir, "empty.txt")
	if err := os.WriteFile(p, []byte("  \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCopyModuleRunWritesOnceAndCarriesFiles(t *testing.T) {
	e := newEnv(t, enabled)
	var s seen
	e.h.OnRecorded(s.add)
	e.start()
	e.waitRecording()
	mod := &CopyModule{h: e.h}

	carried := []core.RunFile{{Path: "/x/a.txt", Name: "a.txt", Role: "text"}}
	raw, _ := json.Marshal(CopyOptions{Text: "copied by a step", Carry: carried})
	if err := mod.Validate([]string{}, raw); err != nil {
		t.Fatal(err)
	}
	var result json.RawMessage
	jc := core.NewJobContext(core.JobContext{Options: raw}, core.JobHooks{Result: func(r json.RawMessage) { result = r }})
	if err := mod.Run(context.Background(), jc); err != nil {
		t.Fatal(err)
	}
	if len(e.src.writes) != 1 || string(e.src.writes[0].data) != "copied by a step" {
		t.Fatalf("writes = %+v", e.src.writes)
	}
	out, err := Module{}.StepOutputs(core.Job{ResultJSON: string(result)})
	if err != nil || len(out.Files) != 1 || out.Files[0].Path != "/x/a.txt" || out.Files[0].Role != "text" {
		t.Fatalf("outputs = %+v, %v", out, err)
	}
	// The echo of the step's own write doesn't start a pipeline.
	e.recordText("copied by a step")
	if s.count() != 0 {
		t.Fatalf("seen = %v", s.texts())
	}

	if err := mod.Validate(nil, []byte(`{"text":"  "}`)); err == nil {
		t.Error("blank text validated")
	}
	if err := (&CopyModule{}).Run(context.Background(), jc); err == nil {
		t.Error("a step without a history should fail")
	}
}
