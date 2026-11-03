package editstudio

import (
	"context"

	"toolbox/core"
)

// Edit images: upright, size-capped, HEIC converted (SPEC.md §7.3). WP-ES4.

// Image caps (long side).
const (
	PreviewImageMax = 1920
	ExportImageMax  = 4096
)

// EnsureImage makes (or reuses) the edit image of a photo at a long-side cap.
func (m *Module) EnsureImage(ctx context.Context, job *core.JobContext, path string, maxDim int) (string, error) {
	return "", notBuilt("Edit images")
}

// ImageFor returns an existing edit image, or "".
func (m *Module) ImageFor(path string, maxDim int) string { return "" }
