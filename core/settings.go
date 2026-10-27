package core

import (
	"context"
)

// SettingsService loads, validates, persists and broadcasts user settings.
// See SPEC.md §6.1.
//
// CONTRACT STUB (foundation). WP-A replaces the bodies; exported signatures
// are frozen.
type SettingsService struct {
	store   SettingsStore
	em      Emitter
	current Settings
}

// Default setting values.
const (
	DefaultConcurrency = 3
	MinConcurrency     = 1
	MaxConcurrency     = 8
	DefaultTheme       = ThemeDark
)

// NewSettingsService loads settings, writing defaults on first run.
// defaultLibraryDir is used when no library dir is stored yet.
func NewSettingsService(store SettingsStore, em Emitter, defaultLibraryDir string) (*SettingsService, error) {
	return &SettingsService{
		store:   store,
		em:      em,
		current: Settings{LibraryDir: defaultLibraryDir, Concurrency: DefaultConcurrency, Theme: DefaultTheme},
	}, nil
}

// Current returns a snapshot of the settings.
func (s *SettingsService) Current() Settings { return s.current }

// Update validates and applies a patch, persists it, emits settings:changed
// and calls OnChange hooks.
func (s *SettingsService) Update(ctx context.Context, p SettingsPatch) (Settings, error) {
	return s.current, NotImplemented("SettingsService.Update")
}

// ModuleState returns a module's opaque UI state JSON ("" if unset).
func (s *SettingsService) ModuleState(ctx context.Context, moduleID string) (string, error) {
	return "", nil
}

// SetModuleState stores a module's opaque UI state (valid JSON, ≤ 64 KB).
func (s *SettingsService) SetModuleState(ctx context.Context, moduleID, stateJSON string) error {
	return NotImplemented("SettingsService.SetModuleState")
}

// OnChange registers a hook called after every successful Update.
func (s *SettingsService) OnChange(fn func(old, new Settings)) {}
