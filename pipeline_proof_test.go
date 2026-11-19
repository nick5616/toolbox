package main

import (
	"slices"
	"strings"
	"testing"

	"toolbox/core"
	corefocus "toolbox/core/focus"
	"toolbox/core/lan"
	"toolbox/core/pipeline"
	"toolbox/core/viz"
	"toolbox/modules/archiver"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/bgremove"
	"toolbox/modules/bpmkey"
	"toolbox/modules/captions"
	"toolbox/modules/chat"
	"toolbox/modules/clipboard"
	"toolbox/modules/composer"
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
	"toolbox/modules/pipelines"
	"toolbox/modules/placeholders"
	"toolbox/modules/posts"
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
	"toolbox/modules/videoeditor"
	"toolbox/modules/visualizer"
)

// TestEveryToolIsAPipelineStep registers every module the way main.go does,
// builds the pipeline catalogue the way the Runner does and asserts that
// every tool the sidebar shows (every non-hidden module, which includes
// llm-chat) has an automatic step type of the same ID. There is no exemption
// list (SPEC.md Phase 14 §1.A).
func TestEveryToolIsAPipelineStep(t *testing.T) {
	reg := core.NewRegistry()
	for _, register := range []func() error{
		func() error { return downloader.Register(reg, t.TempDir()) },
		func() error { return stems.Register(reg, nil) },
		func() error { return bpmkey.Register(reg, nil) },
		func() error { return midi.Register(reg, nil) },
		func() error { return converter.Register(reg) },
		func() error { return transcribe.Register(reg, nil, "") },
		func() error { return exif.Register(reg, exif.New(nil)) },
		func() error { return clipboard.Register(reg, clipboard.New(clipboard.Config{})) },
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
		func() error { return composer.Register(reg, composer.New(composer.Config{})) },
		func() error { return videoeditor.Register(reg, videoeditor.New(videoeditor.Config{})) },
		func() error { return posts.Register(reg, posts.New(posts.Config{})) },
		func() error { return editstudio.Register(reg, editstudio.New(editstudio.Config{})) },
		func() error { return captions.Register(reg, captions.New(captions.Config{})) },
		func() error { _, err := mediaindex.Register(reg, mediaindex.Deps{}); return err },
	} {
		if err := register(); err != nil {
			t.Fatal(err)
		}
	}
	runner := pipeline.New(pipeline.Config{Reg: reg})
	if _, err := pipelines.Register(reg, pipelines.Config{Runner: runner}); err != nil {
		t.Fatal(err)
	}

	steps := map[string]core.StepType{}
	for _, st := range runner.Catalog() {
		if _, dup := steps[st.ID]; dup {
			t.Errorf("step type %q is in the catalogue twice", st.ID)
		}
		steps[st.ID] = st
	}
	// Phase 20: a hidden module offered as a step anyway (Descriptor.HiddenStep).
	if st, ok := steps["search-filter"]; !ok || !st.Auto {
		t.Error("Keep files that show… (search-filter) isn't an automatic step")
	}
	if _, ok := reg.Descriptor("llm-chat"); !ok {
		t.Fatal("llm-chat isn't registered")
	}

	checked := 0
	for _, d := range reg.List() {
		if d.Hidden || d.Status != core.StatusReady {
			continue // system modules and "coming soon" placeholders aren't tools
		}
		checked++
		st, ok := steps[d.ID]
		switch {
		case !ok:
			t.Errorf("%s (%s) is not in the pipeline catalogue", d.Name, d.ID)
			continue
		case !st.Auto:
			t.Errorf("%s (%s) has a step type that can't run automatically", d.Name, d.ID)
			continue
		}
		// The step must resolve to an adapter, not only be listed.
		check := runner.Describe(core.Pipeline{Name: "proof", Steps: []core.PipelineStep{{
			ID: "aaaaaaaa", Type: d.ID, From: pipeline.FromInput, OptionsJSON: st.DefaultsJSON,
		}}})
		for _, p := range check.Steps[0].Problems {
			if strings.Contains(p, "isn't available") || strings.Contains(p, "can't run on its own") {
				t.Errorf("%s (%s): %s", d.Name, d.ID, p)
			}
		}
	}
	if checked < 25 {
		t.Errorf("only %d tools were checked: the registration list is out of date", checked)
	}
	// The old built-in ID still resolves, but isn't listed.
	if _, ok := steps["pipelines.chat"]; ok {
		t.Error("the alias pipelines.chat must not be listed in the catalogue")
	}
	check := runner.Describe(core.Pipeline{Name: "old", Steps: []core.PipelineStep{{
		ID: "bbbbbbbb", Type: "pipelines.chat", From: pipeline.FromNone, OptionsJSON: `{"prompt":"hi"}`,
	}}})
	if p := check.Steps[0].Problems; slices.ContainsFunc(p, func(s string) bool { return strings.Contains(s, "isn't available") }) {
		t.Errorf("pipelines.chat no longer resolves: %v", p)
	}
}
