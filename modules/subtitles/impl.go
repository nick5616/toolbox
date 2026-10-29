package subtitles

// SB1 owns this file. Foundation stubs only.

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	_, err := core.DecodeOptionsJSON[Options](options)
	return err
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeNotImplemented, "Subtitles isn't built yet")
}

func load(path string) ([]Cue, error) {
	return nil, core.Errorf(core.CodeNotImplemented, "Subtitles isn't built yet")
}

func translationLanguages() []Language { return []Language{} }

func styles() []StyleInfo { return []StyleInfo{} }

func (m *Module) translatorStatus() TranslatorStatus {
	return TranslatorStatus{Error: "Not built yet"}
}
