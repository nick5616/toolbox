package mediaindex

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// CONTRACT STUB (Wave 0): S6 implements the search-filter job.

func (m *FilterModule) validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[FilterOptions](options)
	if err != nil {
		return err
	}
	if o.Query == "" {
		return core.ValidationError("Describe what to keep", map[string]string{"query": "Describe what to keep"})
	}
	if len(inputs) == 0 {
		return core.ValidationError("There's no file to check", nil)
	}
	return nil
}

func (m *FilterModule) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeNotImplemented, "This step isn't ready yet")
}
