package editstudio

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
	"toolbox/modules/bgremove"
)

func bgSpec() (string, bool) {
	spec, ok := bgremove.SpecFor("balanced")
	return spec.File, ok
}

func TestModelPins(t *testing.T) {
	for preset, p := range matteModelPins {
		if len(p.SHA256) != 64 || p.File == "" || p.URL == "" || p.Bytes <= 0 || p.Label == "" {
			t.Errorf("%s pin is incomplete: %+v", preset, p)
		}
	}
}

func TestModelPresentRemoveAndModels(t *testing.T) {
	m := newTestModule(t)
	if m.ModelPresent(PresetPeople) || m.ModelPresent(PresetSelect) || m.ModelPresent("nope") {
		t.Fatal("nothing is installed yet")
	}
	if got := m.matteModels(); got != (MatteModels{SelectAvailable: true}) {
		t.Errorf("models = %+v", got)
	}
	if err := os.MkdirAll(m.matteModelDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.matteModelPath(PresetPeople), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !m.ModelPresent(PresetPeople) || m.ModelPresent(PresetSelect) {
		t.Error("people only")
	}
	if got := m.matteModels(); !got.People || got.Select || got.Image || !got.SelectAvailable {
		t.Errorf("models = %+v", got)
	}
	// the Image flag follows Background Remover's balanced model
	file, _ := bgSpec()
	if err := os.MkdirAll(bgremove.ModelDir(m.cfg.ModelsDir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bgremove.ModelDir(m.cfg.ModelsDir), file), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !m.matteModels().Image {
		t.Error("image model present")
	}
	if err := m.RemoveModel(PresetPeople); err != nil || m.ModelPresent(PresetPeople) {
		t.Errorf("remove: %v", err)
	}
	if err := m.RemoveModel(PresetPeople); err != nil {
		t.Errorf("removing twice: %v", err)
	}
	if err := m.RemoveModel("nope"); err != nil {
		t.Error(err)
	}
	if filepath.Base(m.matteModelDir()) != "matte" {
		t.Error("models live in <models>/matte")
	}
}

func TestFetchModel(t *testing.T) {
	m := newTestModule(t)
	eng := &fakeEngine{reply: map[string]string{}, events: map[string][]sidecar.Event{
		"matte.prefetch": {{Kind: "progress", Pct: 0.4, Msg: "Downloading model"}},
	}, err: map[string]error{}}
	m.cfg.Engine = eng
	rec := &recorder{}
	job := newJob(t, t.TempDir(), Options{Action: ActionMatte}, rec, nil)

	if err := m.FetchModel(context.Background(), job, "nope"); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("unknown preset: %v", err)
	}
	if err := m.FetchModel(context.Background(), job, PresetSelect); err != nil {
		t.Fatal(err)
	}
	call, ok := eng.last("matte.prefetch")
	if !ok {
		t.Fatal("matte.prefetch not called")
	}
	mdl := call.Params["model"].(map[string]any)
	pin := matteModelPins[PresetSelect]
	if mdl["file"] != pin.File || mdl["sha256"] != pin.SHA256 || mdl["url"] != pin.URL || call.Params["modelDir"] != m.matteModelDir() {
		t.Errorf("params = %v", call.Params)
	}
	if len(rec.progress) == 0 || rec.progress[0] != 0.4 {
		t.Errorf("progress = %v", rec.progress)
	}
	// already installed: no second call
	if err := os.MkdirAll(m.matteModelDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.matteModelPath(PresetSelect), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	n := len(eng.calls)
	if err := m.FetchModel(context.Background(), job, PresetSelect); err != nil || len(eng.calls) != n {
		t.Errorf("installed model must not be fetched again: %v", err)
	}
	m.cfg.Engine = nil
	if err := m.FetchModel(context.Background(), job, PresetPeople); err == nil {
		t.Error("no engine should fail")
	}
}
