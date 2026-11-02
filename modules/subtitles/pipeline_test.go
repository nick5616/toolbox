package subtitles

import (
	"encoding/json"
	"errors"
	"path/filepath"
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
		name         string
		mod          func(*StepOptions)
		wantProblem  string // substring of the message, "" = fine
		wantSummary  string
		wantProduces []string // roles
	}{
		{"defaults", nil, "", "Burn · classic", []string{"subtitles", "video"}},
		{"boxed limited", func(s *StepOptions) { s.Style = StyleBoxed; s.MaxSizeMB = 50 }, "", "Burn · boxed · ≤ 50 MB", []string{"subtitles", "video"}},
		{"embed", func(s *StepOptions) { s.Video = VideoEmbed; s.Save = nil }, "", "Embed track", []string{"video"}},
		{"save both", func(s *StepOptions) { s.Video = VideoNone; s.Save = []string{"srt", "vtt"} }, "", "Save SRT, VTT", []string{"subtitles"}},
		{"translate", func(s *StepOptions) { s.Video = VideoNone; s.TargetLanguage = "de" }, "", "Save SRT · to German", []string{"subtitles"}},
		{"nothing", func(s *StepOptions) { s.Video = VideoNone; s.Save = nil }, "Choose subtitle files", "Subtitles", []string{}},
		{"bad size", func(s *StepOptions) { s.MaxSizeMB = 5000 }, "between 1 and 4000", "", nil},
		{"bad video", func(s *StepOptions) { s.Video = "gif" }, "Choose no video", "", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, err := (&Module{}).DescribeStep(stepRaw(t, tt.mod))
			if tt.wantProblem == "" {
				if err != nil {
					t.Fatalf("unexpected problem %v", err)
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
			if tt.wantProduces != nil {
				var roles []string
				for _, p := range info.Produces {
					roles = append(roles, p.Role)
				}
				if strings.Join(roles, ",") != strings.Join(tt.wantProduces, ",") {
					t.Errorf("produces %v, want %v", roles, tt.wantProduces)
				}
			}
			if len(info.Vars) != 2 || info.Vars[0].Name != "subtitles" || info.Vars[1].Name != "language" {
				t.Errorf("vars %+v", info.Vars)
			}
		})
	}
	t.Run("rejects unknown options", func(t *testing.T) {
		if _, err := (&Module{}).DescribeStep(json.RawMessage(`{"nope":1}`)); err == nil {
			t.Error("unknown fields must be rejected")
		}
	})
	t.Run("accepts media only", func(t *testing.T) {
		info, _ := (&Module{}).DescribeStep(json.RawMessage(`{}`))
		for _, e := range info.Accepts.Extensions {
			if e == ".srt" || e == ".vtt" {
				t.Errorf("subtitle files are not step inputs: %v", info.Accepts.Extensions)
			}
		}
		if len(info.Accepts.Extensions) == 0 {
			t.Error("no extensions")
		}
	})
	t.Run("warns when translation isn't ready", func(t *testing.T) {
		tg := &fakeTG{readyErr: core.Errorf(core.CodeDependencyMissing, "Download a model")}
		info, err := (&Module{tg: tg}).DescribeStep(stepRaw(t, func(s *StepOptions) { s.TargetLanguage = "fr" }))
		if err != nil || len(info.Warnings) != 1 {
			t.Errorf("err %v warnings %v", err, info.Warnings)
		}
	})
}

func TestPrepareStep(t *testing.T) {
	m := &Module{}
	req := func(raw json.RawMessage, paths ...string) core.StepRequest {
		files := make([]core.RunFile, len(paths))
		for i, p := range paths {
			files[i] = core.RunFile{Path: p, Name: filepath.Base(p)}
		}
		return core.StepRequest{Options: raw, Item: core.StepItem{Files: files}}
	}
	t.Run("one job per file with the auto action", func(t *testing.T) {
		jobs, err := m.PrepareStep(t.Context(), req(stepRaw(t, func(s *StepOptions) {
			s.Save = []string{"srt", "vtt"}
			s.Video = VideoEmbed
			s.TargetLanguage = "es"
			s.MaxSizeMB = 30
		}), writeFile(t, t.TempDir(), "a.mp4", "x"), "b.mkv"))
		if err != nil || len(jobs) != 2 {
			t.Fatalf("jobs %v err %v", jobs, err)
		}
		o, ok := jobs[1].Options.(Options)
		if !ok || jobs[1].Inputs[0] != "b.mkv" || !strings.HasSuffix(jobs[0].Inputs[0], "a.mp4") {
			t.Fatalf("job %+v", jobs[1])
		}
		if o.Action != ActionAuto || strings.Join(o.Formats, ",") != "srt,vtt" || o.Video != VideoEmbed || o.TargetLanguage != "es" || o.MaxSizeMB != 30 {
			t.Errorf("options %+v", o)
		}
		if o.Cues == nil {
			t.Error("cues must be an empty list, not null")
		}
		// The job's Validate must accept them.
		if err := m.Validate(jobs[0].Inputs, mustJSON(t, jobs[0].Options)); err != nil {
			t.Errorf("Validate rejects the prepared job: %v", err)
		}
	})
	t.Run("empty options take the defaults", func(t *testing.T) {
		jobs, err := m.PrepareStep(t.Context(), req(json.RawMessage(`{}`), "a.mp4"))
		if err != nil {
			t.Fatal(err)
		}
		o := jobs[0].Options.(Options)
		if o.Model != "small" || o.Video != VideoBurn || o.Style != StyleClassic || o.MaxLines != 2 {
			t.Errorf("options %+v", o)
		}
	})
	t.Run("audio with an unset visualizer background gets a colour", func(t *testing.T) {
		jobs, _ := m.PrepareStep(t.Context(), req(stepRaw(t, nil), "song.mp3", "film.mp4"))
		if got := jobs[0].Options.(Options).Background; got != "color" {
			t.Errorf("audio background %q", got)
		}
		if got := jobs[1].Options.(Options).Background; got != "visualizer" {
			t.Errorf("video background %q", got)
		}
	})
}

func TestStepOutputs(t *testing.T) {
	dir := t.TempDir()
	srt := writeFile(t, dir, "talk.srt", "1\n00:00:00,000 --> 00:00:01,000\nHello\nthere\n\n2\n00:00:02,000 --> 00:00:03,000\nBye\n")
	vtt := writeFile(t, dir, "talk.vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\nthere\n")
	vid := writeFile(t, dir, "talk (subtitled).mp4", "x")
	res, _ := json.Marshal(Result{Action: ActionAuto, Language: "en", Cues: 2})
	job := core.Job{
		ResultJSON: string(res),
		Outputs: []core.Output{
			{ID: "o1", Path: vtt, Name: "talk.vtt", Kind: core.KindOther},
			{ID: "o2", Path: srt, Name: "talk.srt", Kind: core.KindOther},
			{ID: "o3", Path: vid, Name: "talk (subtitled).mp4", Kind: core.KindVideo},
		},
	}
	out, err := (&Module{}).StepOutputs(job)
	if err != nil {
		t.Fatal(err)
	}
	var roles []string
	for _, f := range out.Files {
		roles = append(roles, f.Role)
		if f.OutputID == "" || f.RoleLabel == "" {
			t.Errorf("file %+v", f)
		}
	}
	if strings.Join(roles, ",") != "subtitles,subtitles,video" {
		t.Errorf("roles %v", roles)
	}
	if got := out.Vars["subtitles"]; got != "Hello there\nBye" {
		t.Errorf("subtitles var %q", got)
	}
	if out.Vars["language"] != "en" {
		t.Errorf("language %q", out.Vars["language"])
	}
	t.Run("video only", func(t *testing.T) {
		out, err := (&Module{}).StepOutputs(core.Job{Outputs: []core.Output{{Path: vid, Name: "v.mp4"}}})
		if err != nil || len(out.Files) != 1 || out.Files[0].Role != "video" || out.Vars["subtitles"] != "" {
			t.Errorf("out %+v err %v", out, err)
		}
	})
}
