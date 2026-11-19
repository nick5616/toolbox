package mediaindex_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"toolbox/core"
	mi "toolbox/core/mediaindex"
)

func (f *fx) items() map[string]mi.Item {
	f.t.Helper()
	all, err := f.db.MediaIndex().AllItems(context.Background())
	if err != nil {
		f.t.Fatal(err)
	}
	m := map[string]mi.Item{}
	for _, it := range all {
		m[filepath.Base(it.Path)] = it
	}
	return m
}

func TestReconcileLifecycle(t *testing.T) {
	f := newFx(t)
	f.write("a.jpg", 10)
	f.write("b.mp4", 10)
	f.write("c.mp3", 10)
	f.write("d.pdf", 10)
	f.write("e.docx", 10)
	f.write("big.jpg", 10)
	f.write(".hidden.jpg", 10)
	f.write("Received/skipme.jpg", 10)
	f.write("notes.zip", 10)
	if err := f.ix.SetSettings(context.Background(), core.SearchSettings{Enabled: true, ReadText: true, Speech: true, SpeechMaxMin: 60, Skip: []string{"Received"}}); err != nil {
		t.Fatal(err)
	}
	f.reconcile()
	got := f.items()
	if len(got) != 6 {
		t.Fatalf("items: %v", got)
	}
	if a := got["a.jpg"]; a.State != "pending" || a.Source != "library" || a.Kind != "image" || a.SpeechState != "none" {
		t.Errorf("a: %+v", a)
	}
	if b := got["b.mp4"]; b.State != "pending" || b.SpeechState != "pending" {
		t.Errorf("video: %+v", b)
	}
	if c := got["c.mp3"]; c.State != "done" || c.SpeechState != "pending" {
		t.Errorf("audio: %+v", c)
	}
	st := f.ix.Status()
	if st.Total != 6 || st.Pending != 5 || st.Done != 1 || st.SpeechPending != 2 {
		t.Errorf("status %+v", st)
	}

	// changed, gone, new
	if err := os.WriteFile(f.path("a.jpg"), make([]byte, 20), 0o644); err != nil {
		t.Fatal(err)
	}
	f.store(f.res(f.path("big.jpg"), "image", at(-1, 0)))
	os.Remove(f.path("d.pdf"))
	f.write("new.png", 5)
	f.reconcile()
	f.ix.TestTick(context.Background()) // no-op tick must not disturb
	got = f.items()
	if _, ok := got["d.pdf"]; ok {
		t.Error("gone file kept")
	}
	if got["new.png"].State != "pending" || got["a.jpg"].Size != 20 {
		t.Errorf("new/changed: %+v %+v", got["new.png"], got["a.jpg"])
	}
	if got["big.jpg"].State != "done" {
		t.Errorf("an unchanged done file must stay done: %+v", got["big.jpg"])
	}
	// the library folder disappears (a drive that isn't there): nothing is deleted
	moved := f.lib + "-away"
	if err := os.Rename(f.lib, moved); err != nil {
		t.Fatal(err)
	}
	f.ix.Rescan()
	if n := len(f.items()); n != 6 {
		t.Fatalf("a missing library deleted rows: %d", n)
	}
	_ = os.Rename(moved, f.lib)
}

func TestReconcileProjectsAndDisabled(t *testing.T) {
	f := newFx(t)
	thumb := filepath.Join(t.TempDir(), "support", "projects", "p1", "thumb.jpg")
	os.MkdirAll(filepath.Dir(thumb), 0o755)
	os.WriteFile(thumb, []byte("x"), 0o644)
	f.projects = []mi.Project{{ID: "p1", ModuleID: "paint", Name: "Sketch", Thumb: thumb}, {ID: "p2", Thumb: filepath.Join(t.TempDir(), "none.jpg")}}
	f.reconcile()
	it := f.items()["thumb.jpg"]
	if it.Source != "project" || it.SourceRef != "p1" || it.Kind != "image" || it.State != "pending" {
		t.Fatalf("project row: %+v", it)
	}
	if len(f.items()) != 1 {
		t.Fatal("a project without a thumb has no row")
	}
	// saving the project changes the thumb → redone
	os.WriteFile(thumb, []byte("xxxx"), 0o644)
	if err := f.ix.TestSyncProjects(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.items()["thumb.jpg"].Size != 4 {
		t.Fatal("changed thumb not noticed")
	}
	f.mu.Lock()
	f.projects = nil
	f.mu.Unlock()
	f.ix.TestSyncProjects(context.Background())
	if len(f.items()) != 0 {
		t.Fatal("deleted project kept")
	}
	// the support dir inside the library is never walked (derived from the thumb path)
	sup := f.path("support")
	thumb2 := filepath.Join(sup, "projects", "p3", "thumb.jpg")
	os.MkdirAll(filepath.Dir(thumb2), 0o755)
	os.WriteFile(thumb2, []byte("x"), 0o644)
	os.WriteFile(filepath.Join(sup, "clipboard.png"), []byte("x"), 0o644)
	f.write("real.jpg", 3)
	f.mu.Lock()
	f.projects = []mi.Project{{ID: "p3", Thumb: thumb2}}
	f.mu.Unlock()
	f.reconcile()
	for name, it := range f.items() {
		if name == "clipboard.png" || (name == "thumb.jpg" && it.Source == "library") {
			t.Errorf("support dir file walked as a library file: %+v", it)
		}
	}
	// disabled: reconcile changes nothing
	f2 := newFx(t)
	f2.write("a.jpg", 3)
	f2.ix.SetSettings(context.Background(), core.SearchSettings{Enabled: false, SpeechMaxMin: 60})
	f2.reconcile()
	if len(f2.items()) != 0 {
		t.Fatal("disabled index scanned")
	}
}

func TestAddedRenamedRemoved(t *testing.T) {
	f := newFx(t)
	ctx := context.Background()
	a := f.write("a.jpg", 3)
	hidden := f.write(".h.jpg", 3)
	f.write("Skip/x.jpg", 3)
	f.ix.SetSettings(ctx, core.SearchSettings{Enabled: true, ReadText: true, SpeechMaxMin: 60, Skip: []string{"Skip"}})
	outside := filepath.Join(t.TempDir(), "o.jpg")
	os.WriteFile(outside, []byte("x"), 0o644)
	if err := f.ix.TestSyncPaths(ctx, a, hidden, f.path("Skip/x.jpg"), outside, f.path("missing.jpg"), f.path("z.zip")); err != nil {
		t.Fatal(err)
	}
	if got := f.items(); len(got) != 1 || got["a.jpg"].State != "pending" {
		t.Fatalf("only a.jpg is wanted: %v", got)
	}
	// Renamed follows the file (and keeps its labels and text)
	f.store(f.res(a, "image", at(-1, 0)))
	b := f.path("renamed.jpg")
	if err := os.Rename(a, b); err != nil {
		t.Fatal(err)
	}
	f.ix.Renamed(a, b)
	got := f.items()
	if len(got) != 1 || got["renamed.jpg"].State != "done" {
		t.Fatalf("after rename: %v", got)
	}
	if hits := f.query(core.SearchQuery{Text: "apple"}).Hits; len(hits) != 1 || filepath.Base(hits[0].Path) != "renamed.jpg" {
		t.Fatalf("query after rename: %v", paths(hits))
	}
	// A rename of an unknown file queues the new name.
	c := f.write("c.jpg", 3)
	d := f.path("d.jpg")
	os.Rename(c, d)
	f.ix.Renamed(c, d)
	f.ix.TestTick(ctx)
	if _, ok := f.items()["d.jpg"]; !ok {
		t.Fatalf("unknown rename not queued: %v", f.items())
	}
	// Removed: a file that still exists keeps its row; a gone one loses it.
	f.ix.Removed(b)
	if _, ok := f.items()["renamed.jpg"]; !ok {
		t.Fatal("an existing file lost its row")
	}
	os.Remove(b)
	f.ix.Removed(b)
	if _, ok := f.items()["renamed.jpg"]; ok {
		t.Fatal("trashed file kept its row")
	}
	if hits := f.query(core.SearchQuery{Text: "apple"}).Hits; len(hits) != 0 {
		t.Fatalf("a deleted file is still found: %v", paths(hits))
	}
}

// settle runs ticks until the scheduler has submitted a job of the module (or fails).
func (f *fx) settle(module string, wantCount int) core.Job {
	f.t.Helper()
	for i := 0; i < 50; i++ {
		f.ix.TestTick(context.Background())
		f.ix.TestWaitIdle() // label loading runs in the background
		if f.jobs.count(module) >= wantCount {
			j, _ := f.jobs.last(module)
			return j
		}
	}
	f.t.Fatalf("no %s job #%d was submitted", module, wantCount)
	return core.Job{}
}

func (f *fx) noJob(module string, n int) {
	f.t.Helper()
	for i := 0; i < 3; i++ {
		f.ix.TestTick(context.Background())
		f.ix.TestWaitIdle()
	}
	if got := f.jobs.count(module); got != n {
		f.t.Fatalf("%s jobs = %d, want %d", module, got, n)
	}
}

// finishBatch stores a done result for every input of the job and delivers the event.
func (f *fx) finishBatch(j core.Job) {
	f.t.Helper()
	var rs []mi.ItemResult
	for _, p := range j.Inputs {
		rs = append(rs, f.res(p, "image", at(-1, 3)))
	}
	f.store(rs...)
	f.ix.TestJob(f.jobs.set(j.ID, core.JobDone, nil))
}

func TestSchedulerIdleOnlyAndOrder(t *testing.T) {
	f := newFx(t)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 40; i++ {
		p := f.write(fmt.Sprintf("p%02d.jpg", i), 5)
		f.setMod(p, base.Add(time.Duration(i)*time.Minute))
	}
	f.reconcile()

	// not installed, paused or disabled: nothing is submitted
	f.installed.Store(false)
	f.noJob(mi.IndexModuleID, 0)
	f.installed.Store(true)
	f.ix.SetSettings(context.Background(), core.SearchSettings{Enabled: true, Paused: true, ReadText: true, Speech: true, SpeechMaxMin: 60})
	f.noJob(mi.IndexModuleID, 0)
	f.ix.SetSettings(context.Background(), core.SearchSettings{Enabled: false, ReadText: true, SpeechMaxMin: 60})
	f.noJob(mi.IndexModuleID, 0)
	f.ix.SetSettings(context.Background(), core.SearchSettings{Enabled: true, ReadText: true, Speech: true, SpeechMaxMin: 60})

	// a user job is running: wait, and say so
	f.jobs.addUser("u1", core.JobRunning, time.Now().UnixMilli())
	f.noJob(mi.IndexModuleID, 0)
	if !f.ix.Status().Waiting {
		t.Error("Status.Waiting should be true while the user's job runs")
	}
	f.jobs.set("u1", core.JobDone, nil)

	// idle: one batch of 32, newest first, with the read-text option
	j := f.settle(mi.IndexModuleID, 1)
	if len(j.Inputs) != mi.BatchMaxFiles || filepath.Base(j.Inputs[0]) != "p39.jpg" || filepath.Base(j.Inputs[31]) != "p08.jpg" {
		t.Fatalf("batch: %d inputs, first %s, last %s", len(j.Inputs), filepath.Base(j.Inputs[0]), filepath.Base(j.Inputs[len(j.Inputs)-1]))
	}
	var opts mi.BatchOptions
	if err := json.Unmarshal([]byte(j.OptionsJSON), &opts); err != nil || !opts.ReadText {
		t.Fatalf("options %q: %v", j.OptionsJSON, err)
	}
	if f.ix.Status().Waiting {
		t.Error("not waiting once the user's job is done")
	}
	// one at a time
	f.jobs.set(j.ID, core.JobRunning, nil)
	f.noJob(mi.IndexModuleID, 1)
	// finished: the next batch has the rest
	f.finishBatch(j)
	j2 := f.settle(mi.IndexModuleID, 2)
	if len(j2.Inputs) != 8 {
		t.Fatalf("second batch: %d", len(j2.Inputs))
	}
	f.finishBatch(j2)
	f.noJob(mi.IndexModuleID, 2)
	if st := f.ix.Status(); st.Pending != 0 || st.Done != 40 {
		t.Fatalf("status %+v", st)
	}
	if f.em.count(core.EventSearchIndexed) != 2 {
		t.Errorf("search:indexed per batch: %d", f.em.count(core.EventSearchIndexed))
	}
}

func TestSchedulerSpeechAfterPicturesAndCancelOnWait(t *testing.T) {
	f := newFx(t)
	f.write("big.mp3", 900)
	f.write("small.mp3", 100)
	v := f.write("clip.mp4", 500)
	f.reconcile()
	f.ix.TestKnobs(20*time.Second, -1, 0, nil)

	// pictures first (the video), speech only after
	j := f.settle(mi.IndexModuleID, 1)
	if len(j.Inputs) != 1 || filepath.Base(j.Inputs[0]) != "clip.mp4" {
		t.Fatalf("batch: %v", j.Inputs)
	}
	if f.jobs.count(mi.SpeechModuleID) != 0 {
		t.Fatal("speech started before pictures were done")
	}
	f.store(f.res(v, "video", at(0, 3)))
	f.ix.TestJob(f.jobs.set(j.ID, core.JobDone, nil))

	// speech not ready (no model/FFmpeg): nothing
	f.speechReady.Store(false)
	f.noJob(mi.SpeechModuleID, 0)
	f.speechReady.Store(true)

	// smallest first, one file per job
	s1 := f.settle(mi.SpeechModuleID, 1)
	if len(s1.Inputs) != 1 || filepath.Base(s1.Inputs[0]) != "small.mp3" {
		t.Fatalf("speech job: %v", s1.Inputs)
	}
	f.jobs.set(s1.ID, core.JobRunning, nil)

	// a user job that waited 30 s cancels the speech job; nothing is penalised
	f.jobs.addUser("u1", core.JobQueued, time.Now().Add(-30*time.Second).UnixMilli())
	f.ix.TestTick(context.Background())
	f.jobs.mu.Lock()
	cancelled := append([]string(nil), f.jobs.cancelled...)
	f.jobs.mu.Unlock()
	if len(cancelled) != 1 || cancelled[0] != s1.ID {
		t.Fatalf("cancelled: %v", cancelled)
	}
	f.ix.TestJob(f.jobs.set(s1.ID, core.JobCancelled, nil))
	f.jobs.set("u1", core.JobRunning, nil)
	f.noJob(mi.SpeechModuleID, 1) // the user's job runs; speech waits
	it := f.items()["small.mp3"]
	if it.SpeechState != "pending" || it.Attempts != 0 {
		t.Fatalf("cancelled speech was penalised: %+v", it)
	}
	f.jobs.set("u1", core.JobDone, nil)
	s2 := f.settle(mi.SpeechModuleID, 2)
	if filepath.Base(s2.Inputs[0]) != "small.mp3" {
		t.Fatalf("requeued file: %v", s2.Inputs)
	}
	// a user job that only just arrived does not cancel it
	f.jobs.set(s2.ID, core.JobRunning, nil)
	f.jobs.addUser("u2", core.JobQueued, time.Now().UnixMilli())
	f.ix.TestTick(context.Background())
	f.jobs.mu.Lock()
	n := len(f.jobs.cancelled)
	f.jobs.mu.Unlock()
	if n != 1 {
		t.Fatalf("cancelled a speech job for a fresh user job: %d", n)
	}
	// the result is stored; the next speech file is the next smallest (the video)
	f.ix.StoreSpeech(context.Background(), mi.SpeechResult{Path: f.path("small.mp3"), Size: 100, ModMs: statMod(t, f.path("small.mp3")),
		Chunks: []core.MediaText{{Source: "speech", Pos: 0, EndPos: 5000, Text: "hello"}}})
	f.ix.TestJob(f.jobs.set(s2.ID, core.JobDone, nil))
	f.jobs.set("u2", core.JobDone, nil)
	s3 := f.settle(mi.SpeechModuleID, 3)
	if filepath.Base(s3.Inputs[0]) != "clip.mp4" {
		t.Fatalf("next speech: %v", s3.Inputs)
	}
	if st := f.ix.Status(); st.SpeechDone != 1 || st.Stage != "" {
		t.Logf("status %+v", st)
	}
}

func statMod(t *testing.T, p string) int64 {
	t.Helper()
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	return fi.ModTime().UnixMilli()
}

func TestSchedulerForceSpeechAfterReadAgain(t *testing.T) {
	f := newFx(t)
	p := f.write("talk.mp3", 100)
	f.reconcile()
	f.ix.TestKnobs(0, -1, 0, nil)
	s := f.settle(mi.SpeechModuleID, 1)
	var o mi.SpeechOptions
	json.Unmarshal([]byte(s.OptionsJSON), &o)
	if o.Force {
		t.Fatal("an automatic job must not force")
	}
	f.ix.StoreSpeech(context.Background(), mi.SpeechResult{Path: p, Size: 100, ModMs: statMod(t, p), Skipped: "Longer than 60 min"})
	f.ix.TestJob(f.jobs.set(s.ID, core.JobDone, nil))
	f.noJob(mi.SpeechModuleID, 1)
	fl, _ := f.ix.Failures(context.Background(), 10)
	if len(fl) != 1 || fl[0].Stage != "speech" || fl[0].State != "skipped" || fl[0].Reason != "Longer than 60 min" {
		t.Fatalf("failures: %+v", fl)
	}
	// "Transcribe now": Retry forces
	if err := f.ix.Retry(context.Background(), []string{p}); err != nil {
		t.Fatal(err)
	}
	s2 := f.settle(mi.SpeechModuleID, 2)
	json.Unmarshal([]byte(s2.OptionsJSON), &o)
	if !o.Force {
		t.Fatal("Retry of a skipped file must force")
	}
	// Read again on a done file re-queues it
	f.ix.StoreSpeech(context.Background(), mi.SpeechResult{Path: p, Size: 100, ModMs: statMod(t, p), NoSpeech: true})
	f.ix.TestJob(f.jobs.set(s2.ID, core.JobDone, nil))
	if f.items()["talk.mp3"].SpeechState != "nospeech" {
		t.Fatal("nospeech state")
	}
	if err := f.ix.ReadAgain(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	s3 := f.settle(mi.SpeechModuleID, 3)
	json.Unmarshal([]byte(s3.OptionsJSON), &o)
	if !o.Force {
		t.Fatal("ReadAgain ignores the speech cap")
	}
	if err := f.ix.ReadAgain(context.Background(), f.path("unknown.mp3")); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("unknown file: %v", err)
	}
}

func TestSchedulerRetriesItemByItemThenSkips(t *testing.T) {
	f := newFx(t)
	f.write("a.jpg", 1)
	f.write("b.jpg", 2)
	f.write("c.jpg", 3)
	f.reconcile()
	f.ix.TestKnobs(0, -1, 0, nil) // no pause after a failure
	b := f.settle(mi.IndexModuleID, 1)
	if len(b.Inputs) != 3 {
		t.Fatal("batch of three")
	}
	// the batch fails (an engine crash): each item has had one attempt
	f.ix.TestJob(f.jobs.set(b.ID, core.JobFailed, func(j *core.Job) { j.Error = "engine crashed" }))
	f.ix.TestTick(context.Background())
	if f.ix.Status().LastError == "" {
		t.Error("the failure should be reported")
	}
	// now one at a time
	var solo []string
	for i := 0; i < 3; i++ {
		j := f.settle(mi.IndexModuleID, 2+i)
		if len(j.Inputs) != 1 {
			t.Fatalf("retry #%d has %d inputs", i, len(j.Inputs))
		}
		solo = append(solo, filepath.Base(j.Inputs[0]))
		if i == 1 { // this one succeeds
			f.finishBatch(j)
		} else { // the others fail again → skipped
			f.ix.TestJob(f.jobs.set(j.ID, core.JobFailed, nil))
		}
	}
	f.ix.TestTick(context.Background())
	got := f.items()
	skipped := 0
	for _, name := range []string{"a.jpg", "b.jpg", "c.jpg"} {
		it := got[name]
		if it.State == "skipped" {
			skipped++
			if it.Reason != "Couldn't be read by the engine" {
				t.Errorf("%s reason %q", name, it.Reason)
			}
		}
	}
	if skipped != 2 || got[solo[1]].State != "done" {
		t.Fatalf("after retries: %v (order %v)", got, solo)
	}
	f.noJob(mi.IndexModuleID, 4) // nothing left to try
	fl, _ := f.ix.Failures(context.Background(), 10)
	if len(fl) != 2 || fl[0].State != "skipped" {
		t.Fatalf("failures: %+v", fl)
	}
	// Retry puts them back
	if err := f.ix.Retry(context.Background(), []string{fl[0].Path, fl[1].Path}); err != nil {
		t.Fatal(err)
	}
	if st := f.ix.Status(); st.Pending != 2 || st.Skipped != 0 {
		t.Fatalf("pending after Retry: %+v", st)
	}
}

func TestSchedulerNoPenaltyWhenEngineMissingOrCancelled(t *testing.T) {
	f := newFx(t)
	f.write("a.jpg", 1)
	f.reconcile()
	f.ix.TestKnobs(0, -1, 0, nil)
	j := f.settle(mi.IndexModuleID, 1)
	f.ix.TestJob(f.jobs.set(j.ID, core.JobFailed, func(j *core.Job) {
		j.ErrorCode, j.Error = core.CodeDependencyMissing, "Install the AI engine"
	}))
	f.ix.TestTick(context.Background())
	if it := f.items()["a.jpg"]; it.State != "pending" || it.Attempts != 0 {
		t.Fatalf("a missing engine is no fault of the file: %+v", it)
	}
	if f.ix.Status().LastError != "Install the AI engine" {
		t.Errorf("last error %q", f.ix.Status().LastError)
	}
	f.noJob(mi.IndexModuleID, 1) // backing off for minutes
	// a cancelled job: no penalty either (fresh index)
	f2 := newFx(t)
	f2.write("a.jpg", 1)
	f2.reconcile()
	j2 := f2.settle(mi.IndexModuleID, 1)
	f2.ix.TestJob(f2.jobs.set(j2.ID, core.JobCancelled, nil))
	if it := f2.items()["a.jpg"]; it.State != "pending" || it.Attempts != 0 {
		t.Fatalf("cancelled job penalised the file: %+v", it)
	}
}

func TestPrepareFailureRetriedOnceAtNextStart(t *testing.T) {
	f := newFx(t)
	p := f.write("bad.jpg", 1)
	f.reconcile()
	r := f.res(p, "image")
	r.Failed = "unreadable picture"
	f.store(r)
	it := f.items()["bad.jpg"]
	if it.State != "failed" || it.Attempts != 1 || it.Reason != "unreadable picture" {
		t.Fatalf("failed: %+v", it)
	}
	f.reconcile() // already reconciled: no retry within the same run
	if f.items()["bad.jpg"].State != "failed" {
		t.Fatal("retried within the same run")
	}
	// next start: a fresh index on the same database
	ix2 := f.newIndex(toyVocab)
	ix2.TestLoad(context.Background())
	ix2.TestReconcile(context.Background())
	if f.items()["bad.jpg"].State != "pending" {
		t.Fatal("failed file not retried at start")
	}
	r2 := f.res(p, "image")
	r2.Failed = "still unreadable"
	if err := ix2.TestLabels(context.Background()); err != nil {
		t.Fatal(err)
	}
	ix2.StoreBatch(context.Background(), []mi.ItemResult{r2})
	ix3 := f.newIndex(toyVocab)
	ix3.TestLoad(context.Background())
	ix3.TestReconcile(context.Background())
	if it := f.items()["bad.jpg"]; it.State != "failed" || it.Attempts != 2 {
		t.Fatalf("a file that failed twice stays failed: %+v", it)
	}
}

func TestModelChangeMarksPendingAndSkipsOldVectors(t *testing.T) {
	f := newFx(t)
	a := f.write("a.jpg", 1)
	f.reconcile()
	f.store(f.res(a, "image", at(-1, 0)))
	f.installed.Store(true)
	// find by concept (cache the text vector first)
	f.ix.TestLabels(context.Background())
	if _, err := f.ix.TextVector(context.Background(), "a red apple"); err != nil {
		t.Fatal(err)
	}
	if hits := f.query(core.SearchQuery{Text: "a red apple"}).Hits; len(hits) != 1 {
		t.Fatalf("before: %v", paths(hits))
	}
	f.model.Store("toy-2")
	f.ix.TestReconcile(context.Background()) // already reconciled → no-op
	f.ix.Rescan()                            // not started: reconciles now
	if it := f.items()["a.jpg"]; it.State != "pending" {
		t.Fatalf("model change did not mark pending: %+v", it)
	}
	if _, err := f.ix.TextVector(context.Background(), "a red apple"); err != nil {
		t.Fatal(err)
	}
	p := f.query(core.SearchQuery{Text: "a red apple"})
	if len(p.Hits) != 0 {
		t.Fatalf("old-model vectors must be skipped in scoring: %v", paths(p.Hits))
	}
	if f.ix.Status().Model != "toy-2" {
		t.Error("status model")
	}
}

func TestSettingsValidationAndPersistence(t *testing.T) {
	f := newFx(t)
	ctx := context.Background()
	if s := f.ix.Settings(); !s.Enabled || !s.ReadText || !s.Speech || s.SpeechMaxMin != 60 || s.Skip == nil {
		t.Fatalf("defaults: %+v", s)
	}
	bad := []core.SearchSettings{
		{Enabled: true, SpeechMaxMin: 0}, {Enabled: true, SpeechMaxMin: 601},
		{Enabled: true, SpeechMaxMin: 60, Skip: []string{"../outside"}},
		{Enabled: true, SpeechMaxMin: 60, Skip: []string{"/etc"}},
		{Enabled: true, SpeechMaxMin: 60, Skip: []string{`C:\Windows`}},
	}
	for _, s := range bad {
		if err := f.ix.SetSettings(ctx, s); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%+v: err %v", s, err)
		}
	}
	ok := core.SearchSettings{Enabled: true, ReadText: false, Speech: true, SpeechMaxMin: 600, Skip: []string{`Received\Phone`, "received/phone", " Old/ ", ""}}
	if err := f.ix.SetSettings(ctx, ok); err != nil {
		t.Fatal(err)
	}
	got := f.ix.Settings()
	if len(got.Skip) != 2 || got.Skip[0] != "Old" || got.Skip[1] != "Received/Phone" || got.SpeechMaxMin != 600 || got.ReadText {
		t.Fatalf("cleaned: %+v", got)
	}
	ix2 := f.newIndex(toyVocab)
	ix2.TestLoad(ctx)
	if g := ix2.Settings(); g.SpeechMaxMin != 600 || len(g.Skip) != 2 {
		t.Fatalf("not persisted: %+v", g)
	}
	// turning Speech on marks audio/video pending; turning Read text on redoes pictures
	f.write("a.mp3", 2)
	f.write("p.jpg", 2)
	f.ix.SetSettings(ctx, core.SearchSettings{Enabled: true, Speech: false, SpeechMaxMin: 60})
	f.reconcile()
	f.store(f.res(f.path("p.jpg"), "image", at(-1, 3)))
	if f.items()["a.mp3"].SpeechState != "none" {
		t.Fatal("speech off: no speech state")
	}
	f.ix.SetSettings(ctx, core.SearchSettings{Enabled: true, Speech: true, ReadText: true, SpeechMaxMin: 60})
	if f.items()["a.mp3"].SpeechState != "pending" || f.items()["p.jpg"].State != "pending" {
		t.Fatalf("toggles: %+v %+v", f.items()["a.mp3"], f.items()["p.jpg"])
	}
}

func TestStartStopsAndFirstReconcileDelay(t *testing.T) {
	f := newFx(t)
	f.write("a.jpg", 1)
	ctx, cancel := context.WithCancel(context.Background())
	start := time.Now()
	if err := f.ix.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("Start must return at once")
	}
	time.Sleep(50 * time.Millisecond)
	if len(f.items()) != 0 {
		t.Fatal("the first reconcile waits 60 s")
	}
	cancel()
	f.ix.Close() // waits for the loop: no goroutine leak, no hang
	f.ix.Close()
}
