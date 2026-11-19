package captions

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// CONTRACT STUB (Wave 0): C2 implements validation and every action
// (SPEC.md §5.3–5.4) in this package.

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if o.Action == ActionCaption && len(inputs) == 0 {
		return core.ValidationError("Add photos or videos to caption", nil)
	}
	return nil
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeNotImplemented, "Caption Writer isn't ready yet")
}
