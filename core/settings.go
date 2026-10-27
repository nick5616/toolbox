package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
)

// NewSettingsService loads settings, writing defaults on first run.
// defaultLibraryDir is used when no library dir is stored yet.
func NewSettingsService(store SettingsStore, em Emitter, defaultLibraryDir string) (*SettingsService, error) {
	if em == nil {
		em = NopEmitter{}
	}
	s := &SettingsService{store: store, em: em}
	ctx := context.Background()

	cur := Settings{LibraryDir: defaultLibraryDir, Concurrency: DefaultConcurrency, Theme: DefaultTheme}
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

// Current returns a snapshot of the settings.
func (s *SettingsService) Current() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
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
	if len(fields) > 0 {
		s.mu.Unlock()
		return old, ValidationError("Some settings are invalid", fields)
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
	s.current = next
	s.em.Emit(EventSettingsChanged, next)
	hooks := append([]func(old, new Settings){}, s.hooks...)
	s.mu.Unlock()

	for _, h := range hooks {
		h(old, next)
	}
	return next, nil
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

// OnChange registers a hook called after every successful Update.
func (s *SettingsService) OnChange(fn func(old, new Settings)) {
	s.mu.Lock()
	s.hooks = append(s.hooks, fn)
	s.mu.Unlock()
}
