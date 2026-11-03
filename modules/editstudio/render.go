package editstudio

import (
	"context"

	"toolbox/core"
)

// The export job (SPEC.md §12.1). WP-ES8.

// runRender is the render action.
func (m *Module) runRender(ctx context.Context, job *core.JobContext, projectID string) error {
	return notBuilt("Export")
}
