package pipelines

import (
	"slices"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/pipeline"
	"toolbox/core/viz"
	"toolbox/modules/archiver"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/bgremove"
	"toolbox/modules/bpmkey"
	"toolbox/modules/chat"
	"toolbox/modules/clipboard"
	"toolbox/modules/composer"
	"toolbox/modules/converter"
	"toolbox/modules/documents"
	"toolbox/modules/downloader"
	"toolbox/modules/editstudio"
	focusmod "toolbox/modules/focus"
	"toolbox/modules/gif"
	"toolbox/modules/imagebatch"
	"toolbox/modules/lanshare"
	"toolbox/modules/lyricvideo"
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/organize"
	"toolbox/modules/pdf"
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
	"toolbox/modules/visualizer"
)

// realRunner registers the modules the templates use the way main.go does and
// returns the Runner that describes pipelines against them.
func realRunner(t *testing.T) *pipeline.Runner {
	t.Helper()
	reg := core.NewRegistry()
	for _, register := range []func() error{
		func() error { return downloader.Register(reg, t.TempDir()) },
		func() error { return stems.Register(reg, nil) },
		func() error { return bpmkey.Register(reg, nil) },
		func() error { return midi.Register(reg, nil) },
		func() error { return converter.Register(reg) },
		func() error { return transcribe.Register(reg, nil, "") },
		func() error { return clipboard.Register(reg, clipboard.New(clipboard.Config{})) },
		func() error { return bgremove.Register(reg, nil, "") },
		func() error { return upscale.Register(reg, nil, "") },
		func() error { return pdf.Register(reg, pdf.New(nil)) },
		func() error { return chat.Register(reg, chat.New(chat.Config{})) },
		func() error { return vault.Register(reg, vault.New(vault.Config{})) },
		func() error { return ocr.Register(reg, nil, nil, "") },
		func() error { return trimmer.Register(reg, nil) },
		func() error { return scenes.Register(reg) },
		func() error { return gif.Register(reg) },
		func() error { return organize.Register(reg, organize.New(nil)) },
		func() error { return silence.Register(reg, nil) },
		func() error { _, err := tts.Register(reg, nil, "", "", ""); return err },
		func() error { return imagebatch.Register(reg) },
		func() error { m, r := lanshare.New(nil); return lanshare.Register(reg, m, r) },
		func() error { _, err := subtitles.Register(reg, nil, nil, nil, ""); return err },
		func() error { _, err := audiocleanup.Register(reg, nil, nil, "", ""); return err },
		func() error { _, err := lyricvideo.Register(reg, nil, nil, "", ""); return err },
		func() error { _, err := redact.Register(reg, nil, nil, "", ""); return err },
		func() error { return documents.Register(reg, "") },
		func() error { return archiver.Register(reg) },
		func() error {
			_, err := visualizer.Register(reg, viz.NewAnalyzer("", "", nil, nil), nil, nil, nil, nil, "", "")
			return err
		},
		func() error { return composer.Register(reg, composer.New(composer.Config{})) },
		func() error { return posts.Register(reg, posts.New(posts.Config{})) },
		func() error { return editstudio.Register(reg, editstudio.New(editstudio.Config{})) },
		func() error { _, err := focusmod.Register(reg, fakeFocus{}, nil); return err },
	} {
		if err := register(); err != nil {
			t.Fatal(err)
		}
	}
	runner := pipeline.New(pipeline.Config{Reg: reg})
	if _, err := Register(reg, Config{Runner: runner}); err != nil {
		t.Fatal(err)
	}
	return runner
}

// userChoices are the steps a template leaves for the user, with a fragment of
// the problem the step editor shows for each. Every other step of every
// template must describe without a problem.
var userChoices = map[string]map[string]string{
	TplShopShots:        {"fill": "Pick a template"},
	TplSendToMyComputer: {"send": "Pick a device"},
	TplMusicSession:     {"focus": "Pick a profile", "daw": "Pick an app"},
	TplPomodoro:         {"work1": "Pick a profile", "work2": "Pick a profile", "work3": "Pick a profile", "work4": "Pick a profile"},
	TplDeepWork:         {"focus": "Pick a profile"},
	TplSampleAndMake:    {"focus": "Pick a profile", "open": "Pick an app"},
}

func TestTemplatesDescribeAgainstRealModules(t *testing.T) {
	runner := realRunner(t)
	for _, tpl := range Templates() {
		t.Run(tpl.ID, func(t *testing.T) {
			check := runner.Describe(tpl.Pipeline)
			for _, p := range check.Problems {
				t.Errorf("pipeline problem: %s", p)
			}
			if len(check.Steps) != len(tpl.Pipeline.Steps) {
				t.Fatalf("%d checks for %d steps", len(check.Steps), len(tpl.Pipeline.Steps))
			}
			flagged := map[string]bool{}
			for i, sc := range check.Steps {
				id := tpl.Pipeline.Steps[i].ID
				want, mine := userChoices[tpl.ID][id]
				if !mine {
					for _, p := range sc.Problems {
						// The frontend fills a Visualizer step's design from its presetId when it creates the pipeline.
						if tpl.Pipeline.Steps[i].Type == stVisualizer && p == "Pick a design" {
							continue
						}
						t.Errorf("step %d (%s): %s", i+1, id, p)
					}
					for _, w := range sc.Info.Warnings {
						if w == "Local Chat isn't available" { // no chat model in this harness
							continue
						}
						t.Errorf("step %d (%s): warning %q", i+1, id, w)
					}
					continue
				}
				flagged[id] = true
				if !slices.ContainsFunc(sc.Problems, func(p string) bool { return strings.Contains(p, want) }) {
					t.Errorf("step %d (%s) should ask the user (%q); problems = %v", i+1, id, want, sc.Problems)
				}
			}
			for id := range userChoices[tpl.ID] {
				if !flagged[id] {
					t.Errorf("user-choice step %q is not in the template", id)
				}
			}
		})
	}
}
