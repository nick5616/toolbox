package lyricvideo

// LV1 owns this file. Foundation stubs only.

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
	return core.Errorf(core.CodeNotImplemented, "Lyric Video isn't built yet")
}

func (m *Module) pruneCache() {}
