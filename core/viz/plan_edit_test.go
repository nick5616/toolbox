package viz

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Phase 9 §12.2: edit plans carry their streams and images as /media URLs.
func TestEditPlanUsesURLs(t *testing.T) {
	dir := t.TempDir()
	p := testPlan()
	p.ShowJSON = ""
	p.Edit = &EditPlan{
		ProjectJSON: `{"version":1}`,
		Streams:     map[string]EditPlanStream{"v:/a/clip.mov": {Stream: "/c/v540-30.h264", Index: "/c/v540-30.idx.json"}},
		Images:      map[string]string{"p:/a/photo.jpg": "/c/img-1920.jpg"},
	}
	urlFor := func(s string) (string, error) { return "/media/tok/" + filepath.Base(s), nil }
	if _, err := writePlan(dir, p, urlFor); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, planFileName))
	var got PlanForWorker
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Kind != "edit" || got.Edit == nil {
		t.Fatalf("kind %q edit %v", got.Kind, got.Edit)
	}
	if got.Edit.ProjectJSON != `{"version":1}` {
		t.Errorf("project json %q", got.Edit.ProjectJSON)
	}
	s := got.Edit.Streams["v:/a/clip.mov"]
	if s.URL != "/media/tok/v540-30.h264" || s.IndexURL != "/media/tok/v540-30.idx.json" {
		t.Errorf("stream %+v", s)
	}
	if got.Edit.Images["p:/a/photo.jpg"] != "/media/tok/img-1920.jpg" {
		t.Errorf("images %v", got.Edit.Images)
	}
}

func TestShowPlanKind(t *testing.T) {
	w, err := buildWorkerPlan(testPlan(), func(s string) (string, error) { return "/m/" + filepath.Base(s), nil })
	if err != nil {
		t.Fatal(err)
	}
	if w.Kind != "show" || w.Edit != nil {
		t.Errorf("kind %q edit %v", w.Kind, w.Edit)
	}
	raw, _ := json.Marshal(w)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if _, ok := m["edit"]; ok {
		t.Error("show plans must not carry an edit field")
	}
}
