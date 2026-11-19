package grade

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"toolbox/core"
)

const goodLook = `{"name":"Wet Neon","wildCurve":"late","ops":[
 {"kind":"balance","amount":0.7,"chaos":false,"region":{"kind":"all"},"params":{"exposure":-0.3,"temp":-0.2}},
 {"kind":"gradmap","amount":0.9,"chaos":false,"region":{"kind":"shadows","soft":0.5},"params":{"stops":"#0b4f5c@0,#ff2bd6@1"}},
 {"kind":"edgeglow","amount":1,"chaos":true,"region":{"kind":"subject","feather":0.3},"params":{"color":"#ff2bd6","strength":9}},
 {"kind":"teleport","amount":1,"region":{"kind":"all"},"params":{}}
]}`

func TestSystemPromptListsTheCatalog(t *testing.T) {
	p := SystemPrompt()
	for _, kind := range OpKinds() {
		if !strings.Contains(p, "- "+kind+":") {
			t.Errorf("op %s isn't in the prompt", kind)
		}
	}
	for _, want := range []string{"JSON only", "Never mention or guess who", "3 to 10 ops", "exposure (number -3..3)", "#0b4f5c"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt lacks %q", want)
		}
	}
}

func TestSchemasAreValidJSON(t *testing.T) {
	for name, s := range map[string]json.RawMessage{"vibe": VibeSchema(), "read": ReadSchema()} {
		var v map[string]any
		if err := json.Unmarshal(s, &v); err != nil || v["type"] != "object" {
			t.Errorf("%s schema: %v", name, err)
		}
		if !strings.Contains(string(s), `"enum":["balance"`) {
			t.Errorf("%s schema doesn't list the op kinds", name)
		}
	}
}

func TestParseVibeAssignsIDsClampsAndSetsTier(t *testing.T) {
	r, err := ParseVibe("Sure! Here you go:\n```json\n"+goodLook+"\n```", 42)
	if err != nil {
		t.Fatal(err)
	}
	if r.Tier != TierAI || r.Seed != 42 || r.Name != "Wet Neon" || r.WildCurve != "late" || r.V != 1 {
		t.Errorf("recipe = %+v", r)
	}
	if len(r.Ops) != 3 { // the teleport op is dropped
		t.Fatalf("%d ops", len(r.Ops))
	}
	seen := map[string]bool{}
	for _, op := range r.Ops {
		if !opIDRe.MatchString(op.ID) || seen[op.ID] {
			t.Errorf("bad or duplicate id %q", op.ID)
		}
		seen[op.ID] = true
		if !op.On {
			t.Errorf("op %s is off", op.Kind)
		}
	}
	if got := string(r.Ops[2].Params["strength"]); got != "3" {
		t.Errorf("strength = %s, want clamped to 3", got)
	}
	if !r.Ops[2].Chaos || r.Ops[2].Region.Kind != "subject" {
		t.Errorf("edge glow op = %+v", r.Ops[2])
	}
}

func TestParseVibeRejects(t *testing.T) {
	for name, reply := range map[string]string{
		"no JSON":  "I'd love to help with that!",
		"broken":   `{"name":"x","ops":[`,
		"no ops":   `{"name":"x","wildCurve":"linear","ops":[]}`,
		"all junk": `{"name":"x","wildCurve":"linear","ops":[{"kind":"teleport","amount":1,"region":{"kind":"all"},"params":{}}]}`,
	} {
		if _, err := ParseVibe(reply, 1); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseSuggestions(t *testing.T) {
	long := strings.Repeat("rain ", 40)
	reply := `{"suggestions":[
	 {"name":"Wet Neon","why":"` + long + `","recipe":` + goodLook + `},
	 {"name":"Broken","why":"x","recipe":{"name":"b","wildCurve":"linear","ops":[]}},
	 {"name":"Second","why":"Sink the sky","recipe":` + goodLook + `}
	]}`
	got, err := ParseSuggestions(reply, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "Wet Neon" || got[1].Name != "Second" {
		t.Fatalf("suggestions = %+v", got)
	}
	if n := len([]rune(got[0].Why)); n > MaxWhy {
		t.Errorf("why has %d runes", n)
	}
	if got[0].Recipe.Seed == got[1].Recipe.Seed {
		t.Error("suggestions share a seed")
	}
	if _, err := ParseSuggestions(`{"suggestions":[]}`, 1); err == nil {
		t.Error("an empty list was accepted")
	}
}

func vibeModule(t *testing.T, f *fakeText) *Module {
	m := newModule(t, nil, nil)
	m.cfg.Text, m.cfg.Vision = f, f
	return m
}

func TestVibeValid(t *testing.T) {
	f := &fakeText{replies: []string{goodLook}}
	got, err := vibeModule(t, f).Vibe(VibeRequest{Text: "rainy neon street at night", Seed: 7, N: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || len(f.reqs) != 3 {
		t.Fatalf("%d looks from %d requests", len(got), len(f.reqs))
	}
	for i, req := range f.reqs {
		if req.Temperature != 0.9 || req.Seed != int64(7+i) || req.Purpose != "Writing a look" || len(req.JSONSchema) == 0 {
			t.Errorf("request %d = temp %v seed %d purpose %q schema %d bytes", i, req.Temperature, req.Seed, req.Purpose, len(req.JSONSchema))
		}
		if !strings.Contains(req.Prompt, "rainy neon street") {
			t.Errorf("request %d prompt: %q", i, req.Prompt)
		}
	}
	if !strings.Contains(f.reqs[1].Prompt, "variation 2") || strings.Contains(f.reqs[0].Prompt, "variation") {
		t.Errorf("variation prompts: %q / %q", f.reqs[0].Prompt, f.reqs[1].Prompt)
	}
	if got[0].Seed != 7 || got[2].Seed != 9 {
		t.Errorf("seeds %d..%d", got[0].Seed, got[2].Seed)
	}
}

func TestVibeRetriesOnceWithTheErrorAppended(t *testing.T) {
	f := &fakeText{replies: []string{"not json at all", goodLook}}
	got, err := vibeModule(t, f).Vibe(VibeRequest{Text: "moody", N: 1})
	if err != nil || len(got) != 1 {
		t.Fatalf("%v, %v", got, err)
	}
	if len(f.reqs) != 2 || !strings.Contains(f.reqs[1].Prompt, "couldn't be used") || !strings.Contains(f.reqs[1].Prompt, "no JSON object") {
		t.Errorf("retry prompt: %q", f.reqs[len(f.reqs)-1].Prompt)
	}
}

func TestVibeGarbageFailsAfterTheRetry(t *testing.T) {
	f := &fakeText{replies: []string{"blah", "still blah"}}
	_, err := vibeModule(t, f).Vibe(VibeRequest{Text: "moody", N: 1})
	ae := core.AsAppError(err)
	if ae == nil || !strings.Contains(ae.Message, "couldn't write a look") {
		t.Fatalf("error = %v", err)
	}
	if len(f.reqs) != 2 {
		t.Errorf("%d requests, want 2", len(f.reqs))
	}
}

func TestVibeValidationAndAvailability(t *testing.T) {
	f := &fakeText{replies: []string{goodLook}}
	m := vibeModule(t, f)
	for name, req := range map[string]VibeRequest{
		"empty":  {Text: "  ", N: 1},
		"long":   {Text: strings.Repeat("x", 301), N: 1},
		"n zero": {Text: "x", N: 0},
		"n five": {Text: "x", N: 5},
	} {
		if _, err := m.Vibe(req); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeValidation {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(f.reqs) != 0 {
		t.Error("an invalid request reached the model")
	}
	f.readyErr = core.Errorf(core.CodeDependencyMissing, "Download a model in Local Chat first")
	if _, err := m.Vibe(VibeRequest{Text: "x", N: 1}); core.AsAppError(err).Code != core.CodeDependencyMissing {
		t.Errorf("no model: %v", err)
	}
	m.cfg.Text = nil
	if _, err := m.Vibe(VibeRequest{Text: "x", N: 1}); core.AsAppError(err).Code != core.CodeDependencyMissing {
		t.Errorf("no chat: %v", err)
	}
}

func TestCancelVibe(t *testing.T) {
	started := make(chan struct{})
	gen := &blockingText{started: started}
	m := newModule(t, nil, nil)
	m.cfg.Text = gen
	errc := make(chan error, 1)
	go func() { _, err := m.Vibe(VibeRequest{Text: "x", N: 1}); errc <- err }()
	<-started
	m.CancelVibe()
	err := <-errc
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeCancelled {
		t.Errorf("error = %v", err)
	}
}

type blockingText struct{ started chan struct{} }

func (b *blockingText) Ready() (string, error) { return "m", nil }
func (b *blockingText) ContextTokens() int     { return 1 }
func (b *blockingText) Complete(ctx context.Context, _ core.CompletionRequest) (string, error) {
	close(b.started)
	<-ctx.Done()
	return "", errors.New("stopped: " + ctx.Err().Error())
}

func TestReadSendsAStillAndNeverNamesPeople(t *testing.T) {
	f := &fakeText{replies: []string{`{"suggestions":[{"name":"Wet Neon","why":"Push the rain magenta","recipe":` + goodLook + `}]}`}}
	m := vibeModule(t, f)
	pic := writeJPEG(t, t.TempDir()+"/p.jpg", 1600, 900)
	got, err := m.Read(pic, 0)
	if err != nil || len(got) != 1 {
		t.Fatalf("%v, %v", got, err)
	}
	req := f.reqs[0]
	if len(req.Images) != 1 || req.Model != "fake-vision" || req.Purpose != "Reading a picture" {
		t.Errorf("request = images %v model %q purpose %q", req.Images, req.Model, req.Purpose)
	}
	if !strings.Contains(req.Prompt, "Never name or guess who") || !strings.Contains(req.System, "Never mention or guess who") {
		t.Error("the prompts don't forbid naming people")
	}
	if _, err := m.Read(t.TempDir()+"/missing.txt", 0); err == nil {
		t.Error("a non-picture was accepted")
	}
}

func TestReadUsesAVideoFrame(t *testing.T) {
	f := &fakeText{replies: []string{`{"suggestions":[{"name":"A","why":"b","recipe":` + goodLook + `}]}`}}
	m := vibeModule(t, f)
	m.cfg.Resolve = func(id string) (string, error) { return "/bin/" + id, nil }
	var gotAt int64
	frameFn = func(_ context.Context, ffmpeg, path string, atMs int64, maxDim int, out string) error {
		gotAt = atMs
		writeJPEG(t, out, 640, 360)
		if maxDim != ReadPixels {
			t.Errorf("maxDim = %d", maxDim)
		}
		return nil
	}
	t.Cleanup(func() { frameFn = extractFrame })
	video := t.TempDir() + "/v.mp4"
	if err := writeFile(video, "x"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Read(video, 4200); err != nil {
		t.Fatal(err)
	}
	if gotAt != 4200 || len(f.reqs[0].Images) != 1 {
		t.Errorf("frame at %d, images %v", gotAt, f.reqs[0].Images)
	}
}
