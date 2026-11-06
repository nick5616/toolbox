package store

import (
	"context"
	"testing"

	"toolbox/core/focus"
)

func TestFocusProfilesAndSettings(t *testing.T) {
	ctx := context.Background()
	fs := openTemp(t).FocusStore()
	if _, ok, err := fs.GetSettings(ctx); err != nil || ok {
		t.Fatalf("empty settings: %v %v", ok, err)
	}
	r := focus.AllowRule{ID: "r1", Label: "Live", Kind: focus.RuleExe, Path: `C:\x\live.exe`, Children: true}
	for _, p := range []focus.Profile{
		{ID: "b", Name: "beta", Rules: []focus.AllowRule{r}, UpdatedAt: 2},
		{ID: "a", Name: "Alpha", Rules: []focus.AllowRule{r}, UpdatedAt: 1},
	} {
		if err := fs.PutProfile(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	ps, err := fs.Profiles(ctx)
	if err != nil || len(ps) != 2 || ps[0].ID != "a" || ps[1].Rules[0] != r {
		t.Fatalf("profiles = %+v %v", ps, err)
	}
	_ = fs.PutProfile(ctx, focus.Profile{ID: "a", Name: "Alpha2", UpdatedAt: 3})
	ps, _ = fs.Profiles(ctx)
	if ps[0].Name != "Alpha2" || ps[0].Rules == nil {
		t.Fatalf("update = %+v", ps)
	}
	_ = fs.DeleteProfile(ctx, "a")
	if ps, _ = fs.Profiles(ctx); len(ps) != 1 {
		t.Fatalf("after delete %d", len(ps))
	}

	s := focus.DefaultSettings()
	s.PollMs, s.Learn, s.LastProfileID = 500, true, "b"
	s.AlwaysAllowed = []focus.AllowRule{r}
	if err := fs.PutSettings(ctx, s); err != nil {
		t.Fatal(err)
	}
	got, ok, err := fs.GetSettings(ctx)
	if err != nil || !ok || got.PollMs != 500 || !got.Learn || len(got.AlwaysAllowed) != 1 {
		t.Fatalf("settings = %+v %v %v", got, ok, err)
	}
}

func TestFocusSessions(t *testing.T) {
	ctx := context.Background()
	fs := openTemp(t).FocusStore()
	if s, err := fs.ActiveSession(ctx); err != nil || s != nil {
		t.Fatalf("active = %v %v", s, err)
	}
	s1 := focus.Session{ID: "s1", StartedAt: 100, EndsAt: 200, Strength: focus.StrengthFirm}
	s2 := focus.Session{ID: "s2", StartedAt: 300, EndsAt: 400, Strength: focus.StrengthSoft, Blocked: 3}
	_ = fs.PutSession(ctx, s1)
	_ = fs.PutSession(ctx, s2)
	a, _ := fs.ActiveSession(ctx)
	if a == nil || a.ID != "s2" || a.Extra == nil {
		t.Fatalf("active = %+v", a)
	}
	s2.EndedAt, s2.EndReason = 350, focus.EndUser
	_ = fs.PutSession(ctx, s2)
	if a, _ = fs.ActiveSession(ctx); a == nil || a.ID != "s1" {
		t.Fatalf("active = %+v", a)
	}
	rec, _ := fs.RecentSessions(ctx, 10)
	if len(rec) != 1 || rec[0].ID != "s2" || rec[0].Blocked != 3 || rec[0].EndReason != focus.EndUser {
		t.Fatalf("recent = %+v", rec)
	}
}

func TestFocusEventsLearnPrune(t *testing.T) {
	ctx := context.Background()
	fs := openTemp(t).FocusStore()
	_ = fs.AddEvents(ctx, []focus.BlockEvent{
		{SessionID: "s1", At: 10, Path: "p1", Name: "p1.exe", Result: focus.ResultStopped},
		{SessionID: "s1", At: 20, Path: "p2", Name: "p2.exe", Result: focus.ResultFailed, Error: "denied"},
		{SessionID: "", At: 30, Path: "p3", Name: "p3.exe", Result: focus.ResultWouldStop},
		{SessionID: "", At: 40, Path: "p3", Name: "p3.exe", Result: focus.ResultWouldStop},
		{SessionID: "", At: 5, Path: "old", Name: "old.exe", Result: focus.ResultWouldStop},
	})
	evs, _ := fs.Events(ctx, "s1", 10)
	if len(evs) != 2 || evs[0].Path != "p2" || evs[0].Error != "denied" {
		t.Fatalf("events = %+v", evs)
	}
	le, _ := fs.LearnEntries(ctx, 10)
	if len(le) != 1 || le[0].Path != "p3" || le[0].Count != 2 || le[0].LastSeen != 40 {
		t.Fatalf("learn = %+v", le)
	}
	_ = fs.ClearLearn(ctx, "p3")
	if le, _ = fs.LearnEntries(ctx, 0); len(le) != 1 || le[0].Path != "old" {
		t.Fatalf("after clear = %+v", le)
	}
	_ = fs.ClearLearn(ctx, "")
	if le, _ = fs.LearnEntries(ctx, 0); len(le) != 0 {
		t.Fatalf("after clear all = %+v", le)
	}
	_ = fs.PruneEvents(ctx, 15, 0)
	if evs, _ = fs.Events(ctx, "s1", 10); len(evs) != 1 {
		t.Fatalf("after prune = %+v", evs)
	}
	_ = fs.AddEvents(ctx, []focus.BlockEvent{{SessionID: "s1", At: 50, Path: "a"}, {SessionID: "s1", At: 60, Path: "b"}})
	_ = fs.PruneEvents(ctx, 0, 2)
	if evs, _ = fs.Events(ctx, "s1", 10); len(evs) != 2 || evs[0].Path != "b" {
		t.Fatalf("after keep = %+v", evs)
	}
}
