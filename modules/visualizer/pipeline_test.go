package visualizer

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/viz"
)

func stepRaw(t *testing.T, mod func(*StepOptions)) json.RawMessage {
	t.Helper()
	s := DefaultStepOptions()
	s.ShowJSON = `{"layers":[]}`
	s.DesignName = "Golden Hour"
	if mod != nil {
		mod(&s)
	}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDescribeStep(t *testing.T) {
	tests := []struct {
		name        string
		mod         func(*StepOptions)
		wantProblem string
		wantSummary string
		wantRoles   string
	}{
		{"defaults with a design", func(s *StepOptions) { s.Aspect = "9:16" }, "", "Golden Hour · 9:16 · 1080p30", "video"},
		{"60 fps", func(s *StepOptions) { s.FPS = 60; s.Height = 720 }, "", "Golden Hour · 16:9 · 720p60", "video"},
		{"preset label", func(s *StepOptions) { s.DesignName = ""; s.PresetID = "neon-pulse" }, "", "neon-pulse · 16:9 · 1080p30", "video"},
		{"overlay", func(s *StepOptions) { s.Mode = ModeOverlay }, "", "Golden Hour · Over the video", "video"},
		{"save stems", func(s *StepOptions) { s.SaveStems = true }, "", "", "video,vocals,drums,bass,other"},
		{"no design", func(s *StepOptions) { s.ShowJSON = "" }, "Pick a design", "", "video"},
		{"blank design", func(s *StepOptions) { s.ShowJSON = "  " }, "Pick a design", "", "video"},
		{"unreadable design", func(s *StepOptions) { s.ShowJSON = "{" }, "couldn't be read", "", "video"},
		{"instrumental without stems", func(s *StepOptions) { s.Audio = "instrumental"; s.Stems = false }, "instrumental needs", "", "video"},
		{"save stems without stems", func(s *StepOptions) { s.Stems = false; s.SaveStems = true }, "needs Separate instruments", "", "video"},
		{"bad fps", func(s *StepOptions) { s.FPS = 24 }, "30 or 60", "", "video"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, err := (&Module{}).DescribeStep(stepRaw(t, tt.mod))
			if tt.wantProblem == "" {
				if err != nil {
					t.Fatalf("unexpected %v", err)
				}
			} else {
				var ae *core.AppError
				if !errors.As(err, &ae) || ae.Code != core.CodeValidation || !strings.Contains(ae.Message, tt.wantProblem) {
					t.Fatalf("problem %v, want %q", err, tt.wantProblem)
				}
			}
			if tt.wantSummary != "" && info.Summary != tt.wantSummary {
				t.Errorf("summary %q, want %q", info.Summary, tt.wantSummary)
			}
			var roles []string
			for _, p := range info.Produces {
				roles = append(roles, p.Role)
			}
			if strings.Join(roles, ",") != tt.wantRoles {
				t.Errorf("roles %v, want %s", roles, tt.wantRoles)
			}
		})
	}
	t.Run("overlay warns about the input", func(t *testing.T) {
		info, _ := (&Module{}).DescribeStep(stepRaw(t, func(s *StepOptions) { s.Mode = ModeOverlay }))
		if len(info.Warnings) != 1 {
			t.Errorf("warnings %v", info.Warnings)
		}
	})
	t.Run("empty options ask for a design", func(t *testing.T) {
		_, err := (&Module{}).DescribeStep(json.RawMessage(`{}`))
		if err == nil || !strings.Contains(err.Error(), "Pick a design") {
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
	m, dir := newTestModule(t)
	a := writeFile(t, filepath.Join(dir, "in", "a.mp3"))
	b := writeFile(t, filepath.Join(dir, "in", "b.flac"))
	req := core.StepRequest{
		Options: stepRaw(t, func(s *StepOptions) {
			s.Words, s.Language, s.Mood, s.SaveStems, s.Aspect, s.Height, s.FPS = "detect", "de", true, true, "1:1", 720, 60
			s.Background = "cover"
			s.Audio = "instrumental"
		}),
		Item: core.StepItem{Files: []core.RunFile{{Path: a}, {Path: b}}},
	}
	jobs, err := m.PrepareStep(t.Context(), req)
	if err != nil || len(jobs) != 2 || jobs[1].Inputs[0] != b {
		t.Fatalf("jobs %+v err %v", jobs, err)
	}
	o, ok := jobs[0].Options.(Options)
	if !ok {
		t.Fatalf("options %T", jobs[0].Options)
	}
	if o.Action != ActionAuto || o.ShowJSON == "" || o.Mode != ModeFull || o.Aspect != "1:1" || o.Height != 720 || o.FPS != 60 ||
		o.Audio != "instrumental" || o.Background != "cover" {
		t.Errorf("options %+v", o)
	}
	an := o.Analyze
	if !an.Stems || !an.SaveStems || !an.Mood || an.Words != viz.WordsDetect || an.Language != "de" {
		t.Errorf("analyze %+v", an)
	}
	raw, _ := json.Marshal(o)
	if err := m.Validate(jobs[0].Inputs, raw); err != nil {
		t.Errorf("Validate rejects the prepared job: %v", err)
	}
	t.Run("defaults fill empty options", func(t *testing.T) {
		jobs, err := m.PrepareStep(t.Context(), core.StepRequest{
			Options: json.RawMessage(`{"showJson":"{}"}`), Item: core.StepItem{Files: []core.RunFile{{Path: a}}}})
		if err != nil {
			t.Fatal(err)
		}
		o := jobs[0].Options.(Options)
		if o.Mode != ModeFull || o.Aspect != "16:9" || o.Height != 1080 || o.FPS != 30 || o.Analyze.Words != viz.WordsNone {
			t.Errorf("options %+v", o)
		}
	})
}

func TestStepOutputs(t *testing.T) {
	job := core.Job{Outputs: []core.Output{
		{ID: "1", Path: filepath.Join("lib", "Stems", "Song", "Song - Vocals.flac"), Kind: core.KindAudio},
		{ID: "2", Path: filepath.Join("lib", "Stems", "Song", "Song - Drums.flac"), Kind: core.KindAudio},
		{ID: "3", Path: filepath.Join("lib", "Stems", "Song", "Song - Bass.flac"), Kind: core.KindAudio},
		{ID: "4", Path: filepath.Join("lib", "Stems", "Song", "Song - Other.flac"), Kind: core.KindAudio},
		{ID: "5", Path: filepath.Join("lib", "Song (visualizer).mp4"), Name: "Song (visualizer).mp4", Kind: core.KindVideo},
	}}
	res, err := (&Module{}).StepOutputs(job)
	if err != nil || len(res.Files) != 5 {
		t.Fatalf("res %+v err %v", res, err)
	}
	var roles []string
	for _, f := range res.Files {
		roles = append(roles, f.Role)
		if f.RoleLabel == "" || f.Name == "" || f.OutputID == "" {
			t.Errorf("file %+v", f)
		}
	}
	if got := strings.Join(roles, ","); got != "vocals,drums,bass,other,video" {
		t.Errorf("roles %s", got)
	}
	if res.Files[0].RoleLabel != "Vocals" {
		t.Errorf("label %q", res.Files[0].RoleLabel)
	}
}
