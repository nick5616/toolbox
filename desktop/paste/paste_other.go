//go:build !windows && !darwin

package paste

type unsupportedPlatform struct{}

func newPlatform() Platform { return unsupportedPlatform{} }

func (unsupportedPlatform) Foreground() (Target, bool) { return 0, false }
func (unsupportedPlatform) Alive(Target) bool          { return false }
func (unsupportedPlatform) Activate(Target) error      { return ErrUnsupported }
func (unsupportedPlatform) ModifiersHeld() bool        { return false }
func (unsupportedPlatform) SendPaste() error           { return ErrUnsupported }
func (unsupportedPlatform) Permission() string         { return Unsupported }
func (unsupportedPlatform) RequestPermission() error   { return nil }
