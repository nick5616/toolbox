package lyricvideo

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
)

func stepRaw(t *testing.T, mod func(*StepOptions)) json.RawMessage {
	t.Helper()
	s := DefaultStepOptions()
	if mod != nil {
		mod(&s)
	}
	return mustJSON(t, s)
}

func TestDescribeStep(t *testing.T) {
	tests := []struct {
		name        string
		mod         func(*StepOptions)
		wantProblem string
		wantSummary string
	}{
		{"defaults", nil, "", "Karaoke · 16:9"},
		{"portrait instrumental", func(s *StepOptions) { s.Aspect = "9:16"; s.Audio = "instrumental" }, "", "Karaoke · 9:16 · instrumental"},
		{"plain lyrics", func(s *StepOptions) { s.Look.Karaoke = false }, "", "Lyrics · 16:9"},
		{"visualizer without design", func(s *StepOptions) { s.Look.Background = "visualizer" }, "Choose a visual design", ""},
		{"image without file", func(s *StepOptions) { s.Look.Background = "image" }, "Choose a background file", ""},
		{"bad colour", func(s *StepOptions) { s.Look.TextColor = "red" }, "Use a colour", ""},
		{"bad height", func(s *StepOptions) { s.Height = 480 }, "720 or 1080", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, err := (&Module{}).DescribeStep(stepRaw(t, tt.mod))
			if tt.wantProblem == "" {
				if err != nil {
					t.Fatalf("unexpected %v", err)
				}
				if info.Summary != tt.wantSummary {
					t.Errorf("summary %q, want %q", info.Summary, tt.wantSummary)
				}
			} else {
				var ae *core.AppError
				if !errors.As(err, &ae) || ae.Code != core.CodeValidation || !strings.Contains(ae.Message, tt.wantProblem) {
					t.Fatalf("problem %v, want %q", err, tt.wantProblem)
				}
			}
			if !slices.Equal(info.Templates, []string{"/look/title", "/look/artist"}) {
				t.Errorf("templates %v", info.Templates)
			}
			if len(info.Produces) != 2 || info.Produces[0].Role != "video" || info.Produces[1].Role != "lyrics" {
				t.Errorf("produces %+v", info.Produces)
			}
			if slices.Contains(info.Accepts.Extensions, ".mp4") {
				t.Errorf("only audio is accepted: %v", info.Accepts.Extensions)
			}
		})
	}
	t.Run("empty options are fine", func(t *testing.T) {
		if _, err := (&Module{}).DescribeStep(json.RawMessage(`{}`)); err != nil {
			t.Errorf("err %v", err)
		}
	})
	t.Run("unknown options", func(t *testing.T) {
		if _, err := (&Module{}).DescribeStep(json.RawMessage(`{"x":1}`)); err == nil {
			t.Error("must reject unknown fields")
		}
	})
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "Song A.mp3")
	b := filepath.Join(dir, "Song B.flac")
	for _, p := range []string{a, b} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := &Module{}
	req := core.StepRequest{
		Options: stepRaw(t, func(s *StepOptions) {
			s.Look.Title = "{title} ({name})"
			s.Look.Artist = "by {item}{missing}"
			s.Language = "fr"
			s.Aspect = "1:1"
		}),
		Item: core.StepItem{
			Label: "Album", Vars: map[string]string{"title": "Nights", "item": "Album"},
			Files: []core.RunFile{{Path: a, Name: "Song A.mp3"}, {Path: b, Name: "Song B.flac"}},
		},
	}
	jobs, err := m.PrepareStep(t.Context(), req)
	if err != nil || len(jobs) != 2 {
		t.Fatalf("jobs %v err %v", jobs, err)
	}
	o, ok := jobs[1].Options.(Options)
	if !ok || jobs[1].Inputs[0] != b {
		t.Fatalf("job %+v", jobs[1])
	}
	if o.Action != ActionAuto || o.Source != SourceDetect || o.Language != "fr" || o.Aspect != "1:1" || o.Height != 1080 {
		t.Errorf("options %+v", o)
	}
	if o.Look.Title != "Nights (Song B)" || o.Look.Artist != "by Album" {
		t.Errorf("title %q artist %q", o.Look.Title, o.Look.Artist)
	}
	if !o.Look.Karaoke || o.Lines == nil {
		t.Errorf("look/lines not carried: %+v", o)
	}
	if err := m.Validate(jobs[0].Inputs, mustJSON(t, jobs[0].Options)); err != nil {
		t.Errorf("Validate rejects the prepared job: %v", err)
	}
	t.Run("empty options take the defaults", func(t *testing.T) {
		jobs, err := m.PrepareStep(t.Context(), core.StepRequest{Options: json.RawMessage(`{}`), Item: core.StepItem{Files: []core.RunFile{{Path: a}}}})
		if err != nil {
			t.Fatal(err)
		}
		o := jobs[0].Options.(Options)
		if o.Audio != "original" || o.Aspect != "16:9" || o.Height != 1080 {
			t.Errorf("options %+v", o)
		}
	})
}

func TestStepOutputs(t *testing.T) {
	job := core.Job{Outputs: []core.Output{
		{ID: "1", Path: "/o/Song (lyric video).mp4", Name: "Song (lyric video).mp4", Kind: core.KindVideo},
		{ID: "2", Path: "/o/Song.lrc", Name: "Song.lrc", Kind: core.KindOther},
	}}
	res, err := (&Module{}).StepOutputs(job)
	if err != nil || len(res.Files) != 2 {
		t.Fatalf("res %+v err %v", res, err)
	}
	if res.Files[0].Role != "video" || res.Files[1].Role != "lyrics" || res.Files[1].RoleLabel != "Lyrics" || res.Files[1].OutputID != "2" {
		t.Errorf("files %+v", res.Files)
	}
}
