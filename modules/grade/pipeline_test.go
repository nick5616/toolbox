package grade

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/viz"
)

func stepOptions(t *testing.T, o StepOptions) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func stepRequest(opts json.RawMessage, files ...string) core.StepRequest {
	var rf []core.RunFile
	for _, f := range files {
		rf = append(rf, core.RunFile{Path: f, Name: f[strings.LastIndex(f, "/")+1:]})
	}
	return core.StepRequest{Options: opts, Item: core.StepItem{Files: rf, Vars: map[string]string{"mood": "sunny"}}}
}

func TestStepDescribe(t *testing.T) {
	m := newModule(t, nil, nil)
	info, err := m.DescribeStep(stepOptions(t, DefaultStepOptions()))
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 2 || info.Produces[0].Role != "graded" || info.Produces[1].Kind != core.KindVideo {
		t.Errorf("produces = %+v", info.Produces)
	}
	if len(info.Templates) != 1 || info.Templates[0] != "/vibe" || info.Together || info.NoFiles {
		t.Errorf("info = %+v", info)
	}
	if !strings.Contains(info.Summary, "teal-orange") || len(info.Warnings) != 0 {
		t.Errorf("summary %q warnings %v", info.Summary, info.Warnings)
	}
	vibe := DefaultStepOptions()
	vibe.Vibe = "something {mood}"
	info, err = m.DescribeStep(stepOptions(t, vibe))
	if err != nil || !strings.HasPrefix(info.Summary, "Vibe: ") || len(info.Warnings) == 0 {
		t.Errorf("vibe without chat: %+v, %v", info, err)
	}
	m.cfg.Text = &fakeText{replies: []string{goodLook}}
	if info, _ = m.DescribeStep(stepOptions(t, vibe)); len(info.Warnings) != 0 {
		t.Errorf("warnings with a model: %v", info.Warnings)
	}
	for name, raw := range map[string]string{
		"wild":    `{"look":"x","wild":3,"format":"same"}`,
		"format":  `{"look":"x","wild":0.5,"format":"gif"}`,
		"neither": `{"look":"","wild":0.5,"format":"same"}`,
		"unknown": `{"look":"x","wild":0.5,"format":"same","zzz":1}`,
	} {
		if _, err := m.DescribeStep(json.RawMessage(raw)); core.AsAppError(err) == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestStepPrepareOneJobPerFileWithTheStoredRecipe(t *testing.T) {
	m := newModule(t, nil, nil)
	o := DefaultStepOptions()
	o.Look, o.Wild, o.Format = "neon-noir", 0.8, "jpg"
	r := neonNoir()
	o.Recipe = &r
	jobs, err := m.PrepareStep(context.Background(), stepRequest(stepOptions(t, o), "/a/one.jpg", "/a/two.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 || jobs[0].Inputs[0] != "/a/one.jpg" || jobs[1].Inputs[0] != "/a/two.mp4" {
		t.Fatalf("jobs = %+v", jobs)
	}
	got := jobs[0].Options.(Options)
	if got.Wild != 0.8 || got.Format != "jpg" || got.Recipe.Name != "Neon Noir" || got.Vibe != "" || got.Action != "" {
		t.Errorf("options = %+v", got)
	}
	// Each job's options pass the module's own validation.
	raw, _ := json.Marshal(got)
	if err := m.Validate([]string{"/a/one.jpg"}, raw); err != nil && core.AsAppError(err).Code == core.CodeValidation && strings.Contains(core.AsAppError(err).Message, "look") {
		t.Errorf("a step's job fails validation: %v", err)
	}
}

func TestStepPrepareMergedItems(t *testing.T) {
	m := newModule(t, nil, nil)
	o := DefaultStepOptions()
	r := neonNoir()
	o.Recipe = &r
	req := core.StepRequest{Options: stepOptions(t, o), Items: []core.StepItem{
		{Files: []core.RunFile{{Path: "/a/1.jpg"}}},
		{Files: []core.RunFile{{Path: "/a/2.jpg"}, {Path: "/a/3.jpg"}}},
	}}
	jobs, err := m.PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 3 {
		t.Fatalf("%d jobs, %v", len(jobs), err)
	}
}

func TestStepPrepareVibeTemplate(t *testing.T) {
	f := &fakeText{replies: []string{goodLook}}
	m := newModule(t, nil, nil)
	m.cfg.Text = f
	o := DefaultStepOptions()
	o.Look, o.Vibe, o.Seed = "", "a {mood} day, shot {name}", 11
	jobs, err := m.PrepareStep(context.Background(), stepRequest(stepOptions(t, o), "/a/one.jpg", "/a/two.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 {
		t.Fatalf("%d jobs", len(jobs))
	}
	if got := jobs[0].Options.(Options); got.Vibe != "a sunny day, shot one" || got.VibeSeed != 11 {
		t.Errorf("vibe = %q seed %d", got.Vibe, got.VibeSeed)
	}
	if got := jobs[1].Options.(Options); got.Vibe != "a sunny day, shot two" {
		t.Errorf("vibe = %q", got.Vibe)
	}
	if len(f.reqs) != 0 {
		t.Error("the runner's event loop must not wait on the model")
	}

	// No chat model: wait, don't fail.
	m.cfg.Text = &fakeText{readyErr: core.Errorf(core.CodeDependencyMissing, "none")}
	if _, err := m.PrepareStep(context.Background(), stepRequest(stepOptions(t, o), "/a/one.jpg")); core.AsAppError(err).Code != core.CodeWaiting {
		t.Errorf("no model: %v", err)
	}

	// A template that expands to nothing.
	o.Vibe = "{missing}"
	m.cfg.Text = f
	if _, err := m.PrepareStep(context.Background(), stepRequest(stepOptions(t, o), "/a/one.jpg")); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeValidation {
		t.Errorf("empty vibe: %v", err)
	}
}

func TestStepPrepareWaitsWithoutAWindow(t *testing.T) {
	m := newModule(t, nil, nil)
	hostWaitFn = func(*viz.RenderBroker) error { return viz.ErrNoHost() }
	t.Cleanup(func() { hostWaitFn = func(br *viz.RenderBroker) error { return br.WaitForHost() } })
	o := DefaultStepOptions()
	r := neonNoir()
	o.Recipe = &r
	_, err := m.PrepareStep(context.Background(), stepRequest(stepOptions(t, o), "/a/one.jpg"))
	ae := core.AsAppError(err)
	if ae == nil || ae.Code != core.CodeWaiting || ae.Message != "Open Toolbox to render" {
		t.Errorf("error = %v", err)
	}
}

func TestStepPrepareNeedsALook(t *testing.T) {
	m := newModule(t, nil, nil)
	_, err := m.PrepareStep(context.Background(), stepRequest(stepOptions(t, DefaultStepOptions()), "/a/one.jpg"))
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeValidation || !strings.Contains(ae.Message, "no look") {
		t.Errorf("no stored recipe: %v", err)
	}
	o := DefaultStepOptions()
	bad := neonNoir()
	bad.V = 9
	o.Recipe = &bad
	if _, err := m.PrepareStep(context.Background(), stepRequest(stepOptions(t, o), "/a/one.jpg")); core.AsAppError(err) == nil || core.AsAppError(err).Code != core.CodeValidation {
		t.Errorf("a bad stored recipe: %v", err)
	}
}

func TestStepOutputs(t *testing.T) {
	m := newModule(t, nil, nil)
	res, err := m.StepOutputs(core.Job{Outputs: []core.Output{{Path: "/o/a.jpg"}, {Path: "/o/b.mp4"}}})
	if err != nil || len(res.Files) != 2 || res.Files[0].Role != "graded" || res.Files[1].Path != "/o/b.mp4" || res.Vars == nil {
		t.Errorf("%+v, %v", res, err)
	}
	if res, _ := m.StepOutputs(core.Job{}); res.Files == nil {
		t.Error("Files is nil")
	}
}

func TestDescriptorAndInteractive(t *testing.T) {
	m := newModule(t, nil, nil)
	d := m.Descriptor()
	if d.ID != ModuleID || d.OutputSubdir != "Graded" || !d.SplitInputs {
		t.Errorf("descriptor = %+v", d)
	}
	var _ core.InteractiveJobs = m
	var _ core.ModelProvider = m
}
