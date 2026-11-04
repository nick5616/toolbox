package editstudio

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/lyrics"
	"toolbox/core/viz"
)

type lineT = lyrics.Line

func asApp(t *testing.T, err error) *core.AppError {
	t.Helper()
	var ae *core.AppError
	if !errors.As(err, &ae) {
		t.Fatalf("not an AppError: %v", err)
	}
	return ae
}

func TestServiceCRUD(t *testing.T) {
	m := newTestModule(t)
	s := NewService(nil, m)
	if _, err := s.Create("x", "3:2", 30); err == nil {
		t.Error("bad aspect accepted")
	}
	if _, err := s.Create("x", "9:16", 24); err == nil {
		t.Error("bad fps accepted")
	}
	info, err := s.Create("My edit", "9:16", 30)
	if err != nil {
		t.Fatal(err)
	}
	if info.Kind != core.ProjectEdit {
		t.Errorf("kind %q", info.Kind)
	}
	doc, err := s.Get(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Tracks) != 1 || doc.Tracks[0].Kind != "video" || doc.Seed <= 0 || doc.ExportHeight != 1080 || len(doc.Markers.Lanes) != 17 {
		t.Errorf("new doc %+v", doc)
	}
	if err := validateShape(doc); err != nil {
		t.Errorf("new doc invalid: %v", err)
	}
	d := validDoc()
	got, err := s.Save(info.ID, "Renamed", d)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Renamed" || got.Items != 4 {
		t.Errorf("saved %+v", got)
	}
	d.Aspect = "nope"
	if _, err := s.Save(info.ID, "Renamed", d); err == nil {
		t.Error("invalid doc saved")
	}
	dup, err := s.Duplicate(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := s.List()
	if len(list) != 2 {
		t.Errorf("list %d", len(list))
	}
	if err := s.Delete(dup.ID); err != nil {
		t.Fatal(err)
	}
	// nil slices come back as empty ones
	d2 := validDoc()
	d2.Sources = nil
	d2.Markers.Hidden = nil
	if _, err := s.Save(info.ID, "x", d2); err != nil {
		t.Fatal(err)
	}
	back, _ := s.Get(info.ID)
	if back.Sources == nil || back.Markers.Hidden == nil {
		t.Error("nil slices not normalised")
	}
}

func TestListFolder(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"b.mov", "a.JPG", ".hidden.mp4", "notes.txt", "song.mp3"} {
		if err := os.WriteFile(dir+"/"+n, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.Mkdir(dir+"/sub.mp4", 0o755)
	got, err := NewService(nil, newTestModule(t)).ListFolder(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !strings.HasSuffix(got[0], "a.JPG") || !strings.HasSuffix(got[1], "b.mov") {
		t.Errorf("got %v", got)
	}
}

func TestSaveThumb(t *testing.T) {
	m := newTestModule(t)
	s := NewService(nil, m)
	info, _ := s.Create("x", "1:1", 30)
	if err := s.SaveThumb(info.ID, "data:image/png;base64,AAAA"); err == nil {
		t.Error("png accepted")
	}
	jpeg := []byte{0xff, 0xd8, 0xff, 0xd9}
	if err := s.SaveThumb(info.ID, "data:image/jpeg;base64,"+base64.StdEncoding.EncodeToString(jpeg)); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(m.docs.ThumbPath(info.ID)); err != nil || len(b) != 4 {
		t.Errorf("thumb %v %d", err, len(b))
	}
}

func TestValidateOptionsNeedsProject(t *testing.T) {
	m := newTestModule(t)
	if err := m.validateOptions(Options{Action: ActionRender, ProjectID: "missing"}); err == nil {
		t.Error("render of a missing project accepted")
	}
	if err := m.validateOptions(Options{Action: "dance"}); err == nil {
		t.Error("unknown action accepted")
	}
}

func TestAnalyzeUsesStemsWithoutMood(t *testing.T) {
	m := newTestModule(t)
	var got struct {
		stems, mood bool
		words       string
	}
	m.analyze = func(_ context.Context, _ *core.JobContext, _ string, o viz.AnalyzeOptions) (viz.AnalysisRef, error) {
		got.stems, got.mood, got.words = o.Stems, o.Mood, string(o.Words)
		return viz.AnalysisRef{Key: "k"}, nil
	}
	req := AnalyzeRequest{Song: "/a.mp3"}
	r := &recorder{}
	job := newJob(t, t.TempDir(), Options{Action: ActionAnalyze, Analyze: &req}, r, nil)
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(r.result), `"key":"k"`) {
		t.Errorf("result %s", r.result)
	}
	if !got.stems || got.mood || got.words != "none" {
		t.Errorf("options %+v", got)
	}
}
