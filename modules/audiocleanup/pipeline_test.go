package audiocleanup

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
		{"defaults", ``, "Voice isolation · Hum removal · Rumble filter · Podcast loudness", ""},
		{"light mp3", `{"denoise":"light","hum":"off","highPass":false,"loudness":"streaming","format":"mp3"}`, "Light noise reduction · Streaming loudness · MP3", ""},
		{"hum 50", `{"hum":"50","denoise":"off","highPass":false,"loudness":"off"}`, "50 Hz hum removal", ""},
		{"nothing", `{"hum":"off","denoise":"off","highPass":false,"loudness":"off"}`, "No cleanup", ""},
		{"bad denoise", `{"denoise":"max"}`, "", "Choose off, light, strong or voice isolation"},
		{"preview is not an option", `{"preview":true}`, "", "Invalid options"},
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
				t.Errorf("produces = %+v, want the same as input", info.Produces)
			}
			if len(info.Accepts.Extensions) == 0 {
				t.Error("accepts nothing")
			}
		})
	}
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	var files []core.RunFile
	var paths []string
	for _, n := range []string{"a.wav", "b.mp4"} {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, core.RunFile{Path: p})
		paths = append(paths, p)
	}
	m := &Module{}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"denoise":"light","format":"flac"}`),
		Item:    core.StepItem{Files: files},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 || jobs[0].Inputs[0] != paths[0] {
		t.Fatalf("jobs = %+v, want one submission with both files", jobs)
	}
	o := jobs[0].Options.(Options)
	if o.Preview || o.PreviewStartMs != 0 || o.Denoise != DenoiseLight || o.Format != FormatFLAC || !o.HighPass || o.Loudness != LoudnessPodcast {
		t.Errorf("options = %+v", o)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: filepath.Join(dir, "x.txt")}}}}); err == nil {
		t.Error("a missing/unsupported file should be rejected")
	}
}

func TestStepOutputs(t *testing.T) {
	res, err := (&Module{}).StepOutputs(core.Job{Outputs: []core.Output{{ID: "o", Path: "/x/a.wav", Name: "a.wav", Kind: core.KindAudio}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Role != "" || res.Files[0].OutputID != "o" {
		t.Errorf("files = %+v", res.Files)
	}
}
