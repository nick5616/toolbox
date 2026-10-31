package bgremove

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	m := new(Module)
	tests := []struct {
		name, opts, summary, role string
	}{
		{"defaults", `{}`, "Balanced · transparent", "cutout"},
		{"white cropped", `{"output":"color","crop":true}`, "Balanced · on white · cropped", "cutout"},
		{"colour", `{"model":"best","output":"color","color":"#112233"}`, "Best · on #112233", "cutout"},
		{"mask", `{"model":"fast","output":"mask"}`, "Fast · mask only", "mask"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := m.DescribeStep(json.RawMessage(tc.opts))
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != tc.summary || info.Together || len(info.Produces) != 1 {
				t.Fatalf("info %+v", info)
			}
			p := info.Produces[0]
			if p.Role != tc.role || p.Kind != core.KindImage || !slices.Equal(p.Exts, []string{".png"}) {
				t.Errorf("product %+v", p)
			}
			if !slices.Contains(info.Accepts.Extensions, ".heic") {
				t.Errorf("accepts %v", info.Accepts.Extensions)
			}
		})
	}
	for _, bad := range []string{`{"model":"huge"}`, `{"output":"color","color":"red"}`, `{"padding":900}`, `{"nope":1}`} {
		if _, err := m.DescribeStep(json.RawMessage(bad)); err == nil || core.AsAppError(err).Code != core.CodeValidation {
			t.Errorf("%s: err = %v", bad, err)
		}
	}
}

func TestPrepareStep(t *testing.T) {
	m := new(Module)
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"output":"mask"}`),
		Item:    core.StepItem{Files: []core.RunFile{{Path: "a.png"}, {Path: "b.jpg"}}},
	})
	if err != nil || len(jobs) != 1 || !slices.Equal(jobs[0].Inputs, []string{"a.png", "b.jpg"}) {
		t.Fatalf("jobs %+v err %v", jobs, err)
	}
	o, ok := jobs[0].Options.(Options)
	if !ok || o.Output != OutputMask || o.Model != ModelBalanced || !o.CleanEdges || o.Padding != 24 {
		t.Errorf("options %+v", jobs[0].Options)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{}`)}); err == nil {
		t.Error("no files should fail")
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{"model":"x"}`), Item: core.StepItem{Files: []core.RunFile{{Path: "a.png"}}}}); err == nil {
		t.Error("bad options should fail")
	}
}

func TestStepOutputs(t *testing.T) {
	m := new(Module)
	outs := []core.Output{{ID: "o1", Path: "/o/a.png", Name: "a.png"}}
	for _, tc := range []struct{ opts, role, label string }{
		{`{"output":"transparent"}`, "cutout", "Cutout"},
		{`{"output":"color","color":"#ffffff"}`, "cutout", "Cutout"},
		{`{"output":"mask"}`, "mask", "Mask"},
	} {
		res, err := m.StepOutputs(core.Job{OptionsJSON: tc.opts, Outputs: outs})
		if err != nil || len(res.Files) != 1 {
			t.Fatalf("res %+v err %v", res, err)
		}
		f := res.Files[0]
		if f.Role != tc.role || f.RoleLabel != tc.label || f.Kind != core.KindImage || f.OutputID != "o1" || f.Path != "/o/a.png" {
			t.Errorf("%s: file %+v", tc.opts, f)
		}
	}
}
