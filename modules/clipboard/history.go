package clipboard

import (
	"context"
	"sync"

	"toolbox/core"
)

// FOUNDATION STUB: WP-CB1 replaces the bodies below (and may add fields,
// unexported helpers and files). Exported names/signatures are frozen.

// Config wires History to the app.
type Config struct {
	Store    core.ClipStore
	Settings *core.SettingsService
	Emitter  core.Emitter
	Dir      string // image files: <support>/clipboard
}

// History owns the recorder, retention and the history operations. Safe for
// concurrent use.
type History struct {
	cfg Config

	mu        sync.Mutex
	openPopup func() error
}

// New builds History. Nothing runs until Start.
func New(cfg Config) *History {
	if cfg.Emitter == nil {
		cfg.Emitter = core.NopEmitter{}
	}
	return &History{cfg: cfg}
}

// Start begins recording if enabled in settings, follows settings changes
// (enable/disable, images, retention) and runs retention hourly. It returns
// immediately; everything stops when ctx is cancelled or Stop is called.
func (h *History) Start(ctx context.Context) {}

// Stop stops the recorder and the retention timer and waits for them.
func (h *History) Stop() {}

// SetPopupOpener sets what OpenPopup calls (the desktop shell's popup toggle).
func (h *History) SetPopupOpener(fn func() error) {
	h.mu.Lock()
	h.openPopup = fn
	h.mu.Unlock()
}

// OpenPopup toggles the popup via the opener set by SetPopupOpener.
func (h *History) OpenPopup() error {
	h.mu.Lock()
	fn := h.openPopup
	h.mu.Unlock()
	if fn == nil {
		return core.Errorf(core.CodeInternal, "The popup isn't available")
	}
	return fn()
}

var errTODO = core.Errorf(core.CodeInternal, "Clipboard history isn't implemented yet")

// State reports the recorder state.
func (h *History) State() core.ClipboardState { return core.ClipboardState{} }

// Pause stops recording until Resume or restart. Emits clipboard:state.
func (h *History) Pause() error { return errTODO }

// Resume restarts recording after Pause. Emits clipboard:state.
func (h *History) Resume() error { return errTODO }

// List pages through the history.
func (h *History) List(ctx context.Context, q core.ClipQuery) (core.ClipPage, error) {
	return core.ClipPage{Items: []core.ClipItem{}}, nil
}

// Copy writes an item back to the system clipboard (self-copy suppressed).
func (h *History) Copy(ctx context.Context, id string) error { return errTODO }

// Pin pins or unpins an item; emits clipboard:added with the updated item.
func (h *History) Pin(ctx context.Context, id string, pinned bool) (core.ClipItem, error) {
	return core.ClipItem{}, errTODO
}

// Delete removes items and their image files; emits clipboard:removed.
func (h *History) Delete(ctx context.Context, ids []string) error { return errTODO }

// Clear removes all (optionally unpinned only) items; emits clipboard:removed.
func (h *History) Clear(ctx context.Context, keepPinned bool) (int, error) { return 0, errTODO }

// ImageDataURL returns an image item as a PNG data URL (≤ 20 MB).
func (h *History) ImageDataURL(ctx context.Context, id string) (string, error) {
	return "", errTODO
}
