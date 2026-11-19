package chat

import "toolbox/core"

// Phase 20 (SPEC.md §5.2): the chat engine learns to see. CONTRACT STUB
// (Wave 0): C1 implements Vision, the --mmproj launch, image parts in
// Complete and model switching.

// Chat implements core.VisionGenerator.
var _ core.VisionGenerator = (*Chat)(nil)

// Vision implements core.VisionGenerator.
func (c *Chat) Vision() (string, error) {
	return "", core.Errorf(core.CodeNotImplemented, "Reading pictures isn't ready yet")
}
