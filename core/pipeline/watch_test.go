package pipeline

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"toolbox/core"
)

func writeOld(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	must(t, os.WriteFile(p, []byte("data "+name), 0o644))
	old := time.Now().Add(-time.Minute)
	must(t, os.Chtimes(p, old, old))
	return p
}

func watchEnv(t *testing.T) (*env, string, core.Pipeline) {
	e := newEnv(t, 8, &fakeStep{id: "a", split: true})
	e.start()
	dir := t.TempDir()
	p := pl("Watched", step("aaaaaaa1", "a", FromInput, fakeOpts{}))
	p.Watch = core.WatchConfig{Enabled: true, Folder: dir}
	return e, dir, p
}

func (e *env) runsOf(p core.Pipeline) []core.PipelineRun {
	runs, err := e.r.Runs(core.RunFilter{PipelineID: p.ID})
	must(e.t, err)
	return runs
}

func TestIgnoredWatchFiles(t *testing.T) {
	for name, want := range map[string]bool{
		"a.txt": false, "song.WAV": false, ".hidden.txt": true, "~$doc.txt": true,
		"x.part": true, "x.crdownload": true, "x.tmp": true, "x.download": true, "X.PART": true, "part.txt": false,
	} {
		if got := ignoredWatchFile(name); got != want {
			t.Errorf("ignored(%q) = %v", name, got)
		}
	}
}

func TestWatchBaselineStabilityAndOneRunPerPoll(t *testing.T) {
	e, dir, p := watchEnv(t)
	writeOld(t, dir, "old.txt")
	p = e.save(p) // baselines old.txt
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "files that were already there never run", len(e.runsOf(p)), 0)

	writeOld(t, dir, "new1.txt")
	writeOld(t, dir, "new2.txt")
	writeOld(t, dir, ".hidden.txt")
	writeOld(t, dir, "~$lock.txt")
	writeOld(t, dir, "movie.part")
	writeOld(t, dir, "doc.pdf") // not accepted
	must(t, os.Mkdir(filepath.Join(dir, "sub.txt"), 0o755))
	e.r.pollWatch() // first sighting: not stable yet
	eq(t, "no run after one sighting", len(e.runsOf(p)), 0)
	e.r.pollWatch() // unchanged since the previous poll: ready
	runs := e.runsOf(p)
	eq(t, "one run", len(runs), 1)
	eq(t, "trigger", runs[0].Trigger, "watch")
	eq(t, "inputs", len(runs[0].Inputs), 2)
	eq(t, "first", filepath.Base(runs[0].Inputs[0]), "new1.txt")
	e.waitStatus(runs[0].ID, core.RunDone)
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "seen files don't run again", len(e.runsOf(p)), 1)

	// A file that changes is new again, after it settles.
	must(t, os.WriteFile(filepath.Join(dir, "new1.txt"), []byte("longer content now"), 0o644))
	old := time.Now().Add(-time.Minute)
	must(t, os.Chtimes(filepath.Join(dir, "new1.txt"), old, old))
	e.r.pollWatch() // sees the change
	eq(t, "changed file waits", len(e.runsOf(p)), 1)
	e.r.pollWatch()
	eq(t, "changed file runs", len(e.runsOf(p)), 2)

	// One more file later: one more run with just it.
	writeOld(t, dir, "later.txt")
	e.r.pollWatch()
	e.r.pollWatch()
	runs = e.runsOf(p)
	eq(t, "third run", len(runs), 3)
	eq(t, "only the new file", len(runs[0].Inputs), 1)
	eq(t, "which", filepath.Base(runs[0].Inputs[0]), "later.txt")
}

func TestWatchFileMustBeOldEnough(t *testing.T) {
	e, dir, p := watchEnv(t)
	e.r.stableAge = 3 * time.Second
	p = e.save(p)
	path := filepath.Join(dir, "fresh.txt")
	must(t, os.WriteFile(path, []byte("x"), 0o644))
	e.r.pollWatch()
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "a file younger than 3 s waits", len(e.runsOf(p)), 0)
	old := time.Now().Add(-10 * time.Second)
	must(t, os.Chtimes(path, old, old))
	e.r.pollWatch() // mtime changed: stability restarts
	e.r.pollWatch()
	eq(t, "then runs", len(e.runsOf(p)), 1)
}

func TestWatchBatchLimit(t *testing.T) {
	e, dir, p := watchEnv(t)
	p = e.save(p)
	for i := 0; i < MaxItems+1; i++ {
		writeOld(t, dir, fmt.Sprintf("f%03d.txt", i))
	}
	e.r.pollWatch()
	e.r.pollWatch()
	runs := e.runsOf(p)
	eq(t, "one run per poll", len(runs), 1)
	eq(t, "up to 200 files", len(runs[0].Inputs), MaxItems)
	e.r.pollWatch()
	runs = e.runsOf(p)
	eq(t, "the rest wait for the next poll", len(runs), 2)
	eq(t, "the last file", len(runs[0].Inputs), 1)
	eq(t, "which", filepath.Base(runs[0].Inputs[0]), fmt.Sprintf("f%03d.txt", MaxItems))
}

func TestWatchBaselineOnEnableAndFolderChange(t *testing.T) {
	e, dir, p := watchEnv(t)
	other := t.TempDir()
	writeOld(t, dir, "in-first.txt")
	writeOld(t, other, "in-second.txt")
	off := p
	off.Watch.Enabled = false
	off = e.save(off)
	// Enabling baselines what's there.
	off.Watch.Enabled = true
	off = e.save(off)
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "enabling doesn't run existing files", len(e.runsOf(off)), 0)
	// Changing the folder baselines the new one.
	off.Watch.Folder = other
	off = e.save(off)
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "changing the folder doesn't run existing files", len(e.runsOf(off)), 0)
	// Saving something else doesn't re-baseline: a file that arrived meanwhile still runs.
	writeOld(t, other, "arrived.txt")
	off.Description = "edited"
	off = e.save(off)
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "unrelated saves keep new files new", len(e.runsOf(off)), 1)
}

func TestWatchFilesThatAppearedWhileClosedRunAtNextStart(t *testing.T) {
	e, dir, p := watchEnv(t)
	writeOld(t, dir, "before.txt")
	p = e.save(p)
	e.r.Stop()
	writeOld(t, dir, "while-closed.txt")
	e.start()
	e.r.pollWatch()
	e.r.pollWatch()
	runs := e.runsOf(p)
	eq(t, "one run", len(runs), 1)
	eq(t, "file", filepath.Base(runs[0].Inputs[0]), "while-closed.txt")
	eq(t, "only the new one", len(runs[0].Inputs), 1)
}

func TestWatchPrunesSeenRowsAtStart(t *testing.T) {
	e, dir, p := watchEnv(t)
	gone := writeOld(t, dir, "gone.txt")
	keep := writeOld(t, dir, "keep.txt")
	p = e.save(p)
	seen, _ := e.db.SeenFiles(context.Background(), p.ID)
	eq(t, "baselined", len(seen), 2)
	must(t, os.Remove(gone))
	e.restart()
	seen, _ = e.db.SeenFiles(context.Background(), p.ID)
	if _, ok := seen[keep]; !ok || len(seen) != 1 {
		t.Fatalf("seen = %v", seen)
	}
}

func TestWatchStateMessages(t *testing.T) {
	e, dir, p := watchEnv(t)
	p = e.save(p)
	state := func() core.WatchState {
		for _, en := range e.r.List() {
			if en.Pipeline.ID == p.ID {
				return en.Watch
			}
		}
		t.Fatal("pipeline missing")
		return core.WatchState{}
	}
	if st := state(); !st.Active || st.Message != "" {
		t.Fatalf("good folder: %+v", st)
	}
	// Step problems pause it.
	broken := p
	broken.Steps[0].Type = "nosuch"
	broken = e.save(broken)
	if st := state(); st.Active || st.Message != "Fix the problems in step 1" {
		t.Fatalf("broken step: %+v", st)
	}
	e.r.pollWatch()
	e.r.pollWatch()
	writeOld(t, dir, "x.txt")
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "a paused watch doesn't run", len(e.runsOf(p)), 0)
	// A missing folder.
	gone := broken
	gone.Steps[0].Type = "a"
	gone.Watch.Folder = filepath.Join(dir, "missing")
	gone = e.save(gone)
	if st := state(); st.Active || st.Message != "Folder not found" {
		t.Fatalf("missing folder: %+v", st)
	}
	// Disabled.
	gone.Watch.Enabled = false
	e.save(gone)
	if st := state(); st.Active || st.Message != "" {
		t.Fatalf("disabled: %+v", st)
	}
}

func TestWatchRefusedRunKeepsFilesNewAndReportsWhy(t *testing.T) {
	e := newEnv(t, 4, &fakeStep{id: "needy", split: true, requires: []string{"ffmpeg"}})
	e.start()
	dir := t.TempDir()
	p := pl("Refused", step("aaaaaaa1", "needy", FromInput, fakeOpts{}))
	p.Watch = core.WatchConfig{Enabled: true, Folder: dir}
	p = e.save(p)
	e.tools = func(id string) (string, error) { return "", fmt.Errorf("missing") }
	writeOld(t, dir, "x.txt")
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "no run", len(e.runsOf(p)), 0)
	var st core.WatchState
	for _, en := range e.r.List() {
		st = en.Watch
	}
	// Missing tools make the pipeline not ready, so it pauses with that reason.
	if st.Active || st.Message == "" {
		t.Fatalf("state = %+v", st)
	}
	e.tools = func(id string) (string, error) { return "/bin/" + id, nil }
	e.r.pollWatch()
	e.r.pollWatch()
	eq(t, "runs once the tools are back", len(e.runsOf(p)), 1)
}
