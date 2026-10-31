package midi

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
		{"defaults", ``, "MIDI · full range", ""},
		{"bass", `{"range":"bass"}`, "MIDI · bass range", ""},
		{"melody", `{"range":"melody","sensitivity":0.7}`, "MIDI · melody range", ""},
		{"bad sensitivity", `{"sensitivity":2}`, "", "Must be between 0.1 and 0.9"},
		{"bad range", `{"range":"loud"}`, "", "Choose full, bass or melody"},
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
			p := info.Produces
			if len(p) != 1 || p[0].Role != "midi" || p[0].Kind != core.KindOther || len(p[0].Exts) != 1 || p[0].Exts[0] != ".mid" {
				t.Errorf("produces = %+v", p)
			}
			if len(info.Vars) != 1 || info.Vars[0].Name != "notes" {
				t.Errorf("vars = %+v", info.Vars)
			}
		})
	}
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	var files []core.RunFile
	for _, n := range []string{"a.wav", "b.mp3"} {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, core.RunFile{Path: p})
	}
	m := &Module{}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"range":"bass"}`),
		Item:    core.StepItem{Files: files},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Fatalf("jobs = %+v", jobs)
	}
	o := jobs[0].Options.(Options)
	if o.Range != RangeBass || o.Sensitivity != 0.5 || o.NoteFloor != 0.3 || o.MinNoteMs != 127.7 || !o.MelodiaTrick {
		t.Errorf("options = %+v, want unset fields filled from the defaults", o)
	}
}

func TestStepOutputs(t *testing.T) {
	res, err := (&Module{}).StepOutputs(core.Job{
		ResultJSON: `{"notes":212,"pitchRange":[40,76],"durationSec":30}`,
		Outputs:    []core.Output{{ID: "o", Path: "/x/a.mid", Name: "a.mid", Kind: core.KindOther}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Role != "midi" || res.Files[0].RoleLabel != "MIDI" {
		t.Errorf("files = %+v", res.Files)
	}
	if res.Vars["notes"] != "212" {
		t.Errorf("vars = %v", res.Vars)
	}
}
