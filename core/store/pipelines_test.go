package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
)

func openTest(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestPipelinesRoundTrip(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	p := core.Pipeline{ID: "p1", Name: "One", Steps: []core.PipelineStep{{ID: "s1", Type: "converter", From: "input", OptionsJSON: "{}"}}, CreatedAt: 1, UpdatedAt: 1}
	if err := db.PutPipeline(ctx, p); err != nil {
		t.Fatal(err)
	}
	p.Name, p.UpdatedAt = "Renamed", 2
	if err := db.PutPipeline(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := db.PutPipeline(ctx, core.Pipeline{ID: "p2", Name: "Two", CreatedAt: 3}); err != nil {
		t.Fatal(err)
	}
	list, err := db.ListPipelines(ctx)
	if err != nil || len(list) != 2 || list[0].Name != "Renamed" || list[0].Steps[0].Type != "converter" || list[1].ID != "p2" {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if err := db.MarkSeen(ctx, "p1", []core.SeenFile{{Path: "/a", Size: 1, MTime: 2}}); err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePipeline(ctx, "p1"); err != nil {
		t.Fatal(err)
	}
	if seen, _ := db.SeenFiles(ctx, "p1"); len(seen) != 0 {
		t.Fatalf("seen rows kept: %v", seen)
	}
	if err := db.DeletePipeline(ctx, "p1"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("delete again: %v", err)
	}
}

func TestRunsListPrune(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	put := func(id, pid string, st core.RunStatus, created int64) {
		r := core.PipelineRun{ID: id, PipelineID: pid, Status: st, CreatedAt: created}
		b, _ := json.Marshal(r)
		if err := db.PutRun(ctx, r, string(b)); err != nil {
			t.Fatal(err)
		}
	}
	put("r1", "a", core.RunDone, 1)
	put("r2", "a", core.RunRunning, 2)
	put("r3", "b", core.RunFailed, 3)
	put("r4", "a", core.RunWaiting, 4)
	put("r5", "b", core.RunDone, 5)
	ids := func(states []string) []string {
		var out []string
		for _, s := range states {
			var r core.PipelineRun
			_ = json.Unmarshal([]byte(s), &r)
			out = append(out, r.ID)
		}
		return out
	}
	all, _ := db.ListRuns(ctx, core.RunFilter{})
	if got := ids(all); len(got) != 5 || got[0] != "r5" {
		t.Fatalf("all = %v", got)
	}
	act, _ := db.ListRuns(ctx, core.RunFilter{ActiveOnly: true})
	if got := ids(act); len(got) != 2 || got[0] != "r4" || got[1] != "r2" {
		t.Fatalf("active = %v", got)
	}
	ofA, _ := db.ListRuns(ctx, core.RunFilter{PipelineID: "a", Limit: 2})
	if got := ids(ofA); len(got) != 2 || got[0] != "r4" {
		t.Fatalf("a = %v", got)
	}
	pruned, err := db.PruneRuns(ctx, 1)
	if err != nil || len(pruned) != 2 { // keeps r5; deletes r3, r1; active untouched
		t.Fatalf("pruned = %v, %v", pruned, err)
	}
	if _, err := db.GetRun(ctx, "r1"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("r1 still there: %v", err)
	}
	if s, err := db.GetRun(ctx, "r2"); err != nil || s == "" {
		t.Fatalf("r2: %v", err)
	}
}

func TestWatchSeen(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	if err := db.MarkSeen(ctx, "p", []core.SeenFile{{Path: "/a", Size: 1, MTime: 1}, {Path: "/b", Size: 2, MTime: 2}}); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkSeen(ctx, "p", []core.SeenFile{{Path: "/a", Size: 9, MTime: 9}}); err != nil {
		t.Fatal(err)
	}
	if err := db.ForgetSeen(ctx, "p", []string{"/b"}); err != nil {
		t.Fatal(err)
	}
	seen, err := db.SeenFiles(ctx, "p")
	if err != nil || len(seen) != 1 || seen["/a"].Size != 9 {
		t.Fatalf("seen = %v, %v", seen, err)
	}
}

func TestMoveOutputAndJobTags(t *testing.T) {
	db := openTest(t)
	ctx := context.Background()
	j := core.Job{ID: "j1", ModuleID: "m", Status: core.JobDone, Inputs: []string{}, Attempt: 1, CreatedAt: 1, PipelineRunID: "r", PipelineStepID: "s"}
	if err := db.InsertJob(ctx, j); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	o, err := core.NewOutput(p, "j1", "m")
	if err != nil {
		t.Fatal(err)
	}
	o, err = db.UpsertOutput(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	np := filepath.Join(dir, "b.txt")
	if err := os.Rename(p, np); err != nil {
		t.Fatal(err)
	}
	moved, err := db.MoveOutput(ctx, o.ID, np)
	if err != nil || moved.ID != o.ID || moved.Path != np || moved.Name != "b.txt" || len(moved.Tags) == 0 || moved.Missing {
		t.Fatalf("moved = %+v, %v", moved, err)
	}
	if _, err := db.MoveOutput(ctx, "nope", np); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	got, err := db.GetJob(ctx, "j1")
	if err != nil || got.PipelineRunID != "r" || got.PipelineStepID != "s" {
		t.Fatalf("job tags = %+v, %v", got, err)
	}
	listed, _ := db.ListJobs(ctx, core.JobFilter{PipelineRunID: "r"})
	if len(listed) != 1 {
		t.Fatalf("filter = %v", listed)
	}
	none, _ := db.ListJobs(ctx, core.JobFilter{PipelineRunID: "other"})
	if len(none) != 0 {
		t.Fatalf("filter other = %v", none)
	}
}
