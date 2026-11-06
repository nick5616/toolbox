package viz

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"toolbox/core"
)

func (h *harness) comp(ctx context.Context, format string, w, hgt int) <-chan result {
	ch := make(chan result, 1)
	go func() {
		out, err := h.b.RenderComposition(ctx, h.job, CompositionPlan{DocumentJSON: `{"version":1}`, Format: format, Scale: 1}, w, hgt)
		ch <- result{out, err}
	}()
	return ch
}

func TestHostPresence(t *testing.T) {
	h := newHarness(t)
	if h.b.HostReady() {
		t.Fatal("ready before any host")
	}
	if ae := appErr(t, h.b.WaitForHost()); ae.Code != core.CodeWaiting || ae.Message != "Open Toolbox to render" {
		t.Errorf("waiting error: %+v", ae)
	}
	var nilBroker *RenderBroker
	if !core.IsCode(nilBroker.WaitForHost(), core.CodeWaiting) {
		t.Error("a nil broker must wait")
	}
	h.send("host", "up")
	if !h.b.HostReady() || h.b.WaitForHost() != nil {
		t.Fatal("host up not seen")
	}
	// another origin can't announce or withdraw a host
	h.b.HandleRawMessage(RawPrefix+"host|down", "https://evil.example", "https://evil.example")
	if !h.b.HostReady() {
		t.Error("a foreign origin withdrew the host")
	}
	h.b.HandleRawMessage(RawPrefix+"host|down", testOrigin+"/some/page", testOrigin)
	if h.b.HostReady() {
		t.Error("host down not seen")
	}
}

func TestRenderCompositionPNG(t *testing.T) {
	h := newHarness(t)
	res := h.comp(context.Background(), "png", 1080, 1350)
	st := h.em.waitStart(t)
	if st.Kind != "composition" {
		t.Fatalf("kind %q", st.Kind)
	}
	raw, err := os.ReadFile(filepath.Join(h.job.TempDir, planFileName))
	if err != nil {
		t.Fatal(err)
	}
	var plan PlanForWorker
	if err := json.Unmarshal(raw, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Kind != "composition" || plan.Composition == nil || plan.Composition.Format != "png" || plan.Width != 1080 {
		t.Errorf("plan %+v", plan)
	}
	h.send(st.Token, `start|{"encoder":"png","width":1080,"height":1350,"fps":1,"frames":1}`)
	h.send(st.Token, "progress|1|2")
	h.send(st.Token, dataMsg(0, []byte("PNG")))
	h.send(st.Token, dataMsg(1, []byte("DATA")))
	h.send(st.Token, doneMsg(1, 7))
	r := wait(t, res)
	if r.err != nil {
		t.Fatal(r.err)
	}
	if r.out.Codec != "png" || filepath.Base(r.out.Path) != "still.png" {
		t.Errorf("output %+v", r.out)
	}
	if b, _ := os.ReadFile(r.out.Path); string(b) != "PNGDATA" {
		t.Errorf("file %q", b)
	}
}

func TestRenderCompositionJPEGName(t *testing.T) {
	h := newHarness(t)
	res := h.comp(context.Background(), "jpg", 100, 50)
	st := h.em.waitStart(t)
	h.send(st.Token, `start|{"encoder":"jpg","width":100,"height":50,"fps":1,"frames":1}`)
	h.send(st.Token, dataMsg(0, []byte("J")))
	h.send(st.Token, doneMsg(1, 1))
	r := wait(t, res)
	if r.err != nil || r.out.Codec != "jpeg" || filepath.Base(r.out.Path) != "still.jpg" {
		t.Fatalf("%+v %v", r.out, r.err)
	}
}

func TestRenderCompositionRejectsMismatch(t *testing.T) {
	cases := map[string]string{
		"a video encoder": `start|{"encoder":"h264-sw","width":100,"height":50,"fps":1,"frames":1}`,
		"the wrong still": `start|{"encoder":"png","width":100,"height":50,"fps":1,"frames":1}`,
		"another size":    `start|{"encoder":"jpg","width":101,"height":50,"fps":1,"frames":1}`,
		"many frames":     `start|{"encoder":"jpg","width":100,"height":50,"fps":1,"frames":2}`,
	}
	for name, msg := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			res := h.comp(context.Background(), "jpg", 100, 50)
			st := h.em.waitStart(t)
			h.send(st.Token, msg)
			if r := wait(t, res); r.err == nil {
				t.Fatal("a mismatching start was accepted")
			}
		})
	}
}

func TestRenderCompositionKeepsTokenAndOriginRules(t *testing.T) {
	h := newHarness(t)
	res := h.comp(context.Background(), "jpg", 10, 10)
	st := h.em.waitStart(t)
	start := `start|{"encoder":"jpg","width":10,"height":10,"fps":1,"frames":1}`
	h.b.HandleRawMessage(RawPrefix+st.Token+"|"+start, "https://evil.example", "https://evil.example") // wrong origin
	h.send("00000000000000000000000000000000", start)                                                  // wrong token
	h.send(st.Token, start)
	h.send(st.Token, dataMsg(0, []byte("X")))
	h.send(st.Token, doneMsg(1, 1))
	if r := wait(t, res); r.err != nil || r.out.Codec != "jpeg" {
		t.Fatalf("%+v %v", r.out, r.err)
	}
}

func TestRenderCompositionError(t *testing.T) {
	h := newHarness(t)
	res := h.comp(context.Background(), "png", 10, 10)
	st := h.em.waitStart(t)
	h.send(st.Token, `error|{"message":"A photo is missing","detail":"x.jpg"}`)
	r := wait(t, res)
	ae := appErr(t, r.err)
	if ae.Message != "A photo is missing" {
		t.Errorf("error %+v", ae)
	}
}

func TestRenderCompositionValidatesRequest(t *testing.T) {
	h := newHarness(t)
	for _, c := range []struct {
		format string
		w, h   int
	}{{"gif", 10, 10}, {"png", 0, 10}} {
		if _, err := h.b.RenderComposition(context.Background(), h.job, CompositionPlan{Format: c.format}, c.w, c.h); err == nil {
			t.Errorf("%+v accepted", c)
		}
	}
}

func TestBuildEdit(t *testing.T) {
	h := newHarness(t)
	type out struct {
		json string
		err  error
	}
	ch := make(chan out, 1)
	go func() {
		j, err := h.b.BuildEdit(context.Background(), h.job, RecipePlan{ProjectJSON: `{"tracks":[]}`, RecipeID: "kick", Seed: 3},
			AnalysisRef{AudioJSON: "/a/audio.json", FeaturesPath: "/a/f.bin"})
		ch <- out{j, err}
	}()
	st := h.em.waitStart(t)
	if st.Kind != "recipe" {
		t.Fatalf("kind %q", st.Kind)
	}
	raw, _ := os.ReadFile(filepath.Join(h.job.TempDir, planFileName))
	var plan PlanForWorker
	if err := json.Unmarshal(raw, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Kind != "recipe" || plan.Recipe == nil || plan.Recipe.RecipeID != "kick" || plan.Recipe.Sources == nil ||
		plan.Analysis.AudioJSONURL != "/media/x/audio.json" {
		t.Errorf("plan %+v", plan)
	}
	h.send(st.Token, `start|{"encoder":"json","width":0,"height":0,"fps":1,"frames":1}`)
	h.send(st.Token, dataMsg(0, []byte(`{"tracks":`)))
	h.send(st.Token, dataMsg(1, []byte(`[1]}`)))
	h.send(st.Token, doneMsg(1, 14))
	select {
	case o := <-ch:
		if o.err != nil || o.json != `{"tracks":[1]}` {
			t.Fatalf("%q %v", o.json, o.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("BuildEdit didn't return")
	}
}

func TestPlannedFramesForSingles(t *testing.T) {
	for _, p := range []RenderPlan{{Composition: &CompositionPlan{}}, {Recipe: &RecipePlan{}}} {
		if plannedFrames(p) != 1 {
			t.Errorf("%+v", p)
		}
	}
}
