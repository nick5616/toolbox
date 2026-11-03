package editstudio

import (
	"context"

	"toolbox/core"
)

// Shot boundaries (SPEC.md §7.4). WP-ES4.

// EnsureShots finds the shot boundaries (source ms) of a video, cached in shots.json.
func (m *Module) EnsureShots(ctx context.Context, job *core.JobContext, path string, fps int) ([]int64, error) {
	return nil, notBuilt("Shot detection")
}

// ShotsFor returns cached shots, or nil.
func (m *Module) ShotsFor(path string) []int64 { return nil }
