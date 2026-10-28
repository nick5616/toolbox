package desktop

import (
	"context"
	"errors"
	"testing"

	"toolbox/core"
)

type memStore map[string]string

func (m memStore) GetSetting(_ context.Context, k string) (string, bool, error) {
	v, ok := m[k]
	return v, ok, nil
}
func (m memStore) SetSetting(_ context.Context, k, v string) error { m[k] = v; return nil }

type fakePaster struct {
	perm      string
	remembers int
	pastes    int
	err       error
}

func (f *fakePaster) Remember()                   { f.remembers++ }
func (f *fakePaster) Paste(context.Context) error { f.pastes++; return f.err }
func (f *fakePaster) Permission() string          { return f.perm }
func (f *fakePaster) RequestPermission() error    { return nil }

func pasteShell(t *testing.T, autoPaste bool, fp *fakePaster) *Shell {
	t.Helper()
	svc, err := core.NewSettingsService(memStore{}, core.NopEmitter{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if autoPaste {
		c := core.DefaultClipboardSettings()
		c.AutoPaste = true
		if _, err := svc.Update(context.Background(), core.SettingsPatch{Clipboard: &c}); err != nil {
			t.Fatal(err)
		}
	}
	s := &Shell{o: Options{Settings: svc}, popup: &popup{}, paster: fp}
	s.popup.s = s
	s.pasteAsync = func(f func()) { f() }
	return s
}

func TestPasteAfterCopy(t *testing.T) {
	tests := []struct {
		name      string
		autoPaste bool
		perm      string
		err       error
		pastes    int
	}{
		{"enabled and granted", true, PasteGranted, nil, 1},
		{"setting off", false, PasteGranted, nil, 0},
		{"permission denied", true, PasteDenied, nil, 0},
		{"unsupported", true, PasteUnsupported, nil, 0},
		{"paste error is not fatal", true, PasteGranted, errors.New("gone"), 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fp := &fakePaster{perm: tc.perm, err: tc.err}
			s := pasteShell(t, tc.autoPaste, fp)
			if err := s.PasteAfterCopy(); err != nil {
				t.Fatal(err)
			}
			if fp.pastes != tc.pastes {
				t.Fatalf("pastes = %d, want %d", fp.pastes, tc.pastes)
			}
		})
	}
}

func TestPastePermissionDelegates(t *testing.T) {
	fp := &fakePaster{perm: PasteDenied}
	s := pasteShell(t, false, fp)
	if got := s.PastePermission(); got != PasteDenied {
		t.Fatalf("got %q", got)
	}
	if err := s.RequestPastePermission(); err != nil {
		t.Fatal(err)
	}
	s.rememberForPaste()
	if fp.remembers != 1 {
		t.Fatal("Remember not called")
	}
	if (&Shell{}).PastePermission() != PasteUnsupported {
		t.Fatal("nil paster should be unsupported")
	}
}
