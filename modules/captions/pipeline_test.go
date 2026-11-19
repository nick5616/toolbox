package captions

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
)

func stepOptions(mut func(o *Options)) json.RawMessage {
	o := DefaultOptions()
	if mut != nil {
		mut(&o)
	}
	b, _ := json.Marshal(o)
	return b
}

func TestPrepareStepExpandsContext(t *testing.T) {
	e := newEnv(t)
	req := core.StepRequest{
		Options: stepOptions(func(o *Options) { o.Context = "Trip to {place}, file {name}" }),
		Item: core.StepItem{
			Files: []core.RunFile{{Path: filepath.Join("x", "dog.jpg")}, {Path: filepath.Join("x", "cat.jpg")}},
			Vars:  map[string]string{"place": "Lisbon"},
		},
	}
	jobs, err := e.m.PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("%v %v", jobs, err)
	}
	if !reflect.DeepEqual(jobs[0].Inputs, []string{filepath.Join("x", "dog.jpg"), filepath.Join("x", "cat.jpg")}) {
		t.Errorf("inputs %v", jobs[0].Inputs)
	}
	o := jobs[0].Options.(Options)
	if o.Context != "Trip to Lisbon, file dog" || o.Action != ActionCaption || o.Index != -1 {
		t.Errorf("options %+v", o)
	}
	// The expanded options are what the job validates.
	raw, _ := json.Marshal(o)
	if err := e.m.Validate([]string{photos(t, t.TempDir(), "d.jpg")[0]}, raw); err != nil {
		t.Errorf("validate: %v", err)
	}
	// Together: every merged item's files in one job; no files: no jobs.
	req.Items = []core.StepItem{{Files: []core.RunFile{{Path: "a.jpg"}}}, {Files: []core.RunFile{{Path: "b.jpg"}}}}
	if jobs, err := e.m.PrepareStep(context.Background(), req); err != nil || len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Errorf("together: %v %v", jobs, err)
	}
	if jobs, err := e.m.PrepareStep(context.Background(), core.StepRequest{Options: req.Options}); err != nil || len(jobs) != 0 {
		t.Errorf("no files: %v %v", jobs, err)
	}
	// More than 200 files split into jobs.
	var many []core.RunFile
	for i := 0; i < 450; i++ {
		many = append(many, core.RunFile{Path: "f.jpg"})
	}
	jobs, err = e.m.PrepareStep(context.Background(), core.StepRequest{Options: req.Options, Item: core.StepItem{Files: many}})
	if err != nil || len(jobs) != 3 || len(jobs[2].Inputs) != 50 {
		t.Errorf("split: %d jobs, %v", len(jobs), err)
	}
}

func TestPrepareStepWaitsWithoutModel(t *testing.T) {
	e := newEnv(t)
	e.vision.visionEr = core.Errorf(core.CodeDependencyMissing, "Install the Caption Writer pack to read pictures")
	req := core.StepRequest{Options: stepOptions(nil), Item: core.StepItem{Files: []core.RunFile{{Path: "a.jpg"}}}}
	_, err := e.m.PrepareStep(context.Background(), req)
	ae := core.AsAppError(err)
	if ae == nil || ae.Code != core.CodeWaiting || ae.Message != "Install the Caption Writer pack" {
		t.Fatalf("err %v", err)
	}
	// A model chosen in the step needs no default.
	req.Options = stepOptions(func(o *Options) { o.Model = "mine" })
	if _, err := e.m.PrepareStep(context.Background(), req); err != nil {
		t.Errorf("explicit model: %v", err)
	}
	// Without a generator at all.
	m := New(Config{LibraryDir: func() string { return e.lib }})
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Options: stepOptions(nil), Item: req.Item}); core.AsAppError(err).Code != core.CodeWaiting {
		t.Errorf("no generator: %v", err)
	}
	if _, err := e.m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{"bogus":1}`), Item: req.Item}); err == nil {
		t.Error("bad options must fail")
	}
}

func TestDescribeStepFinal(t *testing.T) {
	e := newEnv(t)
	info, err := e.m.DescribeStep(stepOptions(func(o *Options) { o.Then = ThenRenameCopies }))
	if err != nil {
		t.Fatal(err)
	}
	var roles []string
	for _, p := range info.Produces {
		roles = append(roles, p.Role)
	}
	if !reflect.DeepEqual(roles, []string{RoleTable, RoleCaptioned}) || len(info.Vars) != 7 {
		t.Errorf("info %+v", info)
	}
}

func TestStepOutputs(t *testing.T) {
	e := newEnv(t)
	e.useFakeTools()
	e.vision.replies = []string{good("dog")}
	in := photos(t, t.TempDir(), "a.jpg", "b.jpg")
	o := DefaultOptions()
	o.Preset = PresetEverything
	o.Then = ThenWriteCopies
	rec, err := mustRun(t, e, in, o)
	if err != nil {
		t.Fatal(err)
	}
	var outs []core.Output
	for i, r := range rec.outputs {
		outs = append(outs, core.Output{ID: string(rune('a' + i)), Path: r.Path, Name: filepath.Base(r.Path), Kind: core.KindDocument})
	}
	res, err := e.m.StepOutputs(core.Job{Outputs: outs, OptionsJSON: string(mustJSON(o))})
	if err != nil {
		t.Fatal(err)
	}
	var table, captioned int
	for _, f := range res.Files {
		switch f.Role {
		case RoleTable:
			table++
			if filepath.Base(f.Path) != CSVFile || f.RoleLabel != "Captions table" {
				t.Errorf("table %+v", f)
			}
		case RoleCaptioned:
			captioned++
			if f.RoleLabel != "Copies with captions" || !strings.Contains(f.Path, WithCaptionsDir) {
				t.Errorf("captioned %+v", f)
			}
		default:
			t.Errorf("unexpected file %+v", f)
		}
	}
	if table != 1 || captioned != 2 {
		t.Errorf("table %d captioned %d", table, captioned)
	}
	want := map[string]string{
		"alt": "A dog on a table", "caption": "Look at this dog", "hashtags": "#dog #table #day #light #extra",
		"title": "The dog", "description": "A dog rests on a table. It is daytime.", "keywords": "dog, table", "name": "dog on table",
	}
	if !reflect.DeepEqual(res.Vars, want) {
		t.Errorf("vars %v", res.Vars)
	}
	// Renamed copies get their own label; every declared variable is always set.
	o.Then = ThenRenameCopies
	res, _ = e.m.StepOutputs(core.Job{Outputs: outs[2:], OptionsJSON: string(mustJSON(o))})
	if res.Vars["name"] != "" || len(res.Vars) != len(StepVars()) {
		t.Errorf("vars without the batch file: %v", res.Vars)
	}
	if len(res.Files) != 2 || res.Files[0].RoleLabel != "Renamed copies" {
		t.Errorf("files %+v", res.Files)
	}
}
