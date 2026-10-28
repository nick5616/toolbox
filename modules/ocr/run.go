package ocr

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// validate and run are implemented by OC1 (SPEC.md §5.2–5.3).
func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if _, err := core.DecodeOptionsJSON[Options](options); err != nil {
		return err
	}
	return nil
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeToolFailed, "OCR isn't implemented yet")
}
