package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

type memStore struct {
	mu sync.Mutex
	m  map[string]string
}

func newMemStore() *memStore { return &memStore{m: map[string]string{}} }

func (s *memStore) GetSetting(_ context.Context, k string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[k]
	return v, ok, nil
}

func (s *memStore) SetSetting(_ context.Context, k, v string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[k] = v
	return nil
}

func ptr[T any](v T) *T { return &v }

func TestSettingsDefaultsAndPersistence(t *testing.T) {
	st := newMemStore()
	lib := filepath.Join(t.TempDir(), "lib")
	s, err := NewSettingsService(st, NopEmitter{}, lib)
	if err != nil {
		t.Fatal(err)
	}
	want := Settings{LibraryDir: lib, Concurrency: DefaultConcurrency, Theme: DefaultTheme,
		KeepInTray: true, Hotkeys: DefaultHotkeys(), Clipboard: DefaultClipboardSettings(),
		Chat: DefaultChatSettings(), Vault: DefaultVaultSettings()}
	if !reflect.DeepEqual(s.Current(), want) {
		t.Fatalf("defaults: %+v", s.Current())
	}
	if st.m["libraryDir"] == "" || st.m["concurrency"] != "3" || st.m["theme"] != `"dark"` {
		t.Fatalf("defaults not written: %v", st.m)
	}
	newLib := filepath.Join(t.TempDir(), "other")
	if _, err := s.Update(context.Background(), SettingsPatch{LibraryDir: &newLib, Concurrency: ptr(5), Theme: ptr(ThemeLight)}); err != nil {
		t.Fatal(err)
	}
	s2, err := NewSettingsService(st, nil, "ignored")
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.Current(); got.LibraryDir != newLib || got.Concurrency != 5 || got.Theme != ThemeLight {
		t.Fatalf("not persisted: %+v", got)
	}
}

func TestSettingsUpdateValidation(t *testing.T) {
	support := t.TempDir()
	lib := filepath.Join(t.TempDir(), "lib")
	s, _ := NewSettingsService(newMemStore(), NopEmitter{}, lib)
	s.SetSupportDir(support)
	file := filepath.Join(t.TempDir(), "afile")
	if err := writeFile(file); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		patch SettingsPatch
		field string
	}{
		{"relative", SettingsPatch{LibraryDir: ptr("rel/dir")}, "libraryDir"},
		{"empty", SettingsPatch{LibraryDir: ptr("")}, "libraryDir"},
		{"inside support", SettingsPatch{LibraryDir: ptr(filepath.Join(support, "bin", "lib"))}, "libraryDir"},
		{"support itself", SettingsPatch{LibraryDir: ptr(support)}, "libraryDir"},
		{"is a file", SettingsPatch{LibraryDir: ptr(filepath.Join(file, "sub"))}, "libraryDir"},
		{"conc 0", SettingsPatch{Concurrency: ptr(0)}, "concurrency"},
		{"conc 9", SettingsPatch{Concurrency: ptr(9)}, "concurrency"},
		{"theme", SettingsPatch{Theme: ptr(Theme("neon"))}, "theme"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := s.Update(context.Background(), c.patch)
			ae := AsAppError(err)
			if ae == nil || ae.Code != CodeValidation {
				t.Fatalf("want validation error, got %v", err)
			}
			if _, ok := ae.Fields[c.field]; !ok {
				t.Fatalf("fields = %v, want key %s", ae.Fields, c.field)
			}
			if s.Current().LibraryDir != lib || s.Current().Concurrency != DefaultConcurrency {
				t.Fatal("state changed on failure")
			}
		})
	}
	// multiple field errors at once
	_, err := s.Update(context.Background(), SettingsPatch{Concurrency: ptr(99), Theme: ptr(Theme("x"))})
	if ae := AsAppError(err); len(ae.Fields) != 2 {
		t.Fatalf("fields: %v", ae.Fields)
	}
	// boundaries OK
	for _, n := range []int{MinConcurrency, MaxConcurrency} {
		if _, err := s.Update(context.Background(), SettingsPatch{Concurrency: ptr(n)}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSettingsUpdateCreatesLibraryDir(t *testing.T) {
	s, _ := NewSettingsService(newMemStore(), NopEmitter{}, t.TempDir())
	dir := filepath.Join(t.TempDir(), "a", "b")
	got, err := s.Update(context.Background(), SettingsPatch{LibraryDir: &dir})
	if err != nil || got.LibraryDir != dir {
		t.Fatalf("%+v %v", got, err)
	}
	if !dirExists(dir) {
		t.Fatal("dir not created")
	}
}

func TestSettingsEmitAndOnChange(t *testing.T) {
	var events []any
	var names []string
	em := EmitterFunc(func(n string, d any) { names = append(names, n); events = append(events, d) })
	s, _ := NewSettingsService(newMemStore(), em, t.TempDir())
	type pair struct{ old, new Settings }
	var calls []pair
	s.OnChange(func(o, n Settings) {
		calls = append(calls, pair{o, n})
		_ = s.Current() // must not deadlock: hooks run outside the lock
	})
	before := s.Current()
	if _, err := s.Update(context.Background(), SettingsPatch{Theme: ptr(ThemeLight)}); err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != EventSettingsChanged {
		t.Fatalf("events: %v", names)
	}
	if e := events[0].(Settings); e.Theme != ThemeLight {
		t.Fatalf("event payload: %+v", e)
	}
	if len(calls) != 1 || !reflect.DeepEqual(calls[0].old, before) || calls[0].new.Theme != ThemeLight {
		t.Fatalf("hook calls: %+v", calls)
	}
	// failed update fires nothing
	s.Update(context.Background(), SettingsPatch{Concurrency: ptr(0)})
	if len(names) != 1 || len(calls) != 1 {
		t.Fatal("failed update emitted")
	}
}

func TestModuleState(t *testing.T) {
	st := newMemStore()
	s, _ := NewSettingsService(st, NopEmitter{}, t.TempDir())
	ctx := context.Background()
	if v, err := s.ModuleState(ctx, "dl"); err != nil || v != "" {
		t.Fatalf("unset: %q %v", v, err)
	}
	if err := s.SetModuleState(ctx, "dl", `{"a":1}`); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.ModuleState(ctx, "dl"); v != `{"a":1}` {
		t.Fatalf("got %q", v)
	}
	if _, ok := st.m["moduleState:dl"]; !ok {
		t.Fatal("wrong key")
	}
	big := `"` + strings.Repeat("x", 64*1024) + `"`
	for name, tc := range map[string][2]string{
		"empty id":     {"", `{}`},
		"invalid json": {"dl", `{nope`},
		"too large":    {"dl", big},
	} {
		if err := s.SetModuleState(ctx, tc[0], tc[1]); !IsCode(err, CodeValidation) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	ok := `"` + strings.Repeat("x", 64*1024-2) + `"`
	if err := s.SetModuleState(ctx, "dl", ok); err != nil {
		t.Fatalf("exactly 64KB should pass: %v", err)
	}
}

func TestSettingsConcurrent(t *testing.T) {
	s, _ := NewSettingsService(newMemStore(), NopEmitter{}, t.TempDir())
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s.Update(context.Background(), SettingsPatch{Concurrency: ptr(i + 1)})
			s.Current()
		}(i)
	}
	wg.Wait()
}

func writeFile(p string) error { return os.WriteFile(p, []byte("x"), 0o644) }

func dirExists(p string) bool { fi, err := os.Stat(p); return err == nil && fi.IsDir() }

func TestSettingsPhase3Fields(t *testing.T) {
	st := newMemStore()
	s, err := NewSettingsService(st, NopEmitter{}, filepath.Join(t.TempDir(), "lib"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	cur := s.Current()
	if !cur.KeepInTray || cur.StartAtLogin || cur.Clipboard.Enabled || cur.Clipboard.MaxItems != 500 {
		t.Fatalf("defaults: %+v", cur)
	}
	// Current returns a copy of the hotkey map.
	cur.Hotkeys[HotkeyClipboard] = "mutated"
	if s.Current().Hotkeys[HotkeyClipboard] != "CmdOrCtrl+Alt+V" {
		t.Fatal("Current leaked its hotkey map")
	}

	next, err := s.Update(ctx, SettingsPatch{
		KeepInTray: ptr(false), StartAtLogin: ptr(true),
		Hotkeys:   map[string]string{HotkeyQuickOpen: ""},
		Clipboard: &ClipboardSettings{Enabled: true, Images: false, RetentionDays: 7, MaxItems: 50},
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.KeepInTray || !next.StartAtLogin || next.Hotkeys[HotkeyQuickOpen] != "" ||
		next.Hotkeys[HotkeyClipboard] != "CmdOrCtrl+Alt+V" || next.Clipboard.RetentionDays != 7 {
		t.Fatalf("after update: %+v", next)
	}
	// Persisted and reloaded.
	s2, err := NewSettingsService(st, NopEmitter{}, "unused")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s2.Current(), next) {
		t.Fatalf("reloaded %+v, want %+v", s2.Current(), next)
	}
}

func TestSettingsPhase3Validation(t *testing.T) {
	cases := []struct {
		name  string
		patch SettingsPatch
		field string
	}{
		{"unknown action", SettingsPatch{Hotkeys: map[string]string{"nope": "Ctrl+X"}}, "hotkeys.nope"},
		{"no modifier", SettingsPatch{Hotkeys: map[string]string{HotkeyClipboard: "V"}}, "hotkeys.clipboard"},
		{"shift only", SettingsPatch{Hotkeys: map[string]string{HotkeyClipboard: "Shift+V"}}, "hotkeys.clipboard"},
		{"bad modifier", SettingsPatch{Hotkeys: map[string]string{HotkeyClipboard: "Hyper+V"}}, "hotkeys.clipboard"},
		{"bad key", SettingsPatch{Hotkeys: map[string]string{HotkeyClipboard: "Ctrl+Banana"}}, "hotkeys.clipboard"},
		{"duplicate", SettingsPatch{Hotkeys: map[string]string{HotkeyQuickOpen: "cmd+option+v"}}, "hotkeys.quickOpen"},
		{"retention", SettingsPatch{Clipboard: &ClipboardSettings{RetentionDays: 3, MaxItems: 500}}, "clipboard.retentionDays"},
		{"max items low", SettingsPatch{Clipboard: &ClipboardSettings{RetentionDays: 30, MaxItems: 10}}, "clipboard.maxItems"},
		{"max items high", SettingsPatch{Clipboard: &ClipboardSettings{RetentionDays: 0, MaxItems: 5001}}, "clipboard.maxItems"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, err := NewSettingsService(newMemStore(), NopEmitter{}, filepath.Join(t.TempDir(), "lib"))
			if err != nil {
				t.Fatal(err)
			}
			before := s.Current()
			_, err = s.Update(context.Background(), tc.patch)
			var ae *AppError
			if !errors.As(err, &ae) || ae.Code != CodeValidation || ae.Fields[tc.field] == "" {
				t.Fatalf("err = %v (fields %v), want field %q", err, fieldsOf(err), tc.field)
			}
			if !reflect.DeepEqual(s.Current(), before) {
				t.Fatal("settings changed after a failed update")
			}
		})
	}
}

func fieldsOf(err error) map[string]string {
	var ae *AppError
	if errors.As(err, &ae) {
		return ae.Fields
	}
	return nil
}

func TestCanonicalAccelerator(t *testing.T) {
	for in, want := range map[string]string{
		"CmdOrCtrl+Alt+V":     "alt+cmdorctrl+v",
		"Option+Cmd+v":        "alt+cmdorctrl+v",
		"CmdOrCtrl+Alt+Space": "alt+cmdorctrl+space",
		"Ctrl+Shift+F12":      "ctrl+shift+f12",
		"Super+1":             "super+1",
	} {
		got, ok := CanonicalAccelerator(in)
		if !ok || got != want {
			t.Errorf("%q → %q,%v want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "V", "Shift+V", "Ctrl+", "Ctrl+Alt", "Meta+V", "Ctrl+Foo"} {
		if _, ok := CanonicalAccelerator(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestSettingsInvalidStoredHotkeysFallBack(t *testing.T) {
	st := newMemStore()
	st.m["hotkeys"] = `{"clipboard":"Ctrl+Alt+V","quickOpen":"ctrl+alt+v"}` // duplicate
	st.m["clipboard"] = `{"enabled":true,"images":true,"retentionDays":5,"maxItems":500}`
	s, err := NewSettingsService(st, NopEmitter{}, filepath.Join(t.TempDir(), "lib"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.Current().Hotkeys, DefaultHotkeys()) || s.Current().Clipboard != DefaultClipboardSettings() {
		t.Fatalf("got %+v", s.Current())
	}
}

func TestSettingsBeforeChangeCanAbort(t *testing.T) {
	st := newMemStore()
	s, err := NewSettingsService(st, NopEmitter{}, filepath.Join(t.TempDir(), "lib"))
	if err != nil {
		t.Fatal(err)
	}
	fail := true
	s.BeforeChange(func(old, next Settings) error {
		if old.StartAtLogin != next.StartAtLogin && fail {
			return ValidationError("Couldn't change start at login", map[string]string{"startAtLogin": "denied"})
		}
		return nil
	})
	var changed int
	s.OnChange(func(Settings, Settings) { changed++ })
	if _, err := s.Update(context.Background(), SettingsPatch{StartAtLogin: ptr(true)}); !IsCode(err, CodeValidation) {
		t.Fatalf("err = %v", err)
	}
	if s.Current().StartAtLogin || st.m["startAtLogin"] == "true" || changed != 0 {
		t.Fatal("aborted update was applied")
	}
	fail = false
	if next, err := s.Update(context.Background(), SettingsPatch{StartAtLogin: ptr(true)}); err != nil || !next.StartAtLogin || changed != 1 {
		t.Fatalf("second update: %+v %v", next, err)
	}
}

func TestSettingsChatVaultSetup(t *testing.T) {
	st := newMemStore()
	s, err := NewSettingsService(st, NopEmitter{}, filepath.Join(t.TempDir(), "lib"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	bad := []struct {
		name  string
		patch SettingsPatch
		field string
	}{
		{"temperature", SettingsPatch{Chat: ptr(ChatSettings{DefaultModel: "x", Temperature: 2.5, ContextSize: 8192})}, "chat.temperature"},
		{"context", SettingsPatch{Chat: ptr(ChatSettings{DefaultModel: "x", ContextSize: 1000})}, "chat.contextSize"},
		{"model", SettingsPatch{Chat: ptr(ChatSettings{ContextSize: 8192})}, "chat.defaultModel"},
		{"prompt", SettingsPatch{Chat: ptr(ChatSettings{DefaultModel: "x", ContextSize: 8192, SystemPrompt: strings.Repeat("a", 4001)})}, "chat.systemPrompt"},
		{"ollama remote", SettingsPatch{Chat: ptr(ChatSettings{DefaultModel: "x", ContextSize: 8192, OllamaURL: "http://192.168.1.5:11434"})}, "chat.ollamaURL"},
		{"ollama https", SettingsPatch{Chat: ptr(ChatSettings{DefaultModel: "x", ContextSize: 8192, OllamaURL: "https://localhost:11434"})}, "chat.ollamaURL"},
		{"autolock", SettingsPatch{Vault: ptr(VaultSettings{AutoLockMinutes: 7})}, "vault.autoLockMinutes"},
	}
	for _, tc := range bad {
		_, err := s.Update(ctx, tc.patch)
		var ae *AppError
		if !errors.As(err, &ae) || ae.Fields[tc.field] == "" {
			t.Errorf("%s: want field error %q, got %v", tc.name, tc.field, err)
		}
	}
	chat := ChatSettings{DefaultModel: "ollama:llama3", SystemPrompt: "hi", Temperature: 0, ContextSize: 16384, GPU: false, OllamaURL: "http://[::1]:11434"}
	if _, err := s.Update(ctx, SettingsPatch{Chat: &chat, Vault: ptr(VaultSettings{AutoLockMinutes: 0}), Setup: ptr(SetupSettings{Done: true})}); err != nil {
		t.Fatal(err)
	}
	s2, err := NewSettingsService(st, nil, "ignored")
	if err != nil {
		t.Fatal(err)
	}
	got := s2.Current()
	if got.Chat != chat || got.Vault.AutoLockMinutes != 0 || !got.Setup.Done {
		t.Fatalf("not persisted: %+v %+v %+v", got.Chat, got.Vault, got.Setup)
	}
}
