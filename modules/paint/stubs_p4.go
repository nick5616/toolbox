package paint

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// CONTRACT STUBS (Wave 0) owned by P4 (ai.go): implement each function in your
// own files and delete it here; delete this file when it is empty.

// ---- P4 ----

func (m *Module) submitAI(jobs *core.Jobs, projectID string, req AIRequest) (core.Job, error) {
	return core.Job{}, core.NotImplemented("Lab perception tools")
}

func (m *Module) aiResult(jobID string, index int) (string, error) {
	return "", core.NotImplemented("Lab perception tools")
}

func (m *Module) aiStatus() []AIModelInfo {
	reason := "Coming in this phase"
	return []AIModelInfo{
		{Tool: string(OpFill), Needs: []string{}, Reason: reason},
		{Tool: string(OpCutout), Needs: []string{}, Reason: reason},
		{Tool: string(OpSegment), Needs: []string{}, Reason: reason},
		{Tool: string(OpEnhance), Needs: []string{}, Reason: reason},
	}
}

func (m *Module) warm(ctx context.Context) error { return nil }

func (a *AIModule) validate(inputs []string, options json.RawMessage) error {
	return core.NotImplemented("Lab perception tools")
}

func (a *AIModule) run(ctx context.Context, job *core.JobContext) error {
	return core.NotImplemented("Lab perception tools")
}
