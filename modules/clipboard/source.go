package clipboard

import (
	"context"

	"toolbox/core"
)

// change is one clipboard change reported by a source. A non-nil Err is an OS
// clipboard failure (the recorder reports it and retries with backoff).
type change struct {
	Kind      core.ClipKind
	Bytes     []byte
	Sensitive bool
	Err       error
}

// source abstracts the OS clipboard so the recorder can be tested with a
// fake. The real implementation is in system.go.
type source interface {
	// Init prepares the clipboard; an error means it is unavailable
	// (headless etc.).
	Init() error
	// Watch reports changes until ctx is cancelled, then closes the channel.
	// Image changes are only reported when images is true. A channel that
	// closes while ctx is still live is treated as a failure.
	Watch(ctx context.Context, images bool) <-chan change
	// Write puts text (UTF-8) or PNG bytes on the clipboard.
	Write(ctx context.Context, kind core.ClipKind, data []byte) error
}
