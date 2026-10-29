package audiocleanup

// AC1 owns this file. Foundation stubs only; the pinned DeepFilterNet3
// tarball is in SPEC.md §0.4.

import (
	"context"

	"toolbox/core"
)

func (m *Module) modelPresent(preset string) bool { return false }

func (m *Module) fetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	return core.Errorf(core.CodeNotImplemented, "Voice isolation isn't built yet")
}

func (m *Module) removeModel(preset string) error { return nil }
