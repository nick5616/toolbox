package mediaindex

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"toolbox/core"
)

func files(paths ...string) []core.RunFile {
	out := make([]core.RunFile, len(paths))
	for i, p := range paths {
		out[i] = core.RunFile{Path: p, Name: p}
	}
	return out
}

func TestPrepareStepExpandsQuery(t *testing.T) {
	e := newEnv(t)
	e.installModel(t)
	raw := json.RawMessage(`{"query":"a {animal} on {name}","match":"both","strength":"good","invert":false}`)
	jobs, err := e.m.PrepareStep(context.Background(), core.StepRequest{
		Options: raw,
		Item:    core.StepItem{Files: files("/x/a.png", "/x/b.png", "/x/a.png"), Vars: map[string]string{"animal": "dog", "name": "grass"}},
	})
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs %v err %v", jobs, err)
	}
	o, ok := jobs[0].Options.(FilterOptions)
	if !ok || o.Query != "a dog on grass" {
		t.Errorf("options %+v", jobs[0].Options)
	}
	if len(jobs[0].Inputs) != 2 {
		t.Errorf("inputs %v (duplicates must collapse)", jobs[0].Inputs)
	}
}

func TestPrepareStepMissingVar(t *testing.T) {
	e := newEnv(t)
	e.installModel(t)
	_, err := e.m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"query":"{subject}"}`),
		Item:    core.StepItem{Files: files("/x/a.png")},
	})
	ae := core.AsAppError(err)
	if ae == nil || ae.Code != core.CodeValidation || !strings.Contains(ae.Message, "subject") {
		t.Fatalf("got %v", err)
	}
}

func TestPrepareStepWaitsForModel(t *testing.T) {
	e := newEnv(t) // no model files
	req := core.StepRequest{Options: json.RawMessage(`{"query":"dog","match":"both"}`), Item: core.StepItem{Files: files("/x/a.png")}}
	_, err := e.m.PrepareStep(context.Background(), req)
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeWaiting || !strings.Contains(ae.Message, "Install Smart search") {
		t.Fatalf("got %v", err)
	}
	// text-only matching needs no picture model
	req.Options = json.RawMessage(`{"query":"dog","match":"text"}`)
	if jobs, err := e.m.PrepareStep(context.Background(), req); err != nil || len(jobs) != 1 {
		t.Fatalf("text: %v %v", jobs, err)
	}
	e.installModel(t)
	req.Options = json.RawMessage(`{"query":"dog","match":"picture"}`)
	if jobs, err := e.m.PrepareStep(context.Background(), req); err != nil || len(jobs) != 1 {
		t.Fatalf("installed: %v %v", jobs, err)
	}
}

func TestPrepareStepNoFilesNoJobs(t *testing.T) {
	e := newEnv(t)
	jobs, err := e.m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{"query":"dog"}`)})
	if err != nil || len(jobs) != 0 {
		t.Fatalf("%v %v", jobs, err)
	}
}

func TestStepOutputs(t *testing.T) {
	m := &FilterModule{}
	res, err := m.StepOutputs(core.Job{ResultJSON: `{"kept":["/x/a.png"],"other":["/x/b.png","/x/c.png"],"matched":1,"best":"Dog"}`})
	if err != nil {
		t.Fatal(err)
	}
	var kept, other []string
	for _, f := range res.Files {
		switch f.Role {
		case RoleKept:
			kept = append(kept, f.Path)
			if f.RoleLabel != "Matching files" {
				t.Errorf("label %q", f.RoleLabel)
			}
		case RoleOther:
			other = append(other, f.Path)
		}
	}
	if len(kept) != 1 || len(other) != 2 || res.Vars[VarMatched] != "1" || res.Vars[VarBest] != "Dog" {
		t.Errorf("%+v", res)
	}
	// "other" left out of an oversized result is derived from the inputs
	res, err = m.StepOutputs(core.Job{Inputs: []string{"/x/a.png", "/x/b.png"}, ResultJSON: `{"kept":["/x/a.png"],"matched":1,"best":""}`})
	if err != nil || len(res.Files) != 2 || res.Files[1].Role != RoleOther || res.Files[1].Path != "/x/b.png" {
		t.Errorf("derived: %+v %v", res, err)
	}
	if _, err := m.StepOutputs(core.Job{}); err == nil {
		t.Error("an empty result must fail")
	}
}

func TestDescribeStepCoversStub(t *testing.T) {
	m := &FilterModule{}
	info, err := m.DescribeStep(json.RawMessage(`{"query":"dog"}`))
	if err != nil || len(info.Produces) != 2 || len(info.Vars) != 2 {
		t.Fatalf("%+v %v", info, err)
	}
}
