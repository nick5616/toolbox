package main

import (
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
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/organize"
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

// varTypes is the type of every variable a tool step can make (Phase 16
// SPEC section 2.3). A new variable has to be added here and pick a type;
// "" counts as text.
var varTypes = map[string]core.ValueType{
	"bpm":              core.ValueNumber,
	"bpm_exact":        core.ValueNumber,
	"kept_s":           core.ValueNumber,
	"removed_s":        core.ValueNumber,
	"size_mb":          core.ValueNumber,
	"fits":             core.ValueToggle,
	"focus_ends":       core.ValueText,   // focus
	"focus_minutes":    core.ValueNumber, // focus
	"focus_profile":    core.ValueText,   // focus
	"grade":            core.ValueText,
	"scene":            core.ValueNumber,
	"scene_total":      core.ValueNumber,
	"speech_file":      core.ValueFile,
	"post_folder":      core.ValueText,
	"folder":           core.ValueText,
	"title":            core.ValueText,   // archiver
	"url":              core.ValueText,   // archiver
	"key":              core.ValueText,   // bpm-key
	"key_short":        core.ValueText,   // bpm-key
	"camelot":          core.ValueText,   // bpm-key
	"reply":            core.ValueText,   // chat
	"format":           core.ValueText,   // documents
	"sha256":           core.ValueText,   // dev-utils
	"sha1":             core.ValueText,   // dev-utils
	"md5":              core.ValueText,   // dev-utils
	"notes":            core.ValueNumber, // audio-to-midi
	"device":           core.ValueText,   // lan-share
	"text":             core.ValueText,   // ocr
	"caption":          core.ValueText,   // posts
	"subtitles":        core.ValueText,   // subtitles
	"language":         core.ValueText,   // subtitles
	"transcript":       core.ValueText,   // transcribe
	"transcript_timed": core.ValueText,   // transcribe
	"voice":            core.ValueText,   // tts
}

// TestEveryStepVariableHasAType lists the variables every registered tool
// makes (with its default options) and checks each one is in varTypes with
// the type the step declares.
func TestEveryStepVariableHasAType(t *testing.T) {
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
	} {
		if err := register(); err != nil {
			t.Fatal(err)
		}
	}
	runner := pipeline.New(pipeline.Config{Reg: reg})
	if _, err := pipelines.Register(reg, pipelines.Config{Runner: runner}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, st := range runner.Catalog() {
		if !st.Auto {
			continue
		}
		check := runner.Describe(core.Pipeline{Name: "vars", Steps: []core.PipelineStep{{
			ID: "aaaaaaaa", Type: st.ID, From: pipeline.FromInput, OptionsJSON: st.DefaultsJSON,
		}}})
		for _, v := range check.Steps[0].Info.Vars {
			got := v.Type
			if got == "" {
				got = core.ValueText
			}
			want, ok := varTypes[v.Name]
			if !ok {
				t.Errorf("%s makes {%s} (%s), which isn't listed in varTypes: pick a type", st.ID, v.Name, got)
				continue
			}
			seen[v.Name] = true
			if got != want {
				t.Errorf("%s: {%s} is %q, want %q", st.ID, v.Name, got, want)
			}
		}
	}
	for name := range varTypes {
		if !seen[name] {
			t.Logf("{%s} is listed but no step made it with default options", name)
		}
	}
}
