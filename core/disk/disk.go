// Package disk reports free space for the volume holding a path (SPEC.md §7.3).
package disk

import (
	"fmt"
	"os"
	"path/filepath"
)

// Free returns the free (available to the user) and total bytes of the volume
// holding path. A path that doesn't exist yet is resolved through its nearest
// existing parent.
func Free(path string) (free, total uint64, err error) {
	if path == "" {
		return 0, 0, fmt.Errorf("disk free: empty path")
	}
	p, err := filepath.Abs(path)
	if err != nil {
		return 0, 0, fmt.Errorf("disk free: %w", err)
	}
	for {
		if _, serr := os.Stat(p); serr == nil {
			break
		}
		parent := filepath.Dir(p)
		if parent == p {
			return 0, 0, fmt.Errorf("disk free: no existing parent of %s", path)
		}
		p = parent
	}
	free, total, err = freeSpace(p)
	if err != nil {
		return 0, 0, fmt.Errorf("disk free %s: %w", p, err)
	}
	return free, total, nil
}
