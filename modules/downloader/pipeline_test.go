package downloader

import (
	"context"
	"encoding/json"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	tests := []struct {
		name    string
		opts    string
		summary string
		kind    core.OutputKind
		ext     string
		many    bool
		problem string
	}{
		{"defaults", ``, "Audio · MP3 320", core.KindAudio, ".mp3", false, ""},
		{"video", `{"mode":"video","maxResolution":"720"}`, "Video · up to 720p", core.KindVideo, ".mp4", false, ""},
		{"video best", `{"mode":"video","maxResolution":"best"}`, "Video · best quality", core.KindVideo, ".mp4", false, ""},
		{"flac", `{"audioFormat":"flac"}`, "Audio · FLAC", core.KindAudio, ".flac", false, ""},
		{"wav", `{"audioFormat":"wav"}`, "Audio · WAV", core.KindAudio, ".wav", false, ""},
		{"mp3 best playlist", `{"audioQuality":"best","playlist":true}`, "Audio · MP3 best", core.KindAudio, ".mp3", true, ""},
		{"bad mode", `{"mode":"gif"}`, "", "", "", false, "Choose audio or video"},
		{"unknown field", `{"nope":1}`, "", "", "", false, "Invalid options"},
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
			if !info.Accepts.URLs || len(info.Accepts.Extensions) != 0 {
				t.Errorf("accepts = %+v, want links only", info.Accepts)
			}
			if len(info.Produces) != 1 {
				t.Fatalf("produces = %+v", info.Produces)
			}
			p := info.Produces[0]
			if p.Kind != tt.kind || len(p.Exts) != 1 || p.Exts[0] != tt.ext || p.Many != tt.many || p.Role != "" {
				t.Errorf("product = %+v", p)
			}
			if len(info.Vars) != 2 || info.Vars[0].Name != "title" || info.Vars[1].Name != "url" {
				t.Errorf("vars = %+v", info.Vars)
			}
		})
	}
}

func TestPrepareStep(t *testing.T) {
	m := &Module{}
	files := []core.RunFile{{Path: "https://example.com/a"}, {Path: "https://example.com/b"}}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"mode":"video"}`),
		Item:    core.StepItem{Files: files},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Fatalf("jobs = %+v, want one submission with both links", jobs)
	}
	o := jobs[0].Options.(Options)
	if o.Mode != ModeVideo || o.MaxResolution != Res1080 || o.Playlist {
		t.Errorf("options = %+v, want video over the defaults, no playlist", o)
	}

	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: "/tmp/x.mp3"}}}}); err == nil {
		t.Error("a file path should be rejected")
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{}); err == nil {
		t.Error("no links should be rejected")
	}
}

func TestStepOutputs(t *testing.T) {
	m := &Module{}
	res, err := m.StepOutputs(core.Job{
		Title:  "A song",
		Inputs: []string{"https://example.com/watch?v=1"},
		Outputs: []core.Output{
			{ID: "o1", Path: "/lib/A song.mp3", Name: "A song.mp3", Kind: core.KindAudio},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].OutputID != "o1" || res.Files[0].Role != "" || res.Files[0].Kind != core.KindAudio {
		t.Errorf("files = %+v", res.Files)
	}
	if res.Vars["title"] != "A song" || res.Vars["url"] != "https://example.com/watch?v=1" {
		t.Errorf("vars = %v", res.Vars)
	}
}
