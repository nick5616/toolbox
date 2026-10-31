package trimmer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/media"
)

func TestDescribeStep(t *testing.T) {
	tests := []struct {
		name    string
		opts    string
		summary string
		problem string
	}{
		{"defaults", ``, "Whole file", ""},
		{"first", `{"keep":"first","seconds":15}`, "First 15 s", ""},
		{"last fast", `{"keep":"last","seconds":10,"mode":"fast"}`, "Last 10 s · fast cut", ""},
		{"range", `{"keep":"range","from":"0:10","to":"1:00"}`, "0:10 – 1:00", ""},
		{"range open end", `{"keep":"range","from":"0:10"}`, "From 0:10", ""},
		{"shape and size", `{"aspect":"9:16","maxSizeMB":50}`, "Whole file · 9:16 · ≤ 50 MB", ""},
		{"height no audio", `{"maxHeight":720,"removeAudio":true}`, "Whole file · ≤ 720p · no audio", ""},
		{"nothing to do", `{"mode":"fast"}`, "", "Nothing to do: pick a part, a shape or a size"},
		{"fast with shape", `{"mode":"fast","aspect":"1:1"}`, "", "Cropping, resizing and size limits need Precise mode"},
		{"zero seconds", `{"keep":"first","seconds":0}`, "", "Seconds to keep must be between 1 and 36,000"},
		{"bad timecode", `{"keep":"range","from":"abc"}`, "", "Use a start time like 1:05 or 1:02:03.5"},
		{"empty range", `{"keep":"range"}`, "", "Set a start or an end time"},
		{"backwards range", `{"keep":"range","from":"1:00","to":"0:30"}`, "", "The end must be after the start"},
		{"bad keep", `{"keep":"middle"}`, "", "Choose which part to keep"},
		{"unknown field", `{"segments":[]}`, "", "Invalid options"},
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
			if len(info.Produces) != 1 || info.Produces[0].Kind != "" || info.Produces[0].Exts != nil || info.Produces[0].Role != "" {
				t.Errorf("produces = %+v, want one main product the same as its input", info.Produces)
			}
			if len(info.Accepts.Extensions) == 0 || info.Accepts.URLs {
				t.Errorf("accepts = %+v", info.Accepts)
			}
		})
	}
}

func TestSegmentFor(t *testing.T) {
	const dur = 60_000
	tests := []struct {
		name       string
		o          StepOptions
		dur        int64
		start, end int64
		short      bool
	}{
		{"whole", StepOptions{Keep: KeepWhole}, dur, 0, dur, false},
		{"first", StepOptions{Keep: KeepFirst, Seconds: 10}, dur, 0, 10_000, false},
		{"first clamped", StepOptions{Keep: KeepFirst, Seconds: 100}, dur, 0, dur, false},
		{"last", StepOptions{Keep: KeepLast, Seconds: 10}, dur, 50_000, dur, false},
		{"last clamped", StepOptions{Keep: KeepLast, Seconds: 100}, dur, 0, dur, false},
		{"range", StepOptions{Keep: KeepRange, From: "0:10", To: "0:20.5"}, dur, 10_000, 20_500, false},
		{"range open start", StepOptions{Keep: KeepRange, To: "30"}, dur, 0, 30_000, false},
		{"range open end", StepOptions{Keep: KeepRange, From: "0:45"}, dur, 45_000, dur, false},
		{"range end clamped", StepOptions{Keep: KeepRange, From: "0:50", To: "2:00"}, dur, 50_000, dur, false},
		{"range past the end", StepOptions{Keep: KeepRange, From: "1:30"}, dur, 90_000, dur, true},
		{"tiny remainder", StepOptions{Keep: KeepRange, From: "0:59.95"}, dur, 59_950, dur, true},
		{"zero length file", StepOptions{Keep: KeepWhole}, 0, 0, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			seg, err := segmentFor(tt.o, tt.dur)
			if tt.short {
				if err == nil || core.AsAppError(err).Message != "This file is shorter than the part to keep" {
					t.Fatalf("err = %v, want the shorter-than message", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if seg.StartMs != tt.start || seg.EndMs != tt.end {
				t.Errorf("segment = %+v, want %d–%d", seg, tt.start, tt.end)
			}
		})
	}
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	long, short := filepath.Join(dir, "long.mp4"), filepath.Join(dir, "short.mp4")
	for _, p := range []string{long, short} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := probeFile
	t.Cleanup(func() { probeFile = old })
	probeFile = func(_ context.Context, ffprobe, path string) (media.Info, error) {
		if ffprobe != "ffprobe-path" {
			t.Errorf("ffprobe = %q", ffprobe)
		}
		d := int64(120_000)
		if path == short {
			d = 5_000
		}
		return media.Info{DurationMs: d, Video: &media.VideoStream{Width: 1920, Height: 1080}}, nil
	}
	m := &Module{resolve: func(string) (string, error) { return "ffprobe-path", nil }}

	req := core.StepRequest{
		Options: json.RawMessage(`{"keep":"last","seconds":20,"aspect":"9:16","maxSizeMB":50}`),
		Item:    core.StepItem{Files: []core.RunFile{{Path: long}}},
	}
	jobs, err := m.PrepareStep(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 1 || jobs[0].Inputs[0] != long {
		t.Fatalf("jobs = %+v", jobs)
	}
	o := jobs[0].Options.(Options)
	if len(o.Segments) != 1 || o.Segments[0] != (Segment{StartMs: 100_000, EndMs: 120_000}) {
		t.Errorf("segments = %+v", o.Segments)
	}
	if o.Mode != ModePrecise || o.Join != JoinMerge || o.Aspect != AspectPortrait || o.MaxSizeMB != 50 || o.CropX != 0.5 {
		t.Errorf("options = %+v", o)
	}

	// Two files make two jobs, each with its own segment.
	req.Item.Files = []core.RunFile{{Path: long}, {Path: long}}
	req.Options = json.RawMessage(`{"keep":"first","seconds":30}`)
	jobs, err = m.PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 2 {
		t.Fatalf("jobs = %d, err = %v", len(jobs), err)
	}

	// A file shorter than the part to keep fails the cell.
	req.Item.Files = []core.RunFile{{Path: short}}
	req.Options = json.RawMessage(`{"keep":"range","from":"0:10"}`)
	if _, err := m.PrepareStep(context.Background(), req); err == nil || core.AsAppError(err).Message != "This file is shorter than the part to keep" {
		t.Fatalf("err = %v", err)
	}

	// Option problems come first.
	req.Options = json.RawMessage(`{"mode":"fast"}`)
	if _, err := m.PrepareStep(context.Background(), req); err == nil {
		t.Error("nothing-to-do options should fail")
	}
}

func TestStepOutputs(t *testing.T) {
	res, err := (&Module{}).StepOutputs(core.Job{Outputs: []core.Output{{ID: "o", Path: "/x/a.mp4", Name: "a.mp4", Kind: core.KindVideo}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Role != "" || res.Files[0].OutputID != "o" {
		t.Errorf("files = %+v", res.Files)
	}
}

func TestParseTimecode(t *testing.T) {
	good := map[string]float64{"5": 5, "1:05": 65, "1:02:03.5": 3723.5, "0:00.25": 0.25}
	for in, want := range good {
		if got, err := parseTimecode(in); err != nil || got != want {
			t.Errorf("parseTimecode(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"", "a", "1:5", "1:75", "1:2:3:4", "1.", "-3"} {
		if _, err := parseTimecode(in); err == nil {
			t.Errorf("parseTimecode(%q) should fail", in)
		}
	}
}
