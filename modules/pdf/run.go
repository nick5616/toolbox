package pdf

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// state holds the renderer pool and the password store (WP-PDF1).
type state struct{}

func newState(_ string) *state { return &state{} }

func (s *state) close() {}

// validate is implemented by WP-PDF1.
func (m *Module) validate(_ []string, _ json.RawMessage) error { return nil }

// run is implemented by WP-PDF1.
func (m *Module) run(_ context.Context, _ *core.JobContext) error {
	return core.NotImplemented("PDF Toolkit")
}

func (m *Module) info(_ context.Context, _ string, _ string) (Info, error) {
	return Info{}, core.NotImplemented("PDF info")
}

func (m *Module) thumbnail(_ context.Context, _ string, _, _ int, _ string) (string, error) {
	return "", core.NotImplemented("PDF thumbnails")
}

func (m *Module) enqueue(_ context.Context, _ *core.Jobs, _ []string, _ Options, _, _ string) ([]core.Job, error) {
	return nil, core.NotImplemented("PDF Toolkit")
}
