package pipelines

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
)

func TestNarratedSlideshowWiresTheVoiceIntoTheMusic(t *testing.T) {
	p := template(t, TplNarratedSlideshow).Pipeline
	i := slices.IndexFunc(p.Steps, func(s core.PipelineStep) bool { return s.ID == "slideshow" })
	if i < 0 {
		t.Fatal("no slideshow step")
	}
	s := p.Steps[i]
	if len(s.Binds) != 1 || s.Binds[0] != (core.StepBind{Option: "/music", Var: "speech_file"}) {
		t.Fatalf("binds = %+v", s.Binds)
	}
	if strings.Contains(s.OptionsJSON, "{speech_file}") {
		t.Errorf("options still use the template string: %s", s.OptionsJSON)
	}
	var opts map[string]any
	if err := json.Unmarshal([]byte(s.OptionsJSON), &opts); err != nil {
		t.Fatal(err)
	}
	if v, ok := opts["music"]; !ok || v != "" {
		t.Errorf("music option = %v (present %v), want an empty string to bind into", v, ok)
	}
}

func TestTemplatesNeverCarryNilBindsOrParams(t *testing.T) {
	for _, tpl := range Templates() {
		if tpl.Pipeline.Params == nil {
			t.Errorf("%s: nil params", tpl.ID)
		}
		for _, s := range tpl.Pipeline.Steps {
			if s.Binds == nil {
				t.Errorf("%s/%s: nil binds", tpl.ID, s.ID)
			}
		}
	}
}
