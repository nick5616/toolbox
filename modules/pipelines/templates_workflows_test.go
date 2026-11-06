package pipelines

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"testing"

	"toolbox/core"
	"toolbox/modules/gif"
	"toolbox/modules/scenes"
	"toolbox/modules/silence"
	"toolbox/modules/tts"
)

func template(t *testing.T, id string) core.PipelineTemplate {
	t.Helper()
	for _, tpl := range Templates() {
		if tpl.ID == id {
			return tpl
		}
	}
	t.Fatalf("no template %s", id)
	return core.PipelineTemplate{}
}

// stepIDs lists "id:type" of each step, to compare whole templates at a glance.
func stepTypes(p core.Pipeline) []string {
	out := make([]string, len(p.Steps))
	for i, s := range p.Steps {
		out[i] = s.ID + ":" + s.Type
	}
	return out
}

func TestEveryTemplateHasAGroup(t *testing.T) {
	counts := map[string]int{}
	for _, tpl := range Templates() {
		if tpl.Group != core.TemplateGroupPractical && tpl.Group != core.TemplateGroupCool {
			t.Errorf("%s: group %q", tpl.ID, tpl.Group)
		}
		counts[tpl.Group]++
	}
	if counts[core.TemplateGroupPractical] < 10 || counts[core.TemplateGroupCool] < 5 {
		t.Errorf("groups = %v", counts)
	}
	for id := range templateGroups {
		template(t, id) // no group entry without a template
	}
	// The Phase 15 workflows: nine practical, five just cool.
	cool := []string{TplHighlightReel, TplReactionGIF, TplNarratedSlideshow, TplSongEverything, TplVerticalCut}
	practical := []string{TplReadItToMe, TplAudiobook, TplTightLecture, TplPodcastPolish, TplCameraRoll, TplShopShots, TplStoryboard, TplMeetingMinutes, TplLinkToNotes}
	for _, id := range cool {
		if g := template(t, id).Group; g != core.TemplateGroupCool {
			t.Errorf("%s is %q", id, g)
		}
	}
	for _, id := range practical {
		if g := template(t, id).Group; g != core.TemplateGroupPractical {
			t.Errorf("%s is %q", id, g)
		}
	}
}

// The gallery gets the template's icon by name: it must be registered in Icon.tsx.
func TestTemplateIconsAreRegistered(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "components", "Icon.tsx"))
	if err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\s+"?([a-z0-9-]+)"?: [A-Za-z0-9]+,$`).FindAllStringSubmatch(string(src), -1) {
		known[m[1]] = true
	}
	if len(known) < 100 {
		t.Fatalf("found only %d icons in Icon.tsx", len(known))
	}
	for _, tpl := range Templates() {
		if !known[tpl.Icon] {
			t.Errorf("%s: icon %q is not registered in Icon.tsx", tpl.ID, tpl.Icon)
		}
	}
}

func TestPhase15TemplateWiring(t *testing.T) {
	want := map[string][]string{
		TplReadItToMe:        {"archive:archiver", "text:documents", "speak:tts", "loudness:audio-cleanup"},
		TplAudiobook:         {"markdown:documents", "speak:tts", "zip:pipelines.zip"},
		TplTightLecture:      {"cut:silence", "subtitles:subtitles", "small:converter"},
		TplPodcastPolish:     {"clean:audio-cleanup", "cut:silence", "transcribe:transcribe", "notes:llm-chat"},
		TplCameraRoll:        {"organize:organize", "shrink:imagebatch", "vault:vault"},
		TplShopShots:         {"cutout:bg-remover", "square:imagebatch", "fill:photo-composer"},
		TplStoryboard:        {"shots:scenes", "pdf:pdf", "sheet:gif"},
		TplMeetingMinutes:    {"transcribe:transcribe", "minutes:llm-chat", "word:documents"},
		TplLinkToNotes:       {"download:downloader", "transcribe:transcribe", "summary:llm-chat", "copy:clipboard"},
		TplHighlightReel:     {"shots:scenes", "beat:edit-studio"},
		TplReactionGIF:       {"subtitles:subtitles", "gif:gif"},
		TplNarratedSlideshow: {"voice:tts", "slideshow:video-studio"},
		TplSongEverything:    {"stems:stems", "tempo:bpm-key", "name:pipelines.rename", "melody:audio-to-midi", "video:visualizer", "zip:pipelines.zip"},
		TplVerticalCut:       {"cut:silence", "vertical:video-studio", "post:post-builder"},
		TplSendToMyComputer:  {"shrink:imagebatch", "send:lan-share"},
	}
	for id, steps := range want {
		if got := stepTypes(template(t, id).Pipeline); !slices.Equal(got, steps) {
			t.Errorf("%s steps = %v, want %v", id, got, steps)
		}
	}

	// Which step each one reads, and the role it filters on.
	type edge struct{ step, from, role string }
	for id, edges := range map[string][]edge{
		TplReadItToMe:       {{"text", "archive", "page"}, {"speak", "text", "document"}, {"loudness", "speak", ""}},
		TplAudiobook:        {{"markdown", "input", ""}, {"speak", "markdown", ""}, {"zip", "speak", ""}},
		TplTightLecture:     {{"subtitles", "cut", "cut"}, {"small", "subtitles", "video"}},
		TplPodcastPolish:    {{"cut", "clean", ""}, {"transcribe", "cut", "cut"}, {"notes", "none", ""}},
		TplCameraRoll:       {{"shrink", "organize", "file"}, {"vault", "shrink", ""}},
		TplShopShots:        {{"square", "cutout", ""}, {"fill", "square", ""}},
		TplStoryboard:       {{"pdf", "shots", "still"}, {"sheet", "input", ""}},
		TplMeetingMinutes:   {{"minutes", "none", ""}, {"word", "minutes", ""}},
		TplLinkToNotes:      {{"transcribe", "download", ""}, {"summary", "none", ""}, {"copy", "summary", ""}},
		TplHighlightReel:    {{"shots", "input", ""}, {"beat", "shots", "scene"}},
		TplReactionGIF:      {{"gif", "subtitles", "video"}},
		TplSongEverything:   {{"tempo", "input", ""}, {"name", "stems", ""}, {"melody", "name", "other"}, {"video", "input", ""}, {"zip", "name", ""}},
		TplVerticalCut:      {{"vertical", "cut", "cut"}, {"post", "vertical", "video"}},
		TplSendToMyComputer: {{"send", "shrink", ""}},
	} {
		steps := template(t, id).Pipeline.Steps
		for _, e := range edges {
			i := slices.IndexFunc(steps, func(s core.PipelineStep) bool { return s.ID == e.step })
			if i < 0 {
				t.Fatalf("%s: no step %s", id, e.step)
			}
			s := steps[i]
			if s.From != e.from {
				t.Errorf("%s/%s reads %q, want %q", id, e.step, s.From, e.from)
			}
			if e.role == "" && len(s.Filter.Roles) != 0 || e.role != "" && !slices.Equal(s.Filter.Roles, []string{e.role}) {
				t.Errorf("%s/%s roles = %v, want %q", id, e.step, s.Filter.Roles, e.role)
			}
		}
	}
}

func TestPhase15TemplateOptions(t *testing.T) {
	opts := func(id, step string, v any) {
		t.Helper()
		for _, s := range template(t, id).Pipeline.Steps {
			if s.ID == step {
				if err := json.Unmarshal([]byte(s.OptionsJSON), v); err != nil {
					t.Fatalf("%s/%s: %v", id, step, err)
				}
				return
			}
		}
		t.Fatalf("%s: no step %s", id, step)
	}

	var say tts.StepOptions
	opts(TplAudiobook, "speak", &say)
	if say.Split != tts.SplitHeadings {
		t.Errorf("audiobook split = %q", say.Split)
	}
	opts(TplReadItToMe, "speak", &say)
	if say.Split != tts.SplitNone || say.Format != tts.FormatMP3 {
		t.Errorf("read it to me speech = %+v", say)
	}
	var cut silence.StepOptions
	opts(TplTightLecture, "cut", &cut)
	if cut.CutList {
		t.Error("tight lecture should not write a cut list")
	}
	var sc scenes.StepOptions
	opts(TplStoryboard, "shots", &sc)
	if sc.Output != scenes.OutputStills {
		t.Errorf("storyboard output = %q", sc.Output)
	}
	opts(TplHighlightReel, "shots", &sc)
	if sc.Output != scenes.OutputClips || sc.Keep != scenes.KeepActive || sc.KeepN != 12 {
		t.Errorf("highlight shots = %+v", sc)
	}
	var sheet gif.StepOptions
	opts(TplStoryboard, "sheet", &sheet)
	if sheet.Mode != gif.ModeSheet {
		t.Errorf("storyboard sheet mode = %q", sheet.Mode)
	}
	opts(TplReactionGIF, "gif", &sheet)
	if sheet.Mode != gif.ModeGIF || !sheet.Loop {
		t.Errorf("reaction gif = %+v", sheet)
	}

	// The choices the user makes are left empty.
	var shop struct {
		TemplateID string `json:"templateId"`
	}
	opts(TplShopShots, "fill", &shop)
	var beat struct {
		Song string `json:"song"`
	}
	opts(TplHighlightReel, "beat", &beat)
	if shop.TemplateID != "" || beat.Song != "" {
		t.Errorf("template %q / song %q should be empty", shop.TemplateID, beat.Song)
	}
}

func TestLinkToNotesStartsFromACopiedLink(t *testing.T) {
	tpl := template(t, TplLinkToNotes)
	if c := tpl.Pipeline.Clip; !c.Enabled || !slices.Equal(c.Kinds, []string{core.ClipTriggerLink}) {
		t.Fatalf("clip trigger = %+v", c)
	}
	for _, other := range Templates() {
		if other.ID != TplLinkToNotes && other.Pipeline.Clip.Enabled {
			t.Errorf("%s turns the clipboard trigger on", other.ID)
		}
	}
	// A pipeline made from the template keeps the trigger.
	p, err := FromTemplate(TplLinkToNotes, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Clip.Enabled || !slices.Equal(p.Clip.Kinds, []string{core.ClipTriggerLink}) {
		t.Fatalf("FromTemplate lost the trigger: %+v", p.Clip)
	}
	if last := p.Steps[len(p.Steps)-1]; last.Type != stClipboard {
		t.Errorf("the last step is %s", last.Type)
	}
}

func TestOnlyTheUserChoicesAreLeftOpen(t *testing.T) {
	// The editor flags exactly these steps; a new template with an empty
	// choice must be added to userChoices (templates_describe_test.go).
	got := map[string][]string{}
	for _, tpl := range Templates() {
		for _, s := range tpl.Pipeline.Steps {
			if s.Type == stPhotoCompose {
				got[tpl.ID] = append(got[tpl.ID], s.ID)
			}
		}
	}
	if len(got) != 1 || !slices.Equal(got[TplShopShots], []string{"fill"}) {
		t.Errorf("photo composer steps = %v", got)
	}
}
