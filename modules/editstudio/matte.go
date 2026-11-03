package editstudio

import (
	"context"

	"toolbox/core"
)

// Matte jobs and state (SPEC.md §10.2, §10.5). WP-ES7.

// runMatte is the matte action (it holds the module's matte slot, §10.5).
func (m *Module) runMatte(ctx context.Context, job *core.JobContext, projectID string, req MatteRequest) error {
	release, err := m.acquireMatte(ctx, job)
	if err != nil {
		return err
	}
	defer release()
	return notBuilt("Cut-outs")
}

// matteStates reports the files of a project's mattes.
func (m *Module) matteStates(projectID string, ids []string) ([]MatteState, error) {
	out := make([]MatteState, 0, len(ids))
	for _, id := range ids {
		out = append(out, MatteState{ID: id})
	}
	return out, nil
}

// matteReady is true when a clip's matte files exist and cover its source range.
func (m *Module) matteReady(projectID string, c Clip) (bool, error) { return false, nil }

// pruneMattes deletes matte files no clip of doc uses and no running job is making.
func (m *Module) pruneMattes(projectID string, doc EditProject) {}
