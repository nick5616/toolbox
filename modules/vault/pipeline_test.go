package vault

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	m := &Module{v: newFixture(t).v}
	tests := []struct {
		name, opts, summary string
		bad                 bool
	}{
		{"root", `{}`, "Add to the Vault", false},
		{"empty", ``, "Add to the Vault", false},
		{"folder", `{"folder":"Documents"}`, "Add to Vault › Documents", false},
		{"template folder", `{"folder":"{year}"}`, "Add to Vault › {year}", false},
		{"bad folder", `{"folder":"a/b"}`, "", true},
		{"unknown field", `{"folder":"","x":1}`, "", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := m.DescribeStep(json.RawMessage(tc.opts))
			if tc.bad {
				if !isCode(err, core.CodeValidation) {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != tc.summary || !info.Accepts.Any || info.Together || len(info.Produces) != 0 ||
				!slices.Equal(info.Templates, []string{"/folder"}) {
				t.Errorf("info %+v", info)
			}
		})
	}
}

func isCode(err error, code core.ErrorCode) bool {
	ae := core.AsAppError(err)
	return ae != nil && ae.Code == code
}

func TestPrepareStep(t *testing.T) {
	f := newFixture(t)
	m := &Module{v: f.v}
	a, b := f.write("a.txt", []byte("a")), f.write("b.txt", []byte("b"))
	req := core.StepRequest{
		Options: json.RawMessage(`{"folder":"Taxes {year}"}`),
		Item: core.StepItem{
			Files: []core.RunFile{{Path: a}, {Path: b}},
			Vars:  map[string]string{"year": "2026"},
		},
	}
	ctx := context.Background()

	// Not created yet and locked both wait.
	_, err := m.PrepareStep(ctx, req)
	ae := core.AsAppError(err)
	if ae == nil || ae.Code != core.CodeWaiting || ae.Message != "Unlock the Vault to continue" || ae.Hint != "Open the Vault and unlock it" {
		t.Fatalf("locked err = %v", err)
	}

	f.createUnlocked()
	jobs, err := m.PrepareStep(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || !slices.Equal(jobs[0].Inputs, []string{a, b}) {
		t.Fatalf("jobs %+v", jobs)
	}
	o, ok := jobs[0].Options.(Options)
	if !ok || o.Action != ActionAdd || o.Folder != "Taxes 2026" {
		t.Fatalf("options %+v", jobs[0].Options)
	}
	raw, _ := json.Marshal(o)
	if err := m.Validate(jobs[0].Inputs, raw); err != nil {
		t.Errorf("Validate rejects the job: %v", err)
	}

	// Invalid folder after expansion.
	req.Item.Vars["year"] = "a/b"
	if _, err := m.PrepareStep(ctx, req); !isCode(err, core.CodeValidation) {
		t.Errorf("bad folder err = %v", err)
	}

	// Locking again waits again.
	f.v.lock()
	req.Item.Vars["year"] = "2026"
	if _, err := m.PrepareStep(ctx, req); !isCode(err, core.CodeWaiting) {
		t.Errorf("relocked err = %v", err)
	}
}

func TestStepOutputs(t *testing.T) {
	m := &Module{v: newFixture(t).v}
	res, err := m.StepOutputs(core.Job{Inputs: []string{"/x"}})
	if err != nil || len(res.Files) != 0 {
		t.Errorf("res %+v err %v", res, err)
	}
}
