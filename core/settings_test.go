package core

import (
	"context"
	"os"
	"path/filepath"
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
	want := Settings{LibraryDir: lib, Concurrency: DefaultConcurrency, Theme: DefaultTheme}
	if s.Current() != want {
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
	if len(calls) != 1 || calls[0].old != before || calls[0].new.Theme != ThemeLight {
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
