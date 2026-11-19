package main

import (
	"slices"
	"testing"

	"toolbox/core"
	corefocus "toolbox/core/focus"
	"toolbox/core/lan"
	"toolbox/core/packs"
	"toolbox/core/viz"
	"toolbox/modules/archiver"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/bgremove"
	"toolbox/modules/bpmkey"
	"toolbox/modules/captions"
	"toolbox/modules/chat"
	"toolbox/modules/clipboard"
	"toolbox/modules/compress"
	"toolbox/modules/converter"
	"toolbox/modules/devutils"
	"toolbox/modules/documents"
	"toolbox/modules/downloader"
	"toolbox/modules/editstudio"
	"toolbox/modules/eraser"
	"toolbox/modules/exif"
	focusmod "toolbox/modules/focus"
	"toolbox/modules/gif"
	"toolbox/modules/imagebatch"
	"toolbox/modules/lanshare"
	"toolbox/modules/lyricvideo"
	"toolbox/modules/mediaindex"
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/organize"
	"toolbox/modules/paint"
	"toolbox/modules/pdf"
	"toolbox/modules/placeholders"
	"toolbox/modules/redact"
	"toolbox/modules/scenes"
	"toolbox/modules/silence"
	"toolbox/modules/stems"
	"toolbox/modules/subtitles"
	"toolbox/modules/transcribe"
	"toolbox/modules/trimmer"
	"toolbox/modules/tts"
	"toolbox/modules/upscale"
	"toolbox/modules/vault"
	"toolbox/modules/visualizer"
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
		func() error { return trimmer.Register(reg, nil) },
		func() error { return scenes.Register(reg) },
		func() error { return gif.Register(reg) },
		func() error { return organize.Register(reg, organize.New(nil)) },
		func() error {
			rt, err := lan.New(lan.Config{Dir: t.TempDir()})
			if err != nil {
				return err
			}
			t.Cleanup(func() { _ = rt.Close() })
			m, r := lanshare.New(rt)
			return lanshare.Register(reg, m, r)
		},
		func() error { return silence.Register(reg, nil) },
		func() error { return compress.Register(reg, nil) },
		func() error {
			_, err := focusmod.Register(reg, corefocus.New(corefocus.Options{Platform: corefocus.NewPlatform()}), nil)
			return err
		},
		func() error { _, err := tts.Register(reg, nil, "", "", ""); return err },
		func() error { return imagebatch.Register(reg) },
		func() error { _, err := subtitles.Register(reg, nil, nil, nil, ""); return err },
		func() error { _, err := audiocleanup.Register(reg, nil, nil, "", ""); return err },
		func() error { _, err := lyricvideo.Register(reg, nil, nil, "", ""); return err },
		func() error { _, err := redact.Register(reg, nil, nil, "", ""); return err },
		func() error { _, err := eraser.Register(reg, nil, "", ""); return err },
		func() error { return paint.Register(reg, paint.New(paint.Config{})) },
		func() error { return devutils.Register(reg) },
		func() error { return documents.Register(reg, "") },
		func() error { return archiver.Register(reg) },
		func() error {
			_, err := visualizer.Register(reg, viz.NewAnalyzer("", "", nil, nil), nil, nil, nil, nil, "", "")
			return err
		},
		func() error { return editstudio.Register(reg, editstudio.New(editstudio.Config{})) },
		func() error { _, err := mediaindex.Register(reg, mediaindex.Deps{}); return err },
		func() error { return captions.Register(reg, captions.New(captions.Config{})) },
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
