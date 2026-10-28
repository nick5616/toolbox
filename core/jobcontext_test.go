package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type testOpts struct {
	Mode  string `json:"mode"`
	Count int    `json:"count"`
}

func TestDecodeOptions(t *testing.T) {
	j := NewJobContext(JobContext{Options: json.RawMessage(`{"mode":"audio","count":2}`)}, JobHooks{})
	got, err := DecodeOptions[testOpts](j)
	if err != nil || got.Mode != "audio" || got.Count != 2 {
		t.Fatalf("got %+v, %v", got, err)
	}

	j = NewJobContext(JobContext{Options: json.RawMessage(`{"mode":"audio","extra":1}`)}, JobHooks{})
	if _, err := DecodeOptions[testOpts](j); !IsCode(err, CodeValidation) {
		t.Fatalf("unknown field: err = %v, want validation", err)
	}

	j = NewJobContext(JobContext{}, JobHooks{})
	if got, err := DecodeOptions[testOpts](j); err != nil || got != (testOpts{}) {
		t.Fatalf("empty options: %+v, %v", got, err)
	}
}

func TestJobContextHooks(t *testing.T) {
	var pct float64
	var msg, title string
	var lines []string
	j := NewJobContext(JobContext{ID: "j1"}, JobHooks{
		Progress: func(p float64, m string) { pct, msg = p, m },
		Log:      func(s LogStream, l string) { lines = append(lines, string(s)+":"+l) },
		Title:    func(s string) { title = s },
		Tool:     func(id string) (string, error) { return "/bin/" + id, nil },
	})
	j.Progress(0.5, "half")
	j.Logf("hello %d", 1)
	j.Log(StreamStderr, "warn")
	j.SetTitle("T")
	if pct != 0.5 || msg != "half" || title != "T" {
		t.Fatalf("hooks not called: %v %q %q", pct, msg, title)
	}
	if len(lines) != 2 || lines[0] != "system:hello 1" || lines[1] != "stderr:warn" {
		t.Fatalf("lines = %v", lines)
	}
	if p, err := j.Tool("ffmpeg"); err != nil || p != "/bin/ffmpeg" {
		t.Fatalf("Tool = %q, %v", p, err)
	}

	bare := NewJobContext(JobContext{}, JobHooks{})
	bare.Progress(1, "") // no panic
	if _, err := bare.Tool("x"); !IsCode(err, CodeDependencyMissing) {
		t.Fatalf("bare Tool err = %v", err)
	}
	if _, err := bare.Output("x"); err == nil {
		t.Fatal("bare Output succeeded")
	}
}

func TestNewOutput(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "Song.MP3")
	must(t, os.WriteFile(p, []byte("abc"), 0o644))
	o, err := NewOutput(p, "job1", "downloader")
	if err != nil {
		t.Fatal(err)
	}
	if o.Kind != KindAudio || o.SizeBytes != 3 || o.Name != "Song.MP3" || o.ID == "" {
		t.Fatalf("output = %+v", o)
	}
	if len(o.Tags) != 2 || o.Tags[0] != "module:downloader" || o.Tags[1] != "kind:audio" {
		t.Fatalf("tags = %v", o.Tags)
	}
	if _, err := NewOutput(dir, "", "m"); err == nil {
		t.Fatal("directory accepted as output")
	}
	if KindForPath("a.webm") != KindVideo || KindForPath("a.xyz") != KindOther {
		t.Fatal("KindForPath wrong")
	}
}

func TestJobContextScoped(t *testing.T) {
	var got []float64
	j := NewJobContext(JobContext{ID: "j"}, JobHooks{Progress: func(p float64, _ string) { got = append(got, p) }})
	s := j.Scoped(0.5, 0.75)
	s.Progress(0, "")
	s.Progress(0.5, "")
	s.Progress(2, "")
	s.Progress(IndeterminateProgress, "")
	want := []float64{0.5, 0.625, 0.75, IndeterminateProgress}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if s.ID != "j" {
		t.Fatal("scoped context lost its ID")
	}
}
