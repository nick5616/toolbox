package redact

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	tests := []struct {
		name    string
		opts    string
		summary string
		problem string
	}{
		{"defaults", ``, "Faces & plates · blur", ""},
		{"faces only", `{"plates":false,"style":"solid"}`, "Faces · solid", ""},
		{"plates only", `{"faces":false,"style":"pixelate"}`, "Number plates · pixelate", ""},
		{"neither", `{"faces":false,"plates":false}`, "", "Choose faces, number plates or both"},
		{"strength", `{"strength":11}`, "", "Strength must be between 1 and 10"},
		{"padding", `{"padding":-1}`, "", "Padding must be between 0 and 50%"},
		{"action is not an option", `{"action":"detect"}`, "", "Invalid options"},
	}
	m := &Module{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, err := m.DescribeStep(json.RawMessage(tt.opts))
			if tt.problem != "" {
				if err == nil || core.AsAppError(err).Message != tt.problem {
					t.Fatalf("err = %v, want %q", err, tt.problem)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != tt.summary {
				t.Errorf("summary = %q, want %q", info.Summary, tt.summary)
			}
			if len(info.Produces) != 1 || info.Produces[0].Kind != "" || info.Produces[0].Exts != nil {
				t.Errorf("produces = %+v", info.Produces)
			}
		})
	}
}

func TestPrepareStepGrouping(t *testing.T) {
	dir := t.TempDir()
	mk := func(names ...string) []core.RunFile {
		var fs []core.RunFile
		for _, n := range names {
			p := filepath.Join(dir, n)
			if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
			fs = append(fs, core.RunFile{Path: p})
		}
		return fs
	}
	files := mk("a.jpg", "v1.mp4", "b.png", "v2.mov")
	m := &Module{}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"style":"solid"}`),
		Item:    core.StepItem{Files: files},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 3 {
		t.Fatalf("jobs = %d, want 3 (images together, each video alone)", len(jobs))
	}
	if len(jobs[0].Inputs) != 2 || jobs[0].Inputs[0] != files[0].Path || jobs[0].Inputs[1] != files[2].Path {
		t.Errorf("image job = %v", jobs[0].Inputs)
	}
	if len(jobs[1].Inputs) != 1 || jobs[1].Inputs[0] != files[1].Path || jobs[2].Inputs[0] != files[3].Path {
		t.Errorf("video jobs = %v, %v", jobs[1].Inputs, jobs[2].Inputs)
	}
	o := jobs[0].Options.(Options)
	if o.Action != ActionAuto || o.Style != StyleSolid || !o.Faces || !o.Plates || o.Strength != 6 {
		t.Errorf("options = %+v", o)
	}

	// Only images: one job. A missing file fails with a plain message.
	jobs, err = m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: files[:1]}})
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v, err = %v", jobs, err)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: filepath.Join(dir, "gone.jpg")}}}}); err == nil {
		t.Error("a missing file should be rejected")
	}
}

func TestStepOutputs(t *testing.T) {
	res, err := (&Module{}).StepOutputs(core.Job{Outputs: []core.Output{{ID: "o", Path: "/x/a.jpg", Name: "a.jpg", Kind: core.KindImage}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Role != "" || res.Files[0].Kind != core.KindImage {
		t.Errorf("files = %+v", res.Files)
	}
}
