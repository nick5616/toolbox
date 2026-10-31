package transcribe

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	tests := []struct {
		name    string
		opts    string
		summary string
		roles   []string
		vars    []string
		problem string
	}{
		{"defaults", ``, "Small model · TXT, SRT", []string{"text", "subtitles"}, []string{"transcript", "transcript_timed", "language"}, ""},
		{"txt only", `{"formats":["txt"]}`, "Small model · TXT", []string{"text"}, []string{"transcript", "language"}, ""},
		{"all, translate", `{"model":"turbo","formats":["txt","srt","vtt","json"],"task":"translate"}`, "Turbo model · TXT, SRT, VTT, JSON · to English", []string{"text", "subtitles", "json"}, []string{"transcript", "transcript_timed", "language"}, ""},
		{"json only", `{"formats":["json"],"model":"base"}`, "Base model · JSON", []string{"json"}, []string{"transcript", "transcript_timed", "language"}, ""},
		{"no formats", `{"formats":[]}`, "", nil, nil, "Choose at least one output format"},
		{"bad model", `{"model":"huge"}`, "", nil, nil, "Choose a valid model"},
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
			var roles, vars []string
			for _, p := range info.Produces {
				roles = append(roles, p.Role)
			}
			for _, v := range info.Vars {
				vars = append(vars, v.Name)
			}
			if !slices.Equal(roles, tt.roles) || !slices.Equal(vars, tt.vars) {
				t.Errorf("roles = %v, vars = %v", roles, vars)
			}
		})
	}

	info, err := m.DescribeStep(json.RawMessage(`{"formats":["srt","vtt"]}`))
	if err != nil {
		t.Fatal(err)
	}
	p := info.Produces[0]
	if !p.Many || !slices.Equal(p.Exts, []string{".srt", ".vtt"}) {
		t.Errorf("subtitles product = %+v", p)
	}
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	var files []core.RunFile
	for _, n := range []string{"a.mp3", "b.mp4"} {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, core.RunFile{Path: p})
	}
	m := &Module{}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"language":"de"}`),
		Item:    core.StepItem{Files: files},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Fatalf("jobs = %+v", jobs)
	}
	o := jobs[0].Options.(Options)
	if o.Language != "de" || o.Model != ModelSmall || o.Task != TaskTranscribe || !slices.Equal(o.Formats, []string{"txt", "srt"}) || !o.VAD {
		t.Errorf("options = %+v, want unset fields filled from the defaults", o)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{"language":"xx"}`), Item: core.StepItem{Files: files}}); err == nil {
		t.Error("an unknown language should be rejected")
	}
}

const srtDoc = "1\r\n00:00:00,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:01:05,000 --> 00:01:08,000\r\nsecond line\r\nof the cue\r\n\r\n3\r\n01:02:03,400 --> 01:02:05,000\r\nLast\r\n"

const vttDoc = "WEBVTT\n\n00:00.000 --> 00:02.500\nHello there\n\nNOTE a comment\n\n01:05.000 --> 01:08.000\nsecond line\nof the cue\n"

const jsonDoc = `{"language":"en","duration":70,"segments":[{"start":0,"end":2.5,"text":" Hello there"},{"start":65,"end":68,"text":"second line of the cue"}]}`

func TestStepOutputs(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) core.Output {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return core.Output{ID: name, Path: p, Name: name, Kind: core.KindForPath(p)}
	}
	m := &Module{}

	t.Run("txt and srt", func(t *testing.T) {
		job := core.Job{
			ResultJSON: `{"language":"en","segments":3}`,
			Outputs:    []core.Output{write("a.txt", "Hello there\nsecond line of the cue\nLast\n"), write("a.srt", srtDoc)},
		}
		res, err := m.StepOutputs(job)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Files) != 2 || res.Files[0].Role != "text" || res.Files[1].Role != "subtitles" || res.Files[1].RoleLabel != "Subtitles" {
			t.Errorf("files = %+v", res.Files)
		}
		if res.Vars["transcript"] != "Hello there\nsecond line of the cue\nLast" {
			t.Errorf("transcript = %q", res.Vars["transcript"])
		}
		want := "[0:00:00] Hello there\n[0:01:05] second line of the cue\n[1:02:03] Last"
		if res.Vars["transcript_timed"] != want {
			t.Errorf("transcript_timed = %q", res.Vars["transcript_timed"])
		}
		if res.Vars["language"] != "en" {
			t.Errorf("language = %q", res.Vars["language"])
		}
	})

	t.Run("vtt only: transcript from the cues", func(t *testing.T) {
		res, err := m.StepOutputs(core.Job{Outputs: []core.Output{write("b.vtt", vttDoc)}})
		if err != nil {
			t.Fatal(err)
		}
		if res.Vars["transcript"] != "Hello there\nsecond line of the cue" {
			t.Errorf("transcript = %q", res.Vars["transcript"])
		}
		if res.Vars["transcript_timed"] != "[0:00:00] Hello there\n[0:01:05] second line of the cue" {
			t.Errorf("timed = %q", res.Vars["transcript_timed"])
		}
		if _, ok := res.Vars["language"]; ok {
			t.Error("no result, no language")
		}
	})

	t.Run("json only", func(t *testing.T) {
		res, err := m.StepOutputs(core.Job{Outputs: []core.Output{write("c.json", jsonDoc)}})
		if err != nil {
			t.Fatal(err)
		}
		if res.Files[0].Role != "json" || res.Files[0].RoleLabel != "JSON" {
			t.Errorf("file = %+v", res.Files[0])
		}
		if res.Vars["transcript"] != "Hello there\nsecond line of the cue" || !strings.HasPrefix(res.Vars["transcript_timed"], "[0:00:00] Hello there\n[0:01:05]") {
			t.Errorf("vars = %v", res.Vars)
		}
	})

	t.Run("txt only has no timed text", func(t *testing.T) {
		res, err := m.StepOutputs(core.Job{Outputs: []core.Output{write("d.txt", "just text\n")}})
		if err != nil {
			t.Fatal(err)
		}
		if res.Vars["transcript"] != "just text" {
			t.Errorf("transcript = %q", res.Vars["transcript"])
		}
		if _, ok := res.Vars["transcript_timed"]; ok {
			t.Error("transcript_timed needs srt, vtt or json")
		}
	})

	t.Run("a huge transcript is capped", func(t *testing.T) {
		big := strings.Repeat("word ", 400_000) // ~2 MB
		res, err := m.StepOutputs(core.Job{Outputs: []core.Output{write("e.txt", big)}})
		if err != nil {
			t.Fatal(err)
		}
		if n := len(res.Vars["transcript"]); n == 0 || n > core.MaxVarBytes {
			t.Errorf("transcript length = %d", n)
		}
	})
}
