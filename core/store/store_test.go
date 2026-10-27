package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"toolbox/core"
)

func openTemp(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "sub dir", "toolbox.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func mkJob(id, module string, status core.JobStatus, created int64) core.Job {
	return core.Job{ID: id, ModuleID: module, Title: "t " + id, Status: status, Inputs: []string{"a b", "c"},
		OptionsJSON: `{"x":1}`, Attempt: 1, CreatedAt: created}
}

func TestMigrationsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "my dir", "x.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetSetting(context.Background(), "k", `"v"`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.sql.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("migrations = %d, %v", n, err)
	}
	if v, ok, _ := db.GetSetting(context.Background(), "k"); !ok || v != `"v"` {
		t.Fatalf("setting lost: %q %v", v, ok)
	}
	var fk int
	db.sql.QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
	if fk != 1 {
		t.Fatal("foreign_keys off")
	}
}

func TestJobRoundTrip(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	j := mkJob("J1", "dl", core.JobQueued, 100)
	if err := db.InsertJob(ctx, j); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetJob(ctx, "J1")
	if err != nil {
		t.Fatal(err)
	}
	j.Outputs = []core.Output{}
	if !reflect.DeepEqual(got, j) {
		t.Fatalf("got %+v want %+v", got, j)
	}
	j.Status, j.Progress, j.Error, j.ErrorCode = core.JobFailed, 0.5, "boom", core.CodeToolFailed
	j.Inputs = nil
	j.OptionsJSON = ""
	if err := db.UpdateJob(ctx, j); err != nil {
		t.Fatal(err)
	}
	got, _ = db.GetJob(ctx, "J1")
	if got.Status != core.JobFailed || got.Error != "boom" || got.OptionsJSON != "{}" || got.Inputs == nil || len(got.Inputs) != 0 {
		t.Fatalf("update not applied: %+v", got)
	}
	if _, err := db.GetJob(ctx, "nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
	l, err := db.ListJobs(ctx, core.JobFilter{ModuleID: "none"})
	if err != nil || l == nil || len(l) != 0 {
		t.Fatalf("empty list: %v %v", l, err)
	}
}

func TestListJobsFiltersAndOutputs(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		m, st := "a", core.JobDone
		if i%2 == 0 {
			m, st = "b", core.JobFailed
		}
		if err := db.InsertJob(ctx, mkJob(fmt.Sprintf("J%d", i), m, st, int64(i))); err != nil {
			t.Fatal(err)
		}
	}
	// same created_at tie broken by id desc
	db.InsertJob(ctx, mkJob("J9", "a", core.JobDone, 5))
	dir := t.TempDir()
	f := filepath.Join(dir, "o.mp3")
	os.WriteFile(f, []byte("x"), 0o644)
	if _, err := db.UpsertOutput(ctx, core.Output{ID: "O1", JobID: "J3", ModuleID: "a", Path: f, Name: "o.mp3", Kind: core.KindAudio, CreatedAt: 1, Tags: []string{"k"}}); err != nil {
		t.Fatal(err)
	}
	all, _ := db.ListJobs(ctx, core.JobFilter{})
	ids := []string{}
	for _, j := range all {
		ids = append(ids, j.ID)
	}
	if !reflect.DeepEqual(ids, []string{"J9", "J5", "J4", "J3", "J2", "J1"}) {
		t.Fatalf("order: %v", ids)
	}
	for _, j := range all {
		if j.ID == "J3" {
			if len(j.Outputs) != 1 || j.Outputs[0].ID != "O1" || j.Outputs[0].Missing || !reflect.DeepEqual(j.Outputs[0].Tags, []string{"k"}) {
				t.Fatalf("outputs: %+v", j.Outputs)
			}
		} else if j.Outputs == nil || len(j.Outputs) != 0 {
			t.Fatalf("outputs should be empty non-nil: %+v", j)
		}
	}
	b, _ := db.ListJobs(ctx, core.JobFilter{ModuleID: "b"})
	if len(b) != 2 {
		t.Fatalf("module filter: %d", len(b))
	}
	s, _ := db.ListJobs(ctx, core.JobFilter{Statuses: []core.JobStatus{core.JobFailed, core.JobQueued}})
	if len(s) != 2 {
		t.Fatalf("status filter: %d", len(s))
	}
	lim, _ := db.ListJobs(ctx, core.JobFilter{Limit: 2})
	if len(lim) != 2 || lim[0].ID != "J9" {
		t.Fatalf("limit: %+v", lim)
	}
	for i := 10; i < 620; i++ {
		db.InsertJob(ctx, mkJob(fmt.Sprintf("K%04d", i), "z", core.JobDone, int64(i)))
	}
	if l, _ := db.ListJobs(ctx, core.JobFilter{}); len(l) != 100 {
		t.Fatalf("default limit: %d", len(l))
	}
	if l, _ := db.ListJobs(ctx, core.JobFilter{Limit: 9999}); len(l) != 500 {
		t.Fatalf("max limit: %d", len(l))
	}
}

func TestLogs(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	db.InsertJob(ctx, mkJob("J1", "a", core.JobRunning, 1))
	if l, err := db.Logs(ctx, "J1"); err != nil || l == nil || len(l) != 0 {
		t.Fatalf("empty logs: %v %v", l, err)
	}
	lines := []core.LogLine{
		{Seq: 3, TS: 3, Stream: core.StreamSystem, Text: "c"},
		{Seq: 1, TS: 1, Stream: core.StreamStdout, Text: "a"},
		{Seq: 2, TS: 2, Stream: core.StreamStderr, Text: "b"},
	}
	if err := db.AppendLogs(ctx, "J1", lines); err != nil {
		t.Fatal(err)
	}
	got, _ := db.Logs(ctx, "J1")
	if len(got) != 3 || got[0].Text != "a" || got[1].Text != "b" || got[2].Text != "c" || got[1].Stream != core.StreamStderr {
		t.Fatalf("logs: %+v", got)
	}
	if n, _ := db.CountLogs(ctx, "J1"); n != 3 {
		t.Fatalf("count %d", n)
	}
	// failed batch rolls back entirely
	err := db.AppendLogs(ctx, "J1", []core.LogLine{{Seq: 10, Stream: core.StreamStdout}, {Seq: 1, Stream: core.StreamStdout}})
	if err == nil {
		t.Fatal("want duplicate error")
	}
	if n, _ := db.CountLogs(ctx, "J1"); n != 3 {
		t.Fatalf("tx not rolled back: %d", n)
	}
}

func TestCascadeAndSetNull(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	db.InsertJob(ctx, mkJob("J1", "a", core.JobDone, 1))
	db.AppendLogs(ctx, "J1", []core.LogLine{{Seq: 1, Stream: core.StreamStdout, Text: "x"}})
	o, err := db.UpsertOutput(ctx, core.Output{ID: "O1", JobID: "J1", ModuleID: "a", Path: "/nowhere/f.txt", Name: "f.txt", Kind: core.KindDocument, CreatedAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if o.JobID != "J1" {
		t.Fatalf("job id %q", o.JobID)
	}
	if err := db.DeleteJobs(ctx, []string{"J1"}); err != nil {
		t.Fatal(err)
	}
	if n, _ := db.CountLogs(ctx, "J1"); n != 0 {
		t.Fatal("logs not cascaded")
	}
	o, err = db.GetOutput(ctx, "O1")
	if err != nil || o.JobID != "" {
		t.Fatalf("job_id should be null: %+v %v", o, err)
	}
	if err := db.DeleteOutput(ctx, "O1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetOutput(ctx, "O1"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestUpsertKeepsIDReplacesTags(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	db.InsertJob(ctx, mkJob("J1", "a", core.JobDone, 1))
	db.InsertJob(ctx, mkJob("J2", "b", core.JobDone, 2))
	a, err := db.UpsertOutput(ctx, core.Output{ID: "O1", JobID: "J1", ModuleID: "a", Path: "/p/f.mp3", Name: "f.mp3", Kind: core.KindAudio, SizeBytes: 1, CreatedAt: 10, Tags: []string{"x", "y"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := db.UpsertOutput(ctx, core.Output{ID: "O2", JobID: "J2", ModuleID: "b", Path: "/p/f.mp3", Name: "f.mp3", Kind: core.KindAudio, SizeBytes: 5, CreatedAt: 20, Tags: []string{"z"}})
	if err != nil {
		t.Fatal(err)
	}
	if b.ID != a.ID || b.ID != "O1" {
		t.Fatalf("id changed: %s", b.ID)
	}
	if b.JobID != "J2" || b.ModuleID != "b" || b.SizeBytes != 5 || b.CreatedAt != 20 || !reflect.DeepEqual(b.Tags, []string{"z"}) {
		t.Fatalf("not updated: %+v", b)
	}
	if !b.Missing {
		t.Fatal("expected Missing for nonexistent file")
	}
	page, _ := db.ListOutputs(ctx, core.OutputQuery{})
	if len(page.Items) != 1 {
		t.Fatalf("duplicate rows: %d", len(page.Items))
	}
}

func TestCursorPagingStable(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	add := func(i int, created int64) {
		_, err := db.UpsertOutput(ctx, core.Output{ID: fmt.Sprintf("O%02d", i), ModuleID: "a", Path: fmt.Sprintf("/p/%d", i), Name: fmt.Sprintf("n%d", i), Kind: core.KindOther, CreatedAt: created})
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := 1; i <= 7; i++ {
		add(i, int64(i/2)*10) // plenty of created_at ties
	}
	var seen []string
	q := core.OutputQuery{Limit: 3}
	for n := 0; ; n++ {
		p, err := db.ListOutputs(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		for _, o := range p.Items {
			seen = append(seen, o.ID)
		}
		if n == 0 {
			// newer inserts between pages must not disturb paging
			add(50, 1000)
			add(51, 5)
		}
		if p.NextCursor == "" {
			break
		}
		q.Cursor = p.NextCursor
		if n > 10 {
			t.Fatal("paging does not terminate")
		}
	}
	// 7 original items, no duplicates, none skipped (O51 has created_at 5, older than the first-page boundary of 30..20 only partly; it may appear)
	count := map[string]int{}
	for _, id := range seen {
		count[id]++
		if count[id] > 1 {
			t.Fatalf("duplicate %s in %v", id, seen)
		}
	}
	for i := 1; i <= 7; i++ {
		if count[fmt.Sprintf("O%02d", i)] != 1 {
			t.Fatalf("missing O%02d in %v", i, seen)
		}
	}
	if count["O50"] != 0 {
		t.Fatalf("newer item leaked into later pages: %v", seen)
	}
	if _, err := db.ListOutputs(ctx, core.OutputQuery{Cursor: "!!"}); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("bad cursor: %v", err)
	}
}

func TestSearchAndMissing(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	dir := t.TempDir()
	real := filepath.Join(dir, "Real.txt")
	os.WriteFile(real, []byte("x"), 0o644)
	for i, n := range []struct{ name, path, mod string }{
		{"Real.txt", real, "a"},
		{"100%_done.txt", filepath.Join(dir, "gone1.txt"), "b"},
		{"1000 done.txt", filepath.Join(dir, "gone2.txt"), "b"},
		{"a_b.txt", filepath.Join(dir, "gone3.txt"), "b"},
		{"axb.txt", filepath.Join(dir, "gone4.txt"), "b"},
	} {
		db.UpsertOutput(ctx, core.Output{ID: fmt.Sprintf("O%d", i), ModuleID: n.mod, Path: n.path, Name: n.name, Kind: core.KindOther, CreatedAt: int64(i)})
	}
	names := func(q core.OutputQuery) []string {
		p, err := db.ListOutputs(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		r := []string{}
		for _, o := range p.Items {
			r = append(r, o.Name)
		}
		return r
	}
	if got := names(core.OutputQuery{Search: "real"}); !reflect.DeepEqual(got, []string{"Real.txt"}) {
		t.Fatalf("case-insensitive: %v", got)
	}
	if got := names(core.OutputQuery{Search: "%"}); !reflect.DeepEqual(got, []string{"100%_done.txt"}) {
		t.Fatalf("literal %%: %v", got)
	}
	if got := names(core.OutputQuery{Search: "a_b"}); !reflect.DeepEqual(got, []string{"a_b.txt"}) {
		t.Fatalf("literal _: %v", got)
	}
	if got := names(core.OutputQuery{ModuleID: "b", Search: "done"}); len(got) != 2 {
		t.Fatalf("module+search: %v", got)
	}
	p, _ := db.ListOutputs(ctx, core.OutputQuery{ModuleID: "a"})
	if len(p.Items) != 1 || p.Items[0].Missing || p.NextCursor != "" {
		t.Fatalf("real file: %+v", p)
	}
	p, _ = db.ListOutputs(ctx, core.OutputQuery{ModuleID: "b"})
	for _, o := range p.Items {
		if !o.Missing {
			t.Fatalf("expected missing: %+v", o)
		}
	}
	empty, _ := db.ListOutputs(ctx, core.OutputQuery{Search: "zzz"})
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Fatal("items must be empty non-nil")
	}
}

func TestSettingsKV(t *testing.T) {
	db := openTemp(t)
	ctx := context.Background()
	if _, ok, err := db.GetSetting(ctx, "a"); ok || err != nil {
		t.Fatalf("unset: %v %v", ok, err)
	}
	db.SetSetting(ctx, "a", "1")
	db.SetSetting(ctx, "a", "2")
	if v, ok, _ := db.GetSetting(ctx, "a"); !ok || v != "2" {
		t.Fatalf("got %q %v", v, ok)
	}
}
