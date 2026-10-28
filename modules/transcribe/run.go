package transcribe

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// FOUNDATION STUB: WP-TR1 implements validate and run (SPEC.md §5.2–5.3).

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	_, err := core.DecodeOptionsJSON[Options](options)
	return err
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeInternal, "Transcribe isn't implemented yet")
}
