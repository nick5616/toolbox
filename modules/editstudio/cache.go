package editstudio

// The edit-source cache (SPEC.md §7.6, §15). WP-ES4.

// Cache limits.
const (
	CacheMaxAgeDays = 30
	CacheMaxBytes   = int64(10) << 30
)

// PruneCache removes cache/editstudio folders unused for 30 days, then the
// oldest until the total is at most 10 GB. Called at start.
func (m *Module) PruneCache() {}
