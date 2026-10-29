package eraser

// ER1 owns this file. Foundation stubs only; the pinned models are in
// SPEC.md §0.4.

import (
	"context"

	"toolbox/core"
)

func (m *Module) modelPresent(preset string) bool { return false }

func (m *Module) fetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	return core.Errorf(core.CodeNotImplemented, "Object Eraser isn't built yet")
}

func (m *Module) removeModel(preset string) error { return nil }

func (m *Module) modelStatus() []ModelInfo { return []ModelInfo{} }
