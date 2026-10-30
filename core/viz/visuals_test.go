package viz

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"testing"

	"toolbox/core"
	"toolbox/core/lyrics"
)

func fakeRender(t *testing.T, plans *[]RenderPlan, progress float64) {
	t.Helper()
	old := renderVia
	renderVia = func(_ context.Context, _ *RenderBroker, job *core.JobContext, plan RenderPlan) (RenderOutput, error) {
		*plans = append(*plans, plan)
		job.Progress(progress, "rendering")
		return RenderOutput{Path: "video.h264", Codec: "h264", Frames: 10}, nil
	}
	t.Cleanup(func() { renderVia = old })
}

func TestRenderVisuals(t *testing.T) {
	eng := newFakeEngine(t)
	a, song := fakeSong(t, eng, nil)
	var plans []RenderPlan
	fakeRender(t, &plans, 0.5)
	rec := &jobRec{}
	job := newJob(t, rec)
	lines := []lyrics.Line{{StartMs: 1000, EndMs: 3000, Text: "hello world"}}
	spec := VisualsSpec{ShowJSON: `{"version":1,"layers":[{"id":"a"}],"text":{"font":"x"},"seed":3}`, UseWords: true}

	out, err := RenderVisuals(context.Background(), job, a, nil, song, spec, lines, 1280, 720, 30, ModeOpaque, 0.2, 0.8)
	if err != nil {
		t.Fatal(err)
	}
	if out.Path != "video.h264" || len(plans) != 1 {
		t.Fatalf("out=%+v plans=%d", out, len(plans))
	}
	p := plans[0]
	if p.Width != 1280 || p.Height != 720 || p.FPS != 30 || p.Mode != ModeOpaque || p.EndMs != 10000 || p.StartMs != 0 || p.Seed < 0 {
		t.Errorf("plan = %+v", p)
	}
	var show map[string]json.RawMessage
	if err := json.Unmarshal([]byte(p.ShowJSON), &show); err != nil {
		t.Fatal(err)
	}
	if string(show["text"]) != "null" || string(show["seed"]) != "3" || len(show) != 4 {
		t.Errorf("show = %s", p.ShowJSON)
	}
	// The lines were analysed as given words with mood on.
	if !reflect.DeepEqual(eng.calls, []string{"viz.analyze"}) || p.Analysis.TextJSON == "" {
		t.Errorf("calls = %v text = %q", eng.calls, p.Analysis.TextJSON)
	}
	if tf := readText(t, p.Analysis.TextJSON); tf.Source != "given" || len(tf.Lines) != 1 || tf.Lines[0].Text != "hello world" {
		t.Errorf("text = %+v", tf)
	}
	// Progress is inside [0.2, 0.8]; the render's 0.5 maps into the second part.
	mid := 0.2 + 0.6*analysisShare
	for _, v := range rec.progress {
		if v < 0.2-1e-9 || v > 0.8+1e-9 {
			t.Fatalf("progress %v outside [0.2, 0.8]: %v", v, rec.progress)
		}
	}
	want := mid + 0.5*(0.8-mid)
	if got := rec.progress[len(rec.progress)-1]; math.Abs(got-want) > 1e-9 {
		t.Errorf("render progress = %v, want %v", got, want)
	}

	// The analysis is reused on the next call.
	eng.reset()
	if _, err := RenderVisuals(context.Background(), newJob(t, &jobRec{}), a, nil, song, spec, lines, 640, 360, 24, ModeOverlay, 0, 1); err != nil {
		t.Fatal(err)
	}
	if len(eng.calls) != 0 || plans[1].Mode != ModeOverlay || plans[1].Analysis.Key != p.Analysis.Key || plans[1].Seed != p.Seed {
		t.Errorf("calls=%v plan=%+v", eng.calls, plans[1])
	}

	// Without UseWords or with stems the options differ.
	spec2 := VisualsSpec{ShowJSON: `{"version":1}`, Stems: true}
	fakeFFmpeg(t)
	if _, err := RenderVisuals(context.Background(), newJob(t, &jobRec{}), a, nil, song, spec2, lines, 640, 360, 24, ModeOpaque, 0, 1); err != nil {
		t.Fatal(err)
	}
	last := plans[len(plans)-1]
	if last.Analysis.TextJSON != "" || last.Analysis.Instrumental == "" {
		t.Errorf("analysis = %+v", last.Analysis)
	}
}

func TestRenderVisualsBadShow(t *testing.T) {
	a, song := fakeSong(t, newFakeEngine(t), nil)
	var plans []RenderPlan
	fakeRender(t, &plans, 1)
	for _, show := range []string{"", "not json", "[1]", "null"} {
		_, err := RenderVisuals(context.Background(), newJob(t, &jobRec{}), a, nil, song, VisualsSpec{ShowJSON: show}, nil, 640, 360, 30, ModeOpaque, 0, 1)
		var ae *core.AppError
		if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
			t.Errorf("show %q: err = %v", show, err)
		}
	}
	if len(plans) != 0 {
		t.Error("rendered a bad design")
	}
}
