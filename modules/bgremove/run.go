package bgremove

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// validate is implemented by WP-BG1.
func (m *Module) validate(_ []string, _ json.RawMessage) error {
	return nil
}

// run is implemented by WP-BG1.
func (m *Module) run(_ context.Context, _ *core.JobContext) error {
	return core.NotImplemented("Background removal")
}
