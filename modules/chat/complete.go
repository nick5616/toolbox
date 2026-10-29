package chat

// TG1 owns this file (SPEC.md §3.5). Foundation stubs only.

import (
	"context"

	"toolbox/core"
)

// Chat implements core.TextGenerator.
var _ core.TextGenerator = (*Chat)(nil)

// Ready implements core.TextGenerator.
func (c *Chat) Ready() (string, error) {
	return "", core.Errorf(core.CodeNotImplemented, "Local text generation isn't built yet")
}

// Complete implements core.TextGenerator.
func (c *Chat) Complete(ctx context.Context, req core.CompletionRequest) (string, error) {
	return "", core.Errorf(core.CodeNotImplemented, "Local text generation isn't built yet")
}
