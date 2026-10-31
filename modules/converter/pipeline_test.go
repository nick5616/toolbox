package converter

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
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
		accepts []string // extensions that must be accepted
		rejects []string
		problem string
	}{
		{"default mp3", ``, "MP3 · 320 kbps", core.KindAudio, ".mp3", []string{".mp3", ".mp4"}, []string{".png"}, ""},
		{"video with height", `{"preset":"mp4-h264","maxHeight":"720"}`, "MP4 · H.264 · ≤ 720p", core.KindVideo, ".mp4", []string{".mov"}, []string{".mp3", ".png"}, ""},
		{"image with height", `{"preset":"jpeg","maxHeight":"1080"}`, "JPEG · ≤ 1080p", core.KindImage, ".jpg", []string{".heic", ".png"}, []string{".mp4", ".wav"}, ""},
		{"png keep", `{"preset":"png"}`, "PNG", core.KindImage, ".png", []string{".jpg"}, []string{".mp3"}, ""},
		{"audio ignores height", `{"preset":"flac","maxHeight":"480"}`, "FLAC (lossless)", core.KindAudio, ".flac", nil, nil, ""},
		{"unknown preset", `{"preset":"nope"}`, "", "", "", nil, nil, "Choose a format"},
		{"bad height", `{"maxHeight":"999"}`, "", "", "", nil, nil, "Choose a valid maximum height"},
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
			if tt.name != "audio ignores height" && info.Summary != tt.summary {
				t.Errorf("summary = %q, want %q", info.Summary, tt.summary)
			}
			if len(info.Produces) != 1 || info.Produces[0].Kind != tt.kind || !slices.Equal(info.Produces[0].Exts, []string{tt.ext}) {
				t.Errorf("produces = %+v", info.Produces)
			}
			for _, e := range tt.accepts {
				if !slices.Contains(info.Accepts.Extensions, e) {
					t.Errorf("should accept %s", e)
				}
			}
			for _, e := range tt.rejects {
				if slices.Contains(info.Accepts.Extensions, e) {
					t.Errorf("should not accept %s", e)
				}
			}
		})
	}
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	var paths []string
	for _, n := range []string{"a.wav", "b.mp4"} {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
	}
	files := []core.RunFile{{Path: paths[0]}, {Path: paths[1]}}
	m := &Module{}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"preset":"flac"}`),
		Item:    core.StepItem{Files: files},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || !slices.Equal(jobs[0].Inputs, paths) {
		t.Fatalf("jobs = %+v, want one submission with both files", jobs)
	}
	if o := jobs[0].Options.(Options); o.Preset != "flac" || o.MaxHeight != HeightKeep || !o.KeepMetadata {
		t.Errorf("options = %+v, want flac over the defaults", o)
	}

	// An image preset can't take audio: the cell fails with a plain message.
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"preset":"png"}`),
		Item:    core.StepItem{Files: files[:1]},
	}); err == nil {
		t.Error("png from wav should be rejected")
	}
}

func TestStepOutputs(t *testing.T) {
	res, err := (&Module{}).StepOutputs(core.Job{Outputs: []core.Output{{ID: "o", Path: "/x/a.flac", Name: "a.flac", Kind: core.KindAudio}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Role != "" || res.Files[0].OutputID != "o" || res.Files[0].Kind != core.KindAudio {
		t.Errorf("files = %+v", res.Files)
	}
}
