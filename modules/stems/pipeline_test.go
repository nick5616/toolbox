package stems

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
		roles   []string
		ext     string
		problem string
	}{
		{"defaults", ``, "4 stems · fast · FLAC", []string{"vocals", "drums", "bass", "other"}, ".flac", ""},
		{"vocals best mp3", `{"preset":"vocals-best","format":"mp3"}`, "Vocals + instrumental · best · MP3", []string{"vocals", "instrumental"}, ".mp3", ""},
		{"four best wav", `{"preset":"four-best","format":"wav"}`, "4 stems · best · WAV", []string{"vocals", "drums", "bass", "other"}, ".wav", ""},
		{"bad preset", `{"preset":"nope"}`, "", nil, "", "Choose a valid preset"},
		{"bad format", `{"format":"ogg"}`, "", nil, "", "Choose WAV, FLAC or MP3"},
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
			if len(info.Produces) != len(tt.roles) {
				t.Fatalf("produces = %+v", info.Produces)
			}
			for i, p := range info.Produces {
				if p.Role != tt.roles[i] || p.Kind != core.KindAudio || len(p.Exts) != 1 || p.Exts[0] != tt.ext || p.Label == "" {
					t.Errorf("product %d = %+v", i, p)
				}
			}
		})
	}
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	var files []core.RunFile
	for _, n := range []string{"a.mp3", "b.wav"} {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, core.RunFile{Path: p})
	}
	m := &Module{}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"preset":"vocals-fast"}`),
		Item:    core.StepItem{Files: files},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Fatalf("jobs = %+v, want one submission with both files", jobs)
	}
	if o := jobs[0].Options.(Options); o.Preset != PresetVocalsFast || o.Format != FormatFLAC {
		t.Errorf("options = %+v, want the format filled from the defaults", o)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{"format":"ogg"}`), Item: core.StepItem{Files: files}}); err == nil {
		t.Error("a bad format should be rejected")
	}
}

func TestStepOutputs(t *testing.T) {
	result := `{"preset":"four-fast","model":"m","stems":[` +
		`{"name":"Vocals","path":"/lib/a/a - Vocals.flac"},{"name":"Drums","path":"/lib/a/a - Drums.flac"}]}`
	job := core.Job{
		ResultJSON: result,
		Outputs: []core.Output{
			{ID: "1", Path: "/lib/a/a - Vocals.flac", Name: "a - Vocals.flac", Kind: core.KindAudio},
			{ID: "2", Path: "/lib/a/a - Drums.flac", Name: "a - Drums.flac", Kind: core.KindAudio},
			{ID: "3", Path: "/lib/a/readme.txt", Name: "readme.txt", Kind: core.KindDocument},
		},
	}
	res, err := (&Module{}).StepOutputs(job)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 3 {
		t.Fatalf("files = %+v", res.Files)
	}
	if res.Files[0].Role != "vocals" || res.Files[0].RoleLabel != "Vocals" || res.Files[0].OutputID != "1" {
		t.Errorf("file 0 = %+v", res.Files[0])
	}
	if res.Files[1].Role != "drums" || res.Files[2].Role != "" {
		t.Errorf("roles = %q %q", res.Files[1].Role, res.Files[2].Role)
	}
	if _, err := (&Module{}).StepOutputs(core.Job{ResultJSON: "{"}); err == nil {
		t.Error("an unreadable result should be an error")
	}
}
