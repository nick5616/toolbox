package core

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// SettingsService loads, validates, persists and broadcasts user settings.
// See SPEC.md §6.1.
type SettingsService struct {
	store SettingsStore
	em    Emitter

	mu         sync.Mutex
	current    Settings
	supportDir string
	hooks      []func(old, new Settings)
	preHooks   []func(old, next Settings) error
}

// Default setting values.
const (
	DefaultConcurrency = 3
	MinConcurrency     = 1
	MaxConcurrency     = 8
)

// DefaultTheme is a var (not a const) so the binding generator doesn't add it
// to the TS Theme enum.
var DefaultTheme = ThemeDark

// MaxModuleStateBytes caps a module's stored UI state.
const MaxModuleStateBytes = 64 * 1024

const (
	keyLibraryDir  = "libraryDir"
	keyConcurrency = "concurrency"
	keyTheme       = "theme"
	keyModuleState = "moduleState:"

	keyKeepInTray   = "keepInTray"
	keyStartAtLogin = "startAtLogin"
	keyHotkeys      = "hotkeys"
	keyClipboard    = "clipboard"
)

// DefaultHotkeys returns the default global hotkeys (SPEC.md §3.2).
func DefaultHotkeys() map[string]string {
	return map[string]string{
		HotkeyClipboard: "CmdOrCtrl+Alt+V",
		HotkeyQuickOpen: "CmdOrCtrl+Alt+Space",
	}
}

// HotkeyActions lists the known hotkey actions in UI order.
func HotkeyActions() []string { return []string{HotkeyClipboard, HotkeyQuickOpen} }

// DefaultClipboardSettings: recording is opt-in.
func DefaultClipboardSettings() ClipboardSettings {
	return ClipboardSettings{Enabled: false, Images: true, RetentionDays: 30, MaxItems: 500}
}

// Clipboard history limits.
const (
	MinClipItems = 50
	MaxClipItems = 5000
)

// ClipRetentionDays are the allowed retention choices (0 = forever).
var ClipRetentionDays = []int{1, 7, 30, 90, 0}

// NewSettingsService loads settings, writing defaults on first run.
// defaultLibraryDir is used when no library dir is stored yet.
func NewSettingsService(store SettingsStore, em Emitter, defaultLibraryDir string) (*SettingsService, error) {
	if em == nil {
		em = NopEmitter{}
	}
	s := &SettingsService{store: store, em: em}
	ctx := context.Background()

	cur := Settings{
		LibraryDir: defaultLibraryDir, Concurrency: DefaultConcurrency, Theme: DefaultTheme,
		KeepInTray: true, Hotkeys: DefaultHotkeys(), Clipboard: DefaultClipboardSettings(),
	}
	if err := loadSetting(ctx, store, keyLibraryDir, &cur.LibraryDir, func(v string) bool { return v != "" }); err != nil {
		return nil, err
	}
	if err := loadSetting(ctx, store, keyConcurrency, &cur.Concurrency, func(v int) bool {
		return v >= MinConcurrency && v <= MaxConcurrency
	}); err != nil {
		return nil, err
	}
	if err := loadSetting(ctx, store, keyTheme, &cur.Theme, validTheme); err != nil {
		return nil, err
	}
	always := func(bool) bool { return true }
	if err := loadSetting(ctx, store, keyKeepInTray, &cur.KeepInTray, always); err != nil {
		return nil, err
	}
	if err := loadSetting(ctx, store, keyStartAtLogin, &cur.StartAtLogin, always); err != nil {
		return nil, err
	}
	if err := loadSetting(ctx, store, keyHotkeys, &cur.Hotkeys, func(m map[string]string) bool {
		return m != nil && len(checkHotkeys(m)) == 0
	}); err != nil {
		return nil, err
	}
	// Actions added in later versions start at their defaults.
	for action, accel := range DefaultHotkeys() {
		if _, ok := cur.Hotkeys[action]; !ok {
			cur.Hotkeys[action] = accel
		}
	}
	if err := loadSetting(ctx, store, keyClipboard, &cur.Clipboard, func(c ClipboardSettings) bool {
		return len(checkClipboard(c)) == 0
	}); err != nil {
		return nil, err
	}
	s.current = cur
	return s, nil
}

// loadSetting reads key into dst. A missing, malformed or invalid stored value
// leaves dst at its default and (re)writes the default.
func loadSetting[T any](ctx context.Context, st SettingsStore, key string, dst *T, valid func(T) bool) error {
	raw, ok, err := st.GetSetting(ctx, key)
	if err != nil {
		return fmt.Errorf("load setting %q: %w", key, err)
	}
	if ok {
		var v T
		if json.Unmarshal([]byte(raw), &v) == nil && valid(v) {
			*dst = v
			return nil
		}
	}
	return putSetting(ctx, st, key, *dst)
}

func putSetting(ctx context.Context, st SettingsStore, key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("encode setting %q: %w", key, err)
	}
	if err := st.SetSetting(ctx, key, string(b)); err != nil {
		return fmt.Errorf("save setting %q: %w", key, err)
	}
	return nil
}

func validTheme(t Theme) bool {
	return t == ThemeSystem || t == ThemeDark || t == ThemeLight
}

// SetSupportDir sets the app support directory; a library dir inside it is
// rejected by Update.
func (s *SettingsService) SetSupportDir(dir string) {
	s.mu.Lock()
	s.supportDir = dir
	s.mu.Unlock()
}

// Current returns a snapshot of the settings. The Hotkeys map is a copy.
func (s *SettingsService) Current() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current.clone()
}

func (s Settings) clone() Settings {
	s.Hotkeys = maps.Clone(s.Hotkeys)
	return s
}

// checkHotkeys validates a full hotkey map: known actions, valid
// accelerators, no duplicates. Returns field errors keyed "hotkeys.<action>".
func checkHotkeys(m map[string]string) map[string]string {
	fields := map[string]string{}
	seen := map[string]string{}
	for _, action := range slices.Sorted(maps.Keys(m)) {
		key := "hotkeys." + action
		if !slices.Contains(HotkeyActions(), action) {
			fields[key] = "Unknown shortcut action"
			continue
		}
		accel := m[action]
		if accel == "" {
			continue
		}
		canon, ok := CanonicalAccelerator(accel)
		if !ok {
			fields[key] = "Not a valid shortcut (needs Ctrl/Cmd, Alt or Super plus a key)"
			continue
		}
		if other, dup := seen[canon]; dup {
			fields[key] = "Already used by " + other
			continue
		}
		seen[canon] = action
	}
	return fields
}

func checkClipboard(c ClipboardSettings) map[string]string {
	fields := map[string]string{}
	if !slices.Contains(ClipRetentionDays, c.RetentionDays) {
		fields["clipboard.retentionDays"] = "Must be 1, 7, 30 or 90 days, or forever"
	}
	if c.MaxItems < MinClipItems || c.MaxItems > MaxClipItems {
		fields["clipboard.maxItems"] = fmt.Sprintf("Must be between %d and %d", MinClipItems, MaxClipItems)
	}
	return fields
}

var accelModifiers = map[string]string{
	"cmdorctrl": "cmdorctrl", "cmd": "cmdorctrl", "command": "cmdorctrl",
	"ctrl": "ctrl", "control": "ctrl",
	"optionoralt": "alt", "alt": "alt", "option": "alt",
	"shift": "shift", "super": "super",
}

var accelNamedKeys = func() map[string]bool {
	m := map[string]bool{}
	for _, k := range []string{"backspace", "tab", "return", "enter", "escape", "left", "right", "up", "down",
		"space", "delete", "home", "end", "page up", "page down", "plus"} {
		m[k] = true
	}
	for i := 1; i <= 24; i++ {
		m[fmt.Sprintf("f%d", i)] = true
	}
	return m
}()

// CanonicalAccelerator checks a global-hotkey accelerator in Wails syntax
// ("CmdOrCtrl+Alt+V") and returns a canonical lowercase form for duplicate
// detection. A global hotkey needs a key and at least one of
// CmdOrCtrl/Ctrl/Alt/Super (Shift alone would swallow normal typing).
func CanonicalAccelerator(accel string) (string, bool) {
	parts := strings.Split(accel, "+")
	if len(parts) < 2 {
		return "", false
	}
	key := strings.ToLower(strings.TrimSpace(parts[len(parts)-1]))
	if !(len([]rune(key)) == 1 || accelNamedKeys[key]) {
		return "", false
	}
	mods := map[string]bool{}
	strong := false
	for _, p := range parts[:len(parts)-1] {
		m, ok := accelModifiers[strings.ToLower(strings.TrimSpace(p))]
		if !ok {
			return "", false
		}
		mods[m] = true
		strong = strong || m != "shift"
	}
	if !strong {
		return "", false
	}
	return strings.Join(append(slices.Sorted(maps.Keys(mods)), key), "+"), true
}

// Update validates and applies a patch, persists it, emits settings:changed
// and calls OnChange hooks.
func (s *SettingsService) Update(ctx context.Context, p SettingsPatch) (Settings, error) {
	s.mu.Lock()
	old := s.current
	next := old
	fields := map[string]string{}

	if p.LibraryDir != nil {
		if msg := s.checkLibraryDir(*p.LibraryDir); msg != "" {
			fields["libraryDir"] = msg
		} else {
			next.LibraryDir = filepath.Clean(*p.LibraryDir)
		}
	}
	if p.Concurrency != nil {
		if *p.Concurrency < MinConcurrency || *p.Concurrency > MaxConcurrency {
			fields["concurrency"] = fmt.Sprintf("Must be between %d and %d", MinConcurrency, MaxConcurrency)
		} else {
			next.Concurrency = *p.Concurrency
		}
	}
	if p.Theme != nil {
		if !validTheme(*p.Theme) {
			fields["theme"] = "Must be system, dark or light"
		} else {
			next.Theme = *p.Theme
		}
	}
	if p.KeepInTray != nil {
		next.KeepInTray = *p.KeepInTray
	}
	if p.StartAtLogin != nil {
		next.StartAtLogin = *p.StartAtLogin
	}
	if p.Hotkeys != nil {
		// Entries override the current ones; actions not mentioned keep their value.
		merged := maps.Clone(old.Hotkeys)
		maps.Copy(merged, p.Hotkeys)
		if errs := checkHotkeys(merged); len(errs) > 0 {
			maps.Copy(fields, errs)
		} else {
			next.Hotkeys = merged
		}
	}
	if p.Clipboard != nil {
		if errs := checkClipboard(*p.Clipboard); len(errs) > 0 {
			maps.Copy(fields, errs)
		} else {
			next.Clipboard = *p.Clipboard
		}
	}
	if len(fields) > 0 {
		s.mu.Unlock()
		return old.clone(), ValidationError("Some settings are invalid", fields)
	}

	if next.LibraryDir != old.LibraryDir {
		if err := putSetting(ctx, s.store, keyLibraryDir, next.LibraryDir); err != nil {
			s.mu.Unlock()
			return old, err
		}
	}
	if next.Concurrency != old.Concurrency {
		if err := putSetting(ctx, s.store, keyConcurrency, next.Concurrency); err != nil {
			s.mu.Unlock()
			return old, err
		}
	}
	if next.Theme != old.Theme {
		if err := putSetting(ctx, s.store, keyTheme, next.Theme); err != nil {
			s.mu.Unlock()
			return old, err
		}
	}
	for _, h := range s.preHooks {
		if err := h(old.clone(), next.clone()); err != nil {
			s.mu.Unlock()
			return old.clone(), err
		}
	}
	for _, w := range []struct {
		changed bool
		key     string
		v       any
	}{
		{next.KeepInTray != old.KeepInTray, keyKeepInTray, next.KeepInTray},
		{next.StartAtLogin != old.StartAtLogin, keyStartAtLogin, next.StartAtLogin},
		{!maps.Equal(next.Hotkeys, old.Hotkeys), keyHotkeys, next.Hotkeys},
		{next.Clipboard != old.Clipboard, keyClipboard, next.Clipboard},
	} {
		if !w.changed {
			continue
		}
		if err := putSetting(ctx, s.store, w.key, w.v); err != nil {
			s.mu.Unlock()
			return old.clone(), err
		}
	}
	s.current = next
	s.em.Emit(EventSettingsChanged, next.clone())
	hooks := append([]func(old, new Settings){}, s.hooks...)
	s.mu.Unlock()

	for _, h := range hooks {
		h(old.clone(), next.clone())
	}
	return next.clone(), nil
}

// checkLibraryDir returns a user-facing message, or "" when dir is usable.
func (s *SettingsService) checkLibraryDir(dir string) string {
	if dir == "" || !filepath.IsAbs(dir) {
		return "Must be an absolute folder path"
	}
	if s.supportDir != "" && IsWithin(dir, s.supportDir) {
		return "Can't be inside the app's own data folder"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "Couldn't create this folder"
	}
	f, err := os.CreateTemp(dir, ".toolbox-write-test-*")
	if err != nil {
		return "This folder isn't writable"
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return ""
}

// ModuleState returns a module's opaque UI state JSON ("" if unset).
func (s *SettingsService) ModuleState(ctx context.Context, moduleID string) (string, error) {
	if moduleID == "" {
		return "", ValidationError("Module ID is required", map[string]string{"moduleId": "Required"})
	}
	v, ok, err := s.store.GetSetting(ctx, keyModuleState+moduleID)
	if err != nil {
		return "", fmt.Errorf("load module state: %w", err)
	}
	if !ok {
		return "", nil
	}
	return v, nil
}

// SetModuleState stores a module's opaque UI state (valid JSON, ≤ 64 KB).
func (s *SettingsService) SetModuleState(ctx context.Context, moduleID, stateJSON string) error {
	if moduleID == "" {
		return ValidationError("Module ID is required", map[string]string{"moduleId": "Required"})
	}
	if len(stateJSON) > MaxModuleStateBytes {
		return ValidationError("Module state is too large", map[string]string{"state": "Must be at most 64 KB"})
	}
	if !json.Valid([]byte(stateJSON)) {
		return ValidationError("Module state isn't valid JSON", map[string]string{"state": "Must be valid JSON"})
	}
	if err := s.store.SetSetting(ctx, keyModuleState+moduleID, stateJSON); err != nil {
		return fmt.Errorf("save module state: %w", err)
	}
	return nil
}

// BeforeChange registers a hook that runs during Update after validation and
// before anything is persisted; returning an error aborts the update (use
// ValidationError with a field to show it inline). It runs under the settings
// lock, so it must be quick and must not call back into the service. Used to
// apply OS state that can fail (start at login).
func (s *SettingsService) BeforeChange(fn func(old, next Settings) error) {
	s.mu.Lock()
	s.preHooks = append(s.preHooks, fn)
	s.mu.Unlock()
}

// OnChange registers a hook called after every successful Update.
func (s *SettingsService) OnChange(fn func(old, new Settings)) {
	s.mu.Lock()
	s.hooks = append(s.hooks, fn)
	s.mu.Unlock()
}
