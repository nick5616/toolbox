package mediaindex_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"toolbox/core"
	mi "toolbox/core/mediaindex"
)

func TestStatusStageAndCurrentFromTheRunningJob(t *testing.T) {
	f := newFx(t)
	f.write("a.jpg", 1)
	f.write("b.jpg", 2)
	f.write("c.mp3", 3)
	f.reconcile()
	j := f.settle(mi.IndexModuleID, 1)
	f.ix.TestJob(f.jobs.set(j.ID, core.JobRunning, func(j *core.Job) { j.Progress, j.Message = 0, "Indexing pictures" }))
	if st := f.ix.Status(); st.Stage != "pictures" || st.Current == "" || !strings.HasSuffix(j.Inputs[0], st.Current) {
		t.Fatalf("pictures: %+v", st)
	}
	f.ix.TestJob(f.jobs.set(j.ID, core.JobRunning, func(j *core.Job) { j.Progress, j.Message = 0.9, "Reading text" }))
	st := f.ix.Status()
	if st.Stage != "text" || !strings.HasSuffix(j.Inputs[1], st.Current) {
		t.Fatalf("text: %+v", st)
	}
	if st.Total != 3 || st.Pending != 2 || st.Done != 1 || !st.Installed || !st.Enabled || st.Model != "toy-1" {
		t.Fatalf("numbers: %+v", st)
	}
	// finished: no stage
	f.finishBatch(j)
	f.ix.TestTick(context.Background())
	sp := f.settle(mi.SpeechModuleID, 1)
	f.ix.TestJob(f.jobs.set(sp.ID, core.JobRunning, nil))
	if st := f.ix.Status(); st.Stage != "speech" || st.Current != "c.mp3" {
		t.Fatalf("speech: %+v", st)
	}
	f.ix.TestJob(f.jobs.set(sp.ID, core.JobCancelled, nil))
	f.ix.TestTick(context.Background())
}

// A path that differs only in case from the library's spelling never makes a
// second row (Windows and macOS file systems ignore case).
func TestPathsInsideTheLibraryUseItsSpelling(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		t.Skip("case-insensitive file systems only")
	}
	f := newFx(t)
	p := f.write("Pics/a.jpg", 3)
	upper := strings.ToUpper(filepath.Dir(f.lib)) + string(filepath.Separator) + filepath.Base(f.lib) + string(filepath.Separator) + "Pics" + string(filepath.Separator) + "a.jpg"
	f.ix.Added(upper)
	f.ix.TestTick(context.Background())
	f.reconcile()
	items, _ := f.db.MediaIndex().AllItems(context.Background())
	if len(items) != 1 {
		t.Fatalf("one file, %d rows: %v", len(items), items)
	}
	if _, err := os.Stat(items[0].Path); err != nil || items[0].Path != p {
		t.Fatalf("row path %q, want %q", items[0].Path, p)
	}
}
