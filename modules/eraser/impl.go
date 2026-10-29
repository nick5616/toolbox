package eraser

// ER1 owns this file and models.go. Foundation stubs only.

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
	return core.Errorf(core.CodeNotImplemented, "Object Eraser isn't built yet")
}

func (m *Module) erase(jobs *core.Jobs, input, maskPNG string, opts Options) (core.Job, error) {
	return core.Job{}, core.Errorf(core.CodeNotImplemented, "Object Eraser isn't built yet")
}

func (m *Module) clearMasks() {}
