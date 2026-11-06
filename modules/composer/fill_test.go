package composer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/viz"
)

const fillOrigin = "http://wails.localhost"

type nullEmitter struct{}

func (nullEmitter) Emit(string, any) {}

// hostBroker is a broker whose window has (or hasn't) announced itself.
func hostBroker(up bool) *viz.RenderBroker {
	b := viz.NewRenderBroker(nullEmitter{}, func(p string) (string, error) { return "/media/x/" + filepath.Base(p), nil }, "")
	b.SetAppOrigins(fillOrigin)
	if up {
		b.HandleRawMessage(viz.RawPrefix+"host|up", fillOrigin, fillOrigin)
	}
	return b
}

func templateDoc(t *testing.T, hide bool) Composition {
	t.Helper()
	d := newDoc(t)
	a, b := imageLayer("a", "/sample/a.png"), imageLayer("b", "/sample/b.png")
	a.Name, b.Name = "Left", "Right"
	b.Hidden = hide
	d.Layers = []Layer{a, textLayer("t"), b}
	return d
}

func saveTemplate(t *testing.T, e *env, doc Composition) string {
	t.Helper()
	info, err := e.svc.Create("Duo", "4:5", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Save(info.ID, "Duo", doc); err != nil {
		t.Fatal(err)
	}
	return info.ID
}

func TestSlotIndexes(t *testing.T) {
	cases := []struct {
		name string
		edit func(d *Composition)
		want []int
	}{
		{"every image layer by default", func(d *Composition) {}, []int{0, 2}},
		{"hidden layers are not default slots", func(d *Composition) { d.Layers[2].Hidden = true }, []int{0}},
		{"marked layers only", func(d *Composition) { d.Layers[2].Slot = true }, []int{2}},
		{"marked hidden layer counts", func(d *Composition) { d.Layers[2].Hidden, d.Layers[2].Slot = true, true }, []int{2}},
		{"no photo layers", func(d *Composition) { d.Layers = d.Layers[1:2] }, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := templateDoc(t, false)
			c.edit(&d)
			got := SlotIndexes(d)
			if len(got) != len(c.want) {
				t.Fatalf("got %v want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("got %v want %v", got, c.want)
				}
			}
		})
	}
}

func TestFillSlots(t *testing.T) {
	d := templateDoc(t, false)
	out, err := FillSlots(d, []string{"/in/1.jpg", "/in/2.jpg"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Layers[0].Image.Ref.Path != "/in/1.jpg" || out.Layers[2].Image.Ref.Path != "/in/2.jpg" {
		t.Errorf("paths %q %q", out.Layers[0].Image.Ref.Path, out.Layers[2].Image.Ref.Path)
	}
	if d.Layers[0].Image.Ref.Path != "/sample/a.png" {
		t.Error("the template document was modified")
	}
	if err := Validate(out); err != nil {
		t.Errorf("filled document invalid: %v", err)
	}

	short, err := FillSlots(d, []string{"/in/1.jpg"})
	if err != nil {
		t.Fatal(err)
	}
	if short.Layers[0].Hidden || !short.Layers[2].Hidden {
		t.Errorf("hidden: %v %v", short.Layers[0].Hidden, short.Layers[2].Hidden)
	}
	if _, err := FillSlots(d, []string{"1", "2", "3"}); err == nil {
		t.Error("more photos than slots accepted")
	}
	if _, err := FillSlots(d, nil); err == nil {
		t.Error("no photos accepted")
	}
	noPhotos := newDoc(t)
	noPhotos.Layers = []Layer{textLayer("t")}
	if _, err := FillSlots(noPhotos, []string{"1"}); err == nil {
		t.Error("a template without photo layers accepted")
	}
}

func TestDescribeStep(t *testing.T) {
	e := setup(t)
	id := saveTemplate(t, e, templateDoc(t, false))
	raw := func(o StepOptions) json.RawMessage { b, _ := json.Marshal(o); return b }

	info, err := e.m.DescribeStep(raw(StepOptions{TemplateID: id, Scale: 1}))
	if err != nil {
		t.Fatal(err)
	}
	if info.Summary != "Fill Duo · 2 photos each" || len(info.Produces) != 1 || info.Produces[0].Role != "image" || len(info.Templates) != 1 || info.Templates[0] != "/name" {
		t.Errorf("info %+v", info)
	}
	if len(info.Accepts.Extensions) == 0 {
		t.Error("accepts no images")
	}
	for name, o := range map[string]StepOptions{
		"no template":      {},
		"unknown template": {TemplateID: "nope"},
		"bad format":       {TemplateID: id, Format: "gif"},
		"bad scale":        {TemplateID: id, Scale: 9},
	} {
		if _, err := e.m.DescribeStep(raw(o)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := e.m.DescribeStep(json.RawMessage(`{"nonsense":1}`)); err == nil {
		t.Error("unknown option accepted")
	}
}

func files(paths ...string) []core.RunFile {
	out := make([]core.RunFile, len(paths))
	for i, p := range paths {
		out[i] = core.RunFile{Path: p, Name: filepath.Base(p)}
	}
	return out
}

func TestPrepareStepGroupsAndWaits(t *testing.T) {
	e := setup(t)
	id := saveTemplate(t, e, templateDoc(t, false))
	opts, _ := json.Marshal(StepOptions{TemplateID: id, Name: "{event}-{name}", Format: "png"})
	req := core.StepRequest{Options: opts, Item: core.StepItem{
		Vars:  map[string]string{"event": "party"},
		Files: files("/in/a.jpg", "/in/b.jpg", "/in/c.jpg"),
	}}

	// No window yet: wait, don't fail.
	e.m.cfg.Broker = hostBroker(false)
	if _, err := e.m.PrepareStep(context.Background(), req); !core.IsCode(err, core.CodeWaiting) {
		t.Fatalf("without a window: %v", err)
	}
	// And a nil broker waits too.
	e.m.cfg.Broker = nil
	if _, err := e.m.PrepareStep(context.Background(), req); !core.IsCode(err, core.CodeWaiting) {
		t.Fatalf("without a broker: %v", err)
	}

	e.m.cfg.Broker = hostBroker(true)
	jobs, err := e.m.PrepareStep(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 || len(jobs[0].Inputs) != 2 || len(jobs[1].Inputs) != 1 {
		t.Fatalf("jobs %+v", jobs)
	}
	o0, o1 := jobs[0].Options.(Options), jobs[1].Options.(Options)
	if o0.ProjectID != id || o0.Format != "png" || o0.Name != "party-a" || o1.Name != "party-c" {
		t.Errorf("options %+v %+v", o0, o1)
	}
}

func TestPrepareStepOnePerInput(t *testing.T) {
	e := setup(t)
	d := templateDoc(t, false)
	d.Layers[2].Hidden = true // one default slot
	id := saveTemplate(t, e, d)
	e.m.cfg.Broker = hostBroker(true)
	opts, _ := json.Marshal(StepOptions{TemplateID: id})
	jobs, err := e.m.PrepareStep(context.Background(), core.StepRequest{Options: opts, Item: core.StepItem{Files: files("/in/a.jpg", "/in/b.jpg")}})
	if err != nil || len(jobs) != 2 {
		t.Fatalf("%v %+v", err, jobs)
	}
}

func TestRunFillsAndRenders(t *testing.T) {
	e := setup(t)
	id := saveTemplate(t, e, templateDoc(t, false))
	var plan viz.CompositionPlan
	var w, h int
	old := renderFn
	t.Cleanup(func() { renderFn = old })
	renderFn = func(_ context.Context, _ *viz.RenderBroker, job *core.JobContext, c viz.CompositionPlan, ww, hh int) (viz.RenderOutput, error) {
		plan, w, h = c, ww, hh
		p := filepath.Join(job.TempDir, "still.png")
		return viz.RenderOutput{Path: p, Codec: "png", Frames: 1}, os.WriteFile(p, []byte("PNG"), 0o644)
	}
	outDir, tmp := t.TempDir(), t.TempDir()
	var registered []string
	opts, _ := json.Marshal(Options{ProjectID: id, Format: "png", Scale: 0.5})
	job := core.NewJobContext(core.JobContext{ID: "j", Inputs: []string{"/in/x.jpg", "/in/y.jpg"}, Options: opts, OutputDir: outDir, TempDir: tmp},
		core.JobHooks{Output: func(p string) (core.Output, error) {
			registered = append(registered, p)
			return core.Output{Path: p}, nil
		}})
	if err := e.m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if plan.Format != "png" || w != 540 || h != 675 {
		t.Errorf("plan %+v %dx%d", plan, w, h)
	}
	var sent Composition
	if err := json.Unmarshal([]byte(plan.DocumentJSON), &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Layers[0].Image.Ref.Path != "/in/x.jpg" || sent.Layers[2].Image.Ref.Path != "/in/y.jpg" {
		t.Errorf("layers %+v", sent.Layers)
	}
	if len(registered) != 1 || filepath.Dir(registered[0]) != outDir || filepath.Ext(registered[0]) != ".png" {
		t.Errorf("outputs %v", registered)
	}
	if got, _ := os.ReadFile(registered[0]); string(got) != "PNG" {
		t.Errorf("output file %q", got)
	}
	if filepath.Base(registered[0]) != "Duo - x.png" {
		t.Errorf("name %q", filepath.Base(registered[0]))
	}
}

func TestRunRefusesBadRequests(t *testing.T) {
	e := setup(t)
	id := saveTemplate(t, e, templateDoc(t, false))
	for name, c := range map[string]struct {
		inputs []string
		opts   Options
	}{
		"too many photos": {[]string{"1", "2", "3"}, Options{ProjectID: id}},
		"no photos":       {nil, Options{ProjectID: id}},
		"huge":            {[]string{"1"}, Options{ProjectID: id, Scale: 4}},
		"missing project": {[]string{"1"}, Options{ProjectID: "nope"}},
	} {
		raw, _ := json.Marshal(c.opts)
		job := core.NewJobContext(core.JobContext{Inputs: c.inputs, Options: raw, OutputDir: t.TempDir(), TempDir: t.TempDir()}, core.JobHooks{})
		if err := e.m.Run(context.Background(), job); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestStepOutputs(t *testing.T) {
	e := setup(t)
	res, err := e.m.StepOutputs(core.Job{Outputs: []core.Output{{Path: "/o/a.png", Name: "a.png"}}})
	if err != nil || len(res.Files) != 1 || res.Files[0].Role != "image" || res.Files[0].Kind != core.KindImage {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestDescriptorIsAStep(t *testing.T) {
	e := setup(t)
	d := e.m.Descriptor()
	if d.JobLess || d.NotAStep {
		t.Errorf("descriptor %+v", d)
	}
	if err := e.m.Validate([]string{"/a.jpg"}, json.RawMessage(`{"projectId":"x"}`)); err != nil {
		t.Error(err)
	}
	if err := e.m.Validate(nil, json.RawMessage(`{"projectId":"x"}`)); err == nil {
		t.Error("no inputs accepted")
	}
}
