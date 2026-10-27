package midi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
)

func optsJSON(t *testing.T, mut func(*Options)) string {
	t.Helper()
	o := DefaultOptions()
	if mut != nil {
		mut(&o)
	}
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mustQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestValidate(t *testing.T) {
	good := touch(t, "a.ogg")
	bad := touch(t, "a.zip")
	m := &Module{}
	tests := []struct {
		name  string
		files []string
		mut   func(*Options)
		field string // "" = ok
	}{
		{"default", []string{good}, nil, ""},
		{"no inputs", nil, nil, "inputs"},
		{"bad file", []string{bad}, nil, "inputs.0"},
		{"sens lo ok", []string{good}, func(o *Options) { o.Sensitivity = 0.1 }, ""},
		{"sens hi ok", []string{good}, func(o *Options) { o.Sensitivity = 0.9 }, ""},
		{"sens low", []string{good}, func(o *Options) { o.Sensitivity = 0.05 }, "sensitivity"},
		{"sens high", []string{good}, func(o *Options) { o.Sensitivity = 0.95 }, "sensitivity"},
		{"floor low", []string{good}, func(o *Options) { o.NoteFloor = 0.09 }, "noteFloor"},
		{"floor high", []string{good}, func(o *Options) { o.NoteFloor = 0.61 }, "noteFloor"},
		{"floor edge", []string{good}, func(o *Options) { o.NoteFloor = 0.6 }, ""},
		{"minms low", []string{good}, func(o *Options) { o.MinNoteMs = 29 }, "minNoteMs"},
		{"minms high", []string{good}, func(o *Options) { o.MinNoteMs = 501 }, "minNoteMs"},
		{"minms edge", []string{good}, func(o *Options) { o.MinNoteMs = 30 }, ""},
		{"range bad", []string{good}, func(o *Options) { o.Range = "treble" }, "range"},
		{"range bass", []string{good}, func(o *Options) { o.Range = RangeBass }, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(tc.files, json.RawMessage(optsJSON(t, tc.mut)))
			if tc.field == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
				t.Fatalf("got %v", err)
			}
			if _, ok := ae.Fields[tc.field]; !ok {
				t.Fatalf("fields %v lack %q", ae.Fields, tc.field)
			}
		})
	}
}

func TestNoteName(t *testing.T) {
	tests := map[int]string{60: "C4", 36: "C2", 79: "G5", 61: "C#4", 21: "A0", 0: "C-1", 127: "G9", 69: "A4"}
	for n, want := range tests {
		if got := noteName(n); got != want {
			t.Errorf("noteName(%d) = %q want %q", n, got, want)
		}
	}
}

func TestRunHappyPath(t *testing.T) {
	input := touch(t, "Tune.mp3")
	tests := []struct {
		name         string
		rng          Range
		minHz, maxHz any
	}{
		{"full", RangeFull, nil, nil},
		{"bass", RangeBass, nil, 400},
		{"melody", RangeMelody, 200, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &rec{}
			job := newJob(t, r, input, optsJSON(t, func(o *Options) { o.Sensitivity = 0.7; o.Range = tc.rng; o.MelodiaTrick = false }))
			out := filepath.Join(job.OutputDir, "Tune.mid")
			fc := &fakeCaller{
				events: []sidecar.Event{{Kind: "output", Path: out}, {Kind: "progress", Pct: 0.3, Msg: "Transcribing"}},
				result: `{"notes":412,"pitchRange":[36,79],"durationSec":61.2,"outputPath":` + mustQuote(out) + `,"rssBytes":1}`,
			}
			if err := (&Module{sc: fc}).Run(context.Background(), job); err != nil {
				t.Fatal(err)
			}
			want := map[string]any{"input": input, "outputPath": out, "onsetThreshold": 0.3,
				"frameThreshold": 0.3, "minNoteMs": 127.7, "minHz": tc.minHz, "maxHz": tc.maxHz, "melodiaTrick": false}
			if fc.method != "midi.transcribe" || !reflect.DeepEqual(fc.params, want) {
				t.Fatalf("call %q\n got %v\nwant %v", fc.method, fc.params, want)
			}
			if !reflect.DeepEqual(r.outputs, []string{out}) {
				t.Fatalf("outputs %v", r.outputs)
			}
			if last := len(r.progress) - 1; r.progress[last] != "412 notes · C2–G5" || r.pcts[last] != 1 {
				t.Fatalf("progress %v", r.progress)
			}
			var got Result
			if err := json.Unmarshal(r.result, &got); err != nil {
				t.Fatal(err)
			}
			if got != (Result{Notes: 412, PitchRange: [2]int{36, 79}, DurationSec: 61.2}) {
				t.Fatalf("result %s", r.result)
			}
			if r.title != "Tune.mp3" {
				t.Fatalf("title %q", r.title)
			}
		})
	}
}

func TestRunNoNotesAndFallbackOutput(t *testing.T) {
	input := touch(t, "Quiet.wav")
	r := &rec{}
	job := newJob(t, r, input, optsJSON(t, nil))
	fc := &fakeCaller{result: `{"notes":0,"pitchRange":[0,0],"durationSec":2}`}
	if err := (&Module{sc: fc}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if last := r.progress[len(r.progress)-1]; last != "No notes found" {
		t.Fatalf("message %q", last)
	}
	if want := filepath.Join(job.OutputDir, "Quiet.mid"); !reflect.DeepEqual(r.outputs, []string{want}) {
		t.Fatalf("outputs %v", r.outputs)
	}
}

func TestRunCollisionNaming(t *testing.T) {
	input := touch(t, "Tune.mp3")
	r := &rec{}
	job := newJob(t, r, input, optsJSON(t, nil))
	for _, n := range []string{"Tune.mid", "Tune (1).mid"} {
		if err := os.WriteFile(filepath.Join(job.OutputDir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fc := &fakeCaller{result: `{"notes":1,"pitchRange":[60,60],"durationSec":1}`}
	if err := (&Module{sc: fc}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(job.OutputDir, "Tune (2).mid")
	if p := fc.params.(map[string]any)["outputPath"]; p != want {
		t.Fatalf("outputPath %v want %v", p, want)
	}
}

func TestRunErrors(t *testing.T) {
	input := touch(t, "s.wav")
	opts := optsJSON(t, nil)
	t.Run("engine missing", func(t *testing.T) {
		r := &rec{toolErr: core.ErrDependencyMissing(sidecar.DepID, "Install it")}
		fc := &fakeCaller{}
		err := (&Module{sc: fc}).Run(context.Background(), newJob(t, r, input, opts))
		if err != r.toolErr || fc.calls != 0 {
			t.Fatalf("err %v calls %d", err, fc.calls)
		}
	})
	t.Run("app error passthrough", func(t *testing.T) {
		want := core.Errorf(core.CodeToolFailed, "boom")
		err := (&Module{sc: &fakeCaller{err: want}}).Run(context.Background(), newJob(t, &rec{}, input, opts))
		if err != want {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		err := (&Module{sc: &fakeCaller{block: true}}).Run(ctx, newJob(t, &rec{}, input, opts))
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	})
}
