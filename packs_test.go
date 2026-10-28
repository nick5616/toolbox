package main

import (
	"slices"
	"testing"

	"toolbox/core"
	"toolbox/core/packs"
	"toolbox/modules/bgremove"
	"toolbox/modules/bpmkey"
	"toolbox/modules/chat"
	"toolbox/modules/clipboard"
	"toolbox/modules/converter"
	"toolbox/modules/downloader"
	"toolbox/modules/exif"
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/pdf"
	"toolbox/modules/placeholders"
	"toolbox/modules/stems"
	"toolbox/modules/transcribe"
	"toolbox/modules/upscale"
	"toolbox/modules/vault"
)

// TestEveryToolIsInOnePack registers every user-facing module the way main.go
// does and checks that each one is built in or unlocked by exactly one pack
// (SPEC.md §7.1), so a new module can't be left out of the setup screen.
func TestEveryToolIsInOnePack(t *testing.T) {
	reg := core.NewRegistry()
	for _, register := range []func() error{
		func() error { return downloader.Register(reg, t.TempDir()) },
		func() error { return stems.Register(reg, nil) },
		func() error { return bpmkey.Register(reg, nil) },
		func() error { return midi.Register(reg, nil) },
		func() error { return converter.Register(reg) },
		func() error { return transcribe.Register(reg, nil, "") },
		func() error { return exif.Register(reg, exif.New(nil)) },
		func() error { return clipboard.Register(reg) },
		func() error { return bgremove.Register(reg, nil, "") },
		func() error { return upscale.Register(reg, nil, "") },
		func() error { return pdf.Register(reg, pdf.New(nil)) },
		func() error { return chat.Register(reg, chat.New(chat.Config{})) },
		func() error { return vault.Register(reg, vault.New(vault.Config{})) },
		func() error { return ocr.Register(reg, nil, nil, "") },
		func() error { return placeholders.Register(reg) },
	} {
		if err := register(); err != nil {
			t.Fatal(err)
		}
	}

	count := map[string]int{}
	for _, p := range packs.Catalog() {
		for _, u := range p.Unlocks {
			count[u.Module]++
		}
	}
	for _, d := range reg.List() {
		if d.Status != core.StatusReady {
			continue // placeholders
		}
		builtIn := slices.Contains(packs.BuiltIn, d.ID)
		switch {
		case builtIn && count[d.ID] > 0:
			t.Errorf("%s is built in and also in a pack", d.ID)
		case !builtIn && count[d.ID] != 1:
			t.Errorf("%s is in %d packs, want exactly 1", d.ID, count[d.ID])
		}
		delete(count, d.ID)
	}
	for id := range count {
		t.Errorf("a pack unlocks %q, which isn't a registered tool", id)
	}
}
