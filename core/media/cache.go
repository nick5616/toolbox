package media

// MD1 owns this file (SPEC.md §3.4). Foundation stubs only.

import (
	"context"

	"toolbox/core"
)

func (m *ProxyModule) run(ctx context.Context, job *core.JobContext) error {
	return core.Errorf(core.CodeNotImplemented, "Preview copies aren't built yet")
}

func proxyPath(cacheDir, path string, size, mtimeNs int64, audioOnly bool) string {
	return ""
}

func pruneCache(cacheDir string, limit int64) {}
