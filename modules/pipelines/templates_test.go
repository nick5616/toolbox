package pipelines

import (
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/packs"
	"toolbox/modules/audiocleanup"
	"toolbox/modules/bgremove"
	"toolbox/modules/bpmkey"
	"toolbox/modules/converter"
	"toolbox/modules/downloader"
	"toolbox/modules/lyricvideo"
	"toolbox/modules/midi"
	"toolbox/modules/ocr"
	"toolbox/modules/pdf"
	"toolbox/modules/redact"
	"toolbox/modules/stems"
	"toolbox/modules/subtitles"
	"toolbox/modules/transcribe"
	"toolbox/modules/trimmer"
	"toolbox/modules/upscale"
	"toolbox/modules/vault"
	"toolbox/modules/visualizer"
)

// strictDecoders decode a tool step's options the way its module will.
var strictDecoders = map[string]func(json.RawMessage) error{
	stDownloader:   decodes[downloader.Options],
	stTrimmer:      decodes[trimmer.StepOptions],
	stSubtitles:    decodes[subtitles.StepOptions],
	stAudioCleanup: decodes[audiocleanup.StepOptions],
	stTranscribe:   decodes[transcribe.Options],
	stStems:        decodes[stems.Options],
	stBPMKey:       decodes[bpmkey.Options],
	stMIDI:         decodes[midi.Options],
	stLyricVideo:   decodes[lyricvideo.StepOptions],
	stBGRemover:    decodes[bgremove.Options],
	stUpscaler:     decodes[upscale.Options],
	stConverter:    decodes[converter.Options],
	stPDF:          decodes[pdf.StepOptions],
	stOCR:          decodes[ocr.Options],
	stVault:        decodes[vault.StepOptions],
	stRedact:       decodes[redact.StepOptions],
	stVisualizer:   decodes[visualizer.StepOptions],
}

func decodes[T any](raw json.RawMessage) error {
	_, err := core.DecodeOptionsJSON[T](raw)
	return err
}

// toolVars are the variables each tool step defines (SPEC.md §4.3).
var toolVars = map[string][]string{
	stDownloader: {"title", "url"},
	stBPMKey:     {"bpm", "bpm_exact", "key", "key_short", "camelot"},
	stTranscribe: {"transcript", "transcript_timed", "language"},
	stOCR:        {"text"},
	stSubtitles:  {"subtitles", "language"},
	stMIDI:       {"notes"},
}

var builtinVars = []string{"item", "name", "ext", "role", "n", "date", "time", "pipeline"}

// pointerStrings resolves a JSON pointer of string leaves in options.
func pointerStrings(t *testing.T, optionsJSON, ptr string) []string {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(optionsJSON), &v); err != nil {
		t.Fatal(err)
	}
	for _, tok := range strings.Split(strings.TrimPrefix(ptr, "/"), "/") {
		switch c := v.(type) {
		case map[string]any:
			v = c[tok]
		case []any:
			i, err := strconv.Atoi(tok)
			if err != nil || i >= len(c) {
				t.Fatalf("pointer %s: bad index %q", ptr, tok)
			}
			v = c[i]
		default:
			t.Fatalf("pointer %s: cannot descend into %T", ptr, v)
		}
	}
	s, ok := v.(string)
	if !ok {
		t.Fatalf("pointer %s is %T, not a string", ptr, v)
	}
	return []string{s}
}

func TestTemplatesShape(t *testing.T) {
	want := []string{TplSocialClip, TplPodcast, TplSampling, TplKaraoke, TplProductPhotos, TplPaperArchive,
		TplForeignVideo, TplReceipts, TplLecture, TplBeforeSharing, TplMusicVideo}
	tpls := Templates()
	if len(tpls) != len(want) {
		t.Fatalf("%d templates, want %d", len(tpls), len(want))
	}
	packIDs := map[string]bool{}
	for _, p := range packs.Catalog() {
		packIDs[p.ID] = true
	}
	for i, tpl := range tpls {
		t.Run(tpl.ID, func(t *testing.T) {
			if tpl.ID != want[i] || tpl.Pipeline.TemplateID != tpl.ID {
				t.Fatalf("id = %q / %q", tpl.ID, tpl.Pipeline.TemplateID)
			}
			if tpl.Blurb == "" || tpl.Icon == "" || tpl.Pipeline.Name == "" || len(tpl.Packs) == 0 {
				t.Fatalf("incomplete: %+v", tpl)
			}
			for _, p := range tpl.Packs {
				if !packIDs[p] {
					t.Errorf("unknown pack %q", p)
				}
			}
			steps := tpl.Pipeline.Steps
			if len(steps) == 0 || len(steps) > 30 {
				t.Fatalf("%d steps", len(steps))
			}
			seen := map[string]int{}
			for i, s := range steps {
				if _, dup := seen[s.ID]; dup || s.ID == "" || s.ID == "input" || s.ID == "none" {
					t.Errorf("step %d: bad or duplicate id %q", i, s.ID)
				}
				seen[s.ID] = i
				switch {
				case i == 0 && s.From != "input":
					t.Errorf("step 1 must read the run's inputs, has From %q", s.From)
				case s.From == "input" || s.From == "none":
				default:
					if j, ok := seen[s.From]; !ok || j >= i {
						t.Errorf("step %d: From %q is not an earlier step", i+1, s.From)
					}
				}
				if s.Filter.Roles == nil || s.Filter.Kinds == nil || s.Filter.Exts == nil {
					t.Errorf("step %d: filter slices must be non-nil", i+1)
				}
				if !json.Valid([]byte(s.OptionsJSON)) {
					t.Errorf("step %d: invalid options JSON", i+1)
				}
				if s.Manual && s.OptionsJSON != "{}" {
					t.Errorf("step %d: manual steps carry {}", i+1)
				}
			}
			if steps[len(steps)-1].Keep == false && tpl.ID != TplPaperArchive {
				t.Errorf("the last step should keep its files")
			}
		})
	}
}

func TestTemplatesDecodeAndDescribe(t *testing.T) {
	h := newHarness(t, &fakeTG{reply: nil})
	reg := map[string]*step{}
	for _, b := range h.m.builtins() {
		if s, ok := b.a.(*step); ok {
			reg[b.t.ID] = s
		}
	}
	for _, tpl := range Templates() {
		t.Run(tpl.ID, func(t *testing.T) {
			defined := slices.Clone(builtinVars)
			for i, s := range tpl.Pipeline.Steps {
				raw := json.RawMessage(s.OptionsJSON)
				switch {
				case s.Manual:
					if _, ok := strictDecoders[s.Type]; !ok {
						t.Fatalf("step %d: unknown tool %q", i+1, s.Type)
					}
					continue
				case s.Type == TypeCheck:
					if s.Note == "" {
						t.Errorf("a check step needs a note")
					}
					continue
				case reg[s.Type] != nil:
					info, err := reg[s.Type].DescribeStep(raw)
					if err != nil {
						t.Fatalf("step %d (%s): %v", i+1, s.Type, err)
					}
					if len(info.Warnings) != 0 {
						t.Errorf("step %d: warnings %v", i+1, info.Warnings)
					}
					known := append(slices.Clone(defined), "file")
					for _, ptr := range info.Templates {
						for _, str := range pointerStrings(t, s.OptionsJSON, ptr) {
							for _, name := range core.TemplateVars(str) {
								if s.Type == TypeTable && ptr == "/name" && !slices.Contains(builtinVars, name) {
									t.Errorf("step %d: the table name may only use built-ins, has {%s}", i+1, name)
								}
								if !slices.Contains(known, name) {
									t.Errorf("step %d (%s) %s: {%s} is not defined by an earlier step", i+1, s.Type, ptr, name)
								}
							}
						}
					}
					for _, v := range info.Vars {
						defined = append(defined, v.Name)
					}
				default:
					dec, ok := strictDecoders[s.Type]
					if !ok {
						t.Fatalf("step %d: unknown step type %q", i+1, s.Type)
					}
					if err := dec(raw); err != nil {
						t.Fatalf("step %d (%s): options don't decode: %v", i+1, s.Type, err)
					}
					defined = append(defined, toolVars[s.Type]...)
				}
			}
		})
	}
}

func TestTemplateSpecifics(t *testing.T) {
	find := func(id string) core.Pipeline {
		for _, tpl := range Templates() {
			if tpl.ID == id {
				return tpl.Pipeline
			}
		}
		t.Fatalf("no template %s", id)
		return core.Pipeline{}
	}
	s := find(TplSampling).Steps
	if len(s) != 5 || s[2].From != "download" || s[3].From != "stems" || s[4].From != "name" ||
		!slices.Equal(s[4].Filter.Roles, []string{"bass"}) || !s[3].Keep || !s[4].Keep || s[0].Keep || s[1].Keep {
		t.Fatalf("sampling = %+v", s)
	}
	var rn RenameStep
	_ = json.Unmarshal([]byte(s[3].OptionsJSON), &rn)
	if rn.Template != "{name} · {bpm} BPM · {key}" {
		t.Fatalf("rename = %q", rn.Template)
	}
	k := find(TplKaraoke).Steps
	if k[0].From != "input" || k[1].From != "input" {
		t.Fatalf("karaoke reads %q / %q", k[0].From, k[1].From)
	}
	c := find(TplSocialClip).Steps
	if !c[1].Manual || c[1].Note != "Pick the part to keep, then Export" || !c[3].Keep {
		t.Fatalf("social clip = %+v", c)
	}
	r := find(TplReceipts).Steps
	var ex ChatStep
	_ = json.Unmarshal([]byte(r[1].OptionsJSON), &ex)
	var names []string
	for _, f := range ex.Fields {
		names = append(names, f.Name)
	}
	if ex.Mode != ChatExtract || strings.Join(names, ",") != "when,merchant,total,currency" || r[2].Type != TypeTable {
		t.Fatalf("receipts = %+v", ex)
	}
	var tb TableStep
	_ = json.Unmarshal([]byte(r[2].OptionsJSON), &tb)
	if len(tb.Columns) != 5 || tb.Columns[1] != (TableColumn{Header: "Date", Value: "{when}"}) {
		t.Fatalf("table = %+v", tb)
	}
	b := find(TplBeforeSharing).Steps
	if b[1].Type != TypeCheck || b[1].Note != "Check every face and plate is hidden" || b[2].Type != TypeZip {
		t.Fatalf("before sharing = %+v", b)
	}
	var vz visualizer.StepOptions
	_ = json.Unmarshal([]byte(find(TplMusicVideo).Steps[0].OptionsJSON), &vz)
	if vz.PresetID != "golden-hour" || vz.ShowJSON != "" || vz.Aspect != "9:16" || vz.Height != 1080 || vz.FPS != 30 || !vz.Stems || !vz.Mood || vz.Words != "none" {
		t.Fatalf("visualizer = %+v", vz)
	}
	for _, tpl := range []string{TplPodcast, TplLecture} {
		var ch ChatStep
		_ = json.Unmarshal([]byte(find(tpl).Steps[len(find(tpl).Steps)-1].OptionsJSON), &ch)
		if !strings.Contains(ch.Prompt, "{transcript") || ch.Format != FormatMD {
			t.Errorf("%s chat = %+v", tpl, ch)
		}
	}
}

func TestFromTemplateRenumbersAndFreesNames(t *testing.T) {
	existing := []core.PipelineEntry{
		{Pipeline: core.Pipeline{Name: "sampling"}},
		{Pipeline: core.Pipeline{Name: "Sampling 2"}},
	}
	p, err := FromTemplate(TplSampling, existing)
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "Sampling 3" || p.ID != "" || p.TemplateID != TplSampling {
		t.Fatalf("pipeline = %q id=%q tpl=%q", p.Name, p.ID, p.TemplateID)
	}
	orig := find(t, TplSampling)
	if len(p.Steps) != len(orig.Steps) {
		t.Fatal("step count changed")
	}
	ids := map[string]int{}
	for i, s := range p.Steps {
		if len(s.ID) != 8 {
			t.Errorf("step %d id %q", i, s.ID)
		}
		if _, dup := ids[s.ID]; dup {
			t.Errorf("duplicate id %q", s.ID)
		}
		ids[s.ID] = i
		for _, old := range orig.Steps {
			if s.ID == old.ID {
				t.Errorf("step %d kept its template id", i)
			}
		}
		if s.From != "input" && s.From != "none" {
			if j, ok := ids[s.From]; !ok || j >= i {
				t.Errorf("step %d: From %q does not point at an earlier new id", i, s.From)
			}
		}
	}
	// the sampling rename reads the stems step, the MIDI step reads the rename step
	if p.Steps[3].From != p.Steps[1].ID || p.Steps[4].From != p.Steps[3].ID || p.Steps[2].From != p.Steps[0].ID {
		t.Fatalf("From references were not rewritten: %+v", p.Steps)
	}
	// the copy is independent of the template
	p.Steps[4].Filter.Roles[0] = "changed"
	if find(t, TplSampling).Steps[4].Filter.Roles[0] != "bass" {
		t.Fatal("FromTemplate shares filter slices with the template")
	}
	if _, err := FromTemplate("nope", nil); err == nil {
		t.Fatal("unknown template should fail")
	}
}

func find(t *testing.T, id string) core.Pipeline {
	t.Helper()
	for _, tpl := range Templates() {
		if tpl.ID == id {
			return tpl.Pipeline
		}
	}
	t.Fatalf("no template %s", id)
	return core.Pipeline{}
}
