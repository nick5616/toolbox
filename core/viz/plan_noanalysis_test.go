package viz

import "testing"

// Phase 10 §5.4: an edit without a song has the zero AnalysisRef; the worker
// plan carries empty analysis URLs and an explicit range.
func TestEditPlanWithoutAnalysis(t *testing.T) {
	p := RenderPlan{
		Width: 1080, Height: 1920, FPS: 30, StartMs: 0, EndMs: 5000, Mode: ModeOpaque,
		Edit: &EditPlan{ProjectJSON: `{"version":1}`, Streams: map[string]EditPlanStream{}, Images: map[string]string{}},
	}
	called := 0
	w, err := buildWorkerPlan(p, func(s string) (string, error) { called++; return "/m/" + s, nil })
	if err != nil {
		t.Fatalf("buildWorkerPlan: %v", err)
	}
	if called != 0 || w.Analysis.AudioJSONURL != "" || w.Analysis.FeaturesURL != "" || w.Analysis.TextJSONURL != "" {
		t.Errorf("analysis urls = %+v (urlFor called %d times)", w.Analysis, called)
	}
	if w.Kind != "edit" || w.StartMs != 0 || w.EndMs != 5000 {
		t.Errorf("plan = %+v", w)
	}
	if n := plannedFrames(p); n != 150 {
		t.Errorf("plannedFrames = %d, want 150", n)
	}
}
