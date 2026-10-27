package bpmkey

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
)

func TestValidate(t *testing.T) {
	good := touch(t, "a.flac")
	bad := touch(t, "a.pdf")
	m := &Module{}
	tests := []struct {
		name   string
		inputs []string
		opts   string
		ok     bool
	}{
		{"ok", []string{good}, `{}`, true},
		{"empty options", []string{good}, ``, true},
		{"no inputs", nil, `{}`, false},
		{"bad ext", []string{bad}, `{}`, false},
		{"unknown option", []string{good}, `{"x":1}`, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(tc.inputs, json.RawMessage(tc.opts))
			if tc.ok != (err == nil) {
				t.Fatalf("err = %v", err)
			}
			if err != nil && !core.IsCode(err, core.CodeValidation) {
				t.Fatalf("code: %v", err)
			}
		})
	}
}

func TestRunHappyPath(t *testing.T) {
	input := touch(t, "loop.wav")
	r := &rec{}
	job := newJob(t, r, input, `{}`)
	fc := &fakeCaller{
		events: []sidecar.Event{
			{Kind: "progress", Pct: -1, Msg: "Analysing"},
			{Kind: "log", Line: "err", Level: "error"},
		},
		result: `{"bpm":128,"bpmCandidates":[64,128],"key":"A minor","camelot":"8A","confidence":0.81,
			"alternatives":[{"key":"C major","camelot":"8B","r":0.7}],"durationSec":30.5,"truncated":false,"rssBytes":99}`,
	}
	if err := (&Module{sc: fc}).Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if fc.method != "analysis.bpm_key" || !reflect.DeepEqual(fc.params, map[string]any{"input": input}) {
		t.Fatalf("call %q %v", fc.method, fc.params)
	}
	if r.title != "loop.wav" {
		t.Fatalf("title %q", r.title)
	}
	if !reflect.DeepEqual(r.logs, []string{"stderr:err"}) || r.pcts[0] != -1 {
		t.Fatalf("events %v %v", r.logs, r.pcts)
	}
	if last := len(r.progress) - 1; r.progress[last] != "128.0 BPM · A minor (8A)" || r.pcts[last] != 1 {
		t.Fatalf("progress %v", r.progress)
	}
	var got Result
	if err := json.Unmarshal(r.result, &got); err != nil {
		t.Fatal(err)
	}
	if got.BPM != 128 || got.Camelot != "8A" || got.DurationSec != 30.5 || len(got.Alternatives) != 1 {
		t.Fatalf("result %s", r.result)
	}
	if strings.Contains(string(r.result), "rssBytes") {
		t.Fatal("rssBytes leaked into result")
	}
}

func TestRunErrors(t *testing.T) {
	input := touch(t, "s.wav")
	t.Run("engine missing", func(t *testing.T) {
		r := &rec{toolErr: core.ErrDependencyMissing(sidecar.DepID, "Install it")}
		fc := &fakeCaller{}
		err := (&Module{sc: fc}).Run(context.Background(), newJob(t, r, input, `{}`))
		if err != r.toolErr || fc.calls != 0 {
			t.Fatalf("err %v calls %d", err, fc.calls)
		}
	})
	t.Run("app error passthrough", func(t *testing.T) {
		want := core.Errorf(core.CodeToolFailed, "boom")
		err := (&Module{sc: &fakeCaller{err: want}}).Run(context.Background(), newJob(t, &rec{}, input, `{}`))
		if err != want {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		err := (&Module{sc: &fakeCaller{block: true}}).Run(ctx, newJob(t, &rec{}, input, `{}`))
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	})
}
