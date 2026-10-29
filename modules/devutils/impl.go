package devutils

// DU1 owns this file. Foundation stubs only.

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	_, err := core.DecodeOptionsJSON[Options](options)
	return err
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeNotImplemented, "File hashing isn't built yet")
}

func hashText(text string) []HashResult { return []HashResult{} }

func fileBase64(path string) (string, error) {
	return "", core.Errorf(core.CodeNotImplemented, "Not built yet")
}
