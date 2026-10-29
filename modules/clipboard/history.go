package clipboard

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"toolbox/core"
)

// Limits (SPEC.md §4.1).
const (
	maxTextBytes  = 1 << 20
	maxImageBytes = 20 << 20
	previewChars  = 300
	selfCopyTTL   = 3 * time.Second
)

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

	// Injectable for tests; set before Start.
	src        source
	now        func() time.Time
	newTicker  func(d time.Duration) (<-chan time.Time, func())
	backoffMin time.Duration
	backoffMax time.Duration

	mu        sync.Mutex
	openPopup func() error
	paused    bool
	running   bool
	errMsg    string
	started   bool
	cancel    context.CancelFunc
	self      selfCopy

	initMu    sync.Mutex
	initDone  bool
	wg        sync.WaitGroup
	kick      chan struct{}
	pruneKick chan struct{}

	emitMu    sync.Mutex
	lastState *core.ClipboardState
}

// selfCopy remembers an item the app itself just wrote to the clipboard.
type selfCopy struct {
	hash  string
	kind  core.ClipKind
	until time.Time
}

// New builds History. Nothing runs until Start.
func New(cfg Config) *History {
	if cfg.Emitter == nil {
		cfg.Emitter = core.NopEmitter{}
	}
	return &History{
		cfg:        cfg,
		src:        newSystemSource(),
		now:        time.Now,
		newTicker:  realTicker,
		backoffMin: time.Second,
		backoffMax: 30 * time.Second,
		kick:       make(chan struct{}, 1),
		pruneKick:  make(chan struct{}, 1),
	}
}

func realTicker(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

func poke(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func (h *History) settings() core.ClipboardSettings {
	if h.cfg.Settings == nil {
		return core.DefaultClipboardSettings()
	}
	return h.cfg.Settings.Current().Clipboard
}

// Start begins recording if enabled in settings, follows settings changes
// (enable/disable, images, retention) and runs retention hourly. It returns
// immediately; everything stops when ctx is cancelled or Stop is called.
func (h *History) Start(ctx context.Context) {
	h.mu.Lock()
	if h.started {
		h.mu.Unlock()
		return
	}
	h.started = true
	ctx, h.cancel = context.WithCancel(ctx)
	h.mu.Unlock()

	if h.cfg.Settings != nil {
		h.cfg.Settings.OnChange(func(old, next core.Settings) {
			poke(h.kick)
			if old.Clipboard.RetentionDays != next.Clipboard.RetentionDays || old.Clipboard.MaxItems != next.Clipboard.MaxItems {
				poke(h.pruneKick)
			}
		})
	}
	h.publishState()
	h.wg.Add(2)
	go h.control(ctx)
	go h.retention(ctx)
}

// Stop stops the recorder and the retention timer and waits for them.
func (h *History) Stop() {
	h.mu.Lock()
	cancel := h.cancel
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	h.wg.Wait()
}

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

// State reports the recorder state.
func (h *History) State() core.ClipboardState {
	enabled := h.settings().Enabled
	h.mu.Lock()
	defer h.mu.Unlock()
	return core.ClipboardState{Recording: enabled && h.running && !h.paused, Paused: h.paused, Error: h.errMsg}
}

// publishState emits clipboard:state when the state differs from the last
// emitted one.
func (h *History) publishState() {
	h.emitMu.Lock()
	defer h.emitMu.Unlock()
	s := h.State()
	if h.lastState != nil && *h.lastState == s {
		return
	}
	h.lastState = &s
	h.cfg.Emitter.Emit(core.EventClipboardState, s)
}

func (h *History) setStatus(running bool, errMsg string) {
	h.mu.Lock()
	h.running, h.errMsg = running, errMsg
	h.mu.Unlock()
	h.publishState()
}

// Pause stops recording until Resume or restart. Emits clipboard:state.
func (h *History) Pause() error { return h.setPaused(true) }

// Resume restarts recording after Pause. Emits clipboard:state.
func (h *History) Resume() error { return h.setPaused(false) }

func (h *History) setPaused(p bool) error {
	h.mu.Lock()
	h.paused = p
	h.mu.Unlock()
	poke(h.kick)
	h.publishState()
	return nil
}

// List pages through the history.
func (h *History) List(ctx context.Context, q core.ClipQuery) (core.ClipPage, error) {
	return h.cfg.Store.ListClips(ctx, q)
}

func (h *History) ensureInit() error {
	h.initMu.Lock()
	defer h.initMu.Unlock()
	if h.initDone {
		return nil
	}
	if err := h.src.Init(); err != nil {
		return err
	}
	h.initDone = true
	return nil
}

// Copy writes an item back to the system clipboard (self-copy suppressed).
func (h *History) Copy(ctx context.Context, id string) error {
	item, err := h.cfg.Store.GetClip(ctx, id)
	if err != nil {
		return err
	}
	var data []byte
	switch item.Kind {
	case core.ClipImage:
		data, err = os.ReadFile(item.ImagePath)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return core.Errorf(core.CodeNotFound, "The image file is missing")
			}
			return fmt.Errorf("read clip image: %w", err)
		}
	default:
		data = []byte(item.Text)
	}
	if err := h.ensureInit(); err != nil {
		slog.Warn("clipboard unavailable", "err", err)
		return core.Errorf(core.CodeInternal, "Clipboard unavailable")
	}
	h.mu.Lock()
	h.self = selfCopy{hash: item.Hash, kind: item.Kind, until: h.now().Add(selfCopyTTL)}
	h.mu.Unlock()
	if err := h.src.Write(ctx, item.Kind, data); err != nil {
		h.mu.Lock()
		h.self = selfCopy{}
		h.mu.Unlock()
		slog.Warn("clipboard write failed", "err", err)
		return core.Errorf(core.CodeInternal, "Couldn't copy to the clipboard").WithCause(err)
	}
	item, err = h.cfg.Store.TouchClip(ctx, id, h.now().UnixMilli())
	if err != nil {
		return err
	}
	h.cfg.Emitter.Emit(core.EventClipboardAdded, item)
	return nil
}

// CopyText writes plain text to the system clipboard for the app's own Copy
// buttons (SPEC.md §3.10). Unlike Copy it sets no self-copy marker: a copy
// the user asked for belongs in the history, and writing one plain-text
// format through Go means the recorder sees exactly one change.
func (h *History) CopyText(ctx context.Context, text string) error {
	if err := h.ensureInit(); err != nil {
		slog.Warn("clipboard unavailable", "err", err)
		return core.Errorf(core.CodeInternal, "Clipboard unavailable")
	}
	if err := h.src.Write(ctx, core.ClipText, []byte(text)); err != nil {
		slog.Warn("clipboard write failed", "err", err)
		return core.Errorf(core.CodeInternal, "Couldn't copy to the clipboard").WithCause(err)
	}
	return nil
}

// Pin pins or unpins an item; emits clipboard:added with the updated item.
func (h *History) Pin(ctx context.Context, id string, pinned bool) (core.ClipItem, error) {
	item, err := h.cfg.Store.SetPinned(ctx, id, pinned)
	if err != nil {
		return core.ClipItem{}, err
	}
	h.cfg.Emitter.Emit(core.EventClipboardAdded, item)
	return item, nil
}

// Delete removes items and their image files; emits clipboard:removed.
func (h *History) Delete(ctx context.Context, ids []string) error {
	rm, err := h.cfg.Store.DeleteClips(ctx, ids)
	if err != nil {
		return err
	}
	h.afterRemove(rm)
	return nil
}

// Clear removes all (optionally unpinned only) items; emits clipboard:removed.
func (h *History) Clear(ctx context.Context, keepPinned bool) (int, error) {
	rm, err := h.cfg.Store.ClearClips(ctx, keepPinned)
	if err != nil {
		return 0, err
	}
	h.afterRemove(rm)
	return len(rm), nil
}

// afterRemove deletes image files of removed rows and emits clipboard:removed.
func (h *History) afterRemove(rm []core.ClipItem) {
	if len(rm) == 0 {
		return
	}
	ids := make([]string, 0, len(rm))
	for _, it := range rm {
		ids = append(ids, it.ID)
		h.removeImage(it)
	}
	h.cfg.Emitter.Emit(core.EventClipboardRemoved, core.ClipsRemoved{IDs: ids})
}

// removeImage deletes an item's image file, but only inside the clipboard dir.
func (h *History) removeImage(it core.ClipItem) {
	if it.ImagePath == "" || h.cfg.Dir == "" {
		return
	}
	if filepath.Clean(filepath.Dir(it.ImagePath)) != filepath.Clean(h.cfg.Dir) {
		return
	}
	if err := os.Remove(it.ImagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("remove clipboard image", "err", err)
	}
}

// ImageDataURL returns an image item as a PNG data URL (≤ 20 MB).
func (h *History) ImageDataURL(ctx context.Context, id string) (string, error) {
	item, err := h.cfg.Store.GetClip(ctx, id)
	if err != nil {
		return "", err
	}
	if item.Kind != core.ClipImage {
		return "", core.Errorf(core.CodeValidation, "That item isn't an image")
	}
	st, err := os.Stat(item.ImagePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", core.Errorf(core.CodeNotFound, "The image file is missing")
		}
		return "", fmt.Errorf("stat clip image: %w", err)
	}
	if st.Size() > maxImageBytes {
		return "", core.Errorf(core.CodeValidation, "The image is too large to preview")
	}
	b, err := os.ReadFile(item.ImagePath)
	if err != nil {
		return "", fmt.Errorf("read clip image: %w", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b), nil
}
