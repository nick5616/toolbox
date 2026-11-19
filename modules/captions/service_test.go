package captions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/deps"
)

func TestPromptRules(t *testing.T) {
	for _, p := range []Preset{PresetPosting, PresetAccessible, PresetCatalogue, PresetRename, PresetEverything} {
		o := DefaultOptions()
		o.Preset = p
		sys := SystemPrompt(o, effectiveFields(o))
		for _, want := range []string{
			"Never identify people or guess who they are, their age, ethnicity, gender identity, health or religion",
			"a person in a red coat",
			"Use a person's or pet's name only when the context or the note for this file gives it",
		} {
			if !strings.Contains(sys, want) {
				t.Errorf("%s: system prompt lacks %q", p, want)
			}
		}
		if !strings.Contains(sys, "Never invent text that isn't legible") || !strings.Contains(sys, `"a sign"`) {
			t.Errorf("%s: no rule against inventing text", p)
		}
		if !strings.Contains(sys, "Describe only what is visible") {
			t.Errorf("%s: no grounding rule", p)
		}
	}
	o := DefaultOptions()
	o.ReadText = false
	if sys := SystemPrompt(o, effectiveFields(o)); strings.Contains(sys, "may quote words") || !strings.Contains(sys, "Do not quote or transcribe") {
		t.Errorf("read text off: %s", sys)
	}
}

func TestSystemPromptPerPreset(t *testing.T) {
	has := func(o Options, subs ...string) {
		t.Helper()
		sys := SystemPrompt(o, effectiveFields(o))
		for _, s := range subs {
			if !strings.Contains(sys, s) {
				t.Errorf("%s/%s lacks %q", o.Preset, o.Tone, s)
			}
		}
	}
	o := DefaultOptions() // posting, warm, medium, 5 hashtags, no emoji
	has(o, "- caption: ", "warm and friendly", "up to 250 characters", "Do not use emoji", "- hashtags: up to 5", "- alt: ", "at most 125 characters", "Write all text in English")
	if strings.Contains(SystemPrompt(o, effectiveFields(o)), "- title:") {
		t.Error("posting has no title")
	}
	o.Tone, o.Length, o.Emoji, o.Language = TonePoetic, LengthLong, true, " Portuguese "
	has(o, "poetic and evocative", "three to five sentences", "one or two fitting emoji", "Write all text in Portuguese")
	o.Preset = PresetCatalogue
	has(o, "- title: ", "at most 70 characters", "- description: ", "up to 8 sentences", "- keywords: 5 to 25")
	o.Preset = PresetRename
	has(o, "- name: ", "2 to 6 plain words")
	// No hashtags wanted: the field disappears.
	o = DefaultOptions()
	o.Hashtags = 0
	if got := effectiveFields(o); !reflect.DeepEqual(got, []Field{FieldCaption, FieldAlt}) {
		t.Errorf("fields %v", got)
	}
	// A rename step always needs the name.
	o.Then = ThenRenameCopies
	if got := effectiveFields(o); !reflect.DeepEqual(got, []Field{FieldCaption, FieldAlt, FieldName}) {
		t.Errorf("fields %v", got)
	}
}

func TestUserPromptGolden(t *testing.T) {
	got := UserPrompt(PromptInput{
		Context: "Lisbon trip. The dog is Max.", Note: "at the bakery", Labels: []string{"dog", "street"},
		Text: "OPEN\n9-5", Date: "2026-05-02", Frames: 1, Fields: []Field{FieldCaption, FieldHashtags, FieldAlt},
	})
	want := "Describe the picture.\n" +
		"\nContext from the owner: Lisbon trip. The dog is Max.\n" +
		"Note for this file: at the bakery\n" +
		"Hints: Labels: dog, street; Text found: OPEN 9-5\n" +
		"File date: 2026-05-02\n" +
		"\nReply with a JSON object with these fields: caption, hashtags, alt."
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
	vid := UserPrompt(PromptInput{Frames: 6, Fields: []Field{FieldTitle}})
	if vid != "The 6 pictures are frames from one video, in time order. Describe the video as a whole.\n\nReply with a JSON object with these fields: title." {
		t.Errorf("video prompt %q", vid)
	}
}

func TestSchemaPerPreset(t *testing.T) {
	for _, p := range []Preset{PresetPosting, PresetAccessible, PresetCatalogue, PresetRename, PresetEverything} {
		o := DefaultOptions()
		o.Preset = p
		fields := effectiveFields(o)
		var s struct {
			Type       string                    `json:"type"`
			Properties map[string]map[string]any `json:"properties"`
			Required   []string                  `json:"required"`
			Additional bool                      `json:"additionalProperties"`
		}
		if err := json.Unmarshal(Schema(fields, o.Hashtags), &s); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		if s.Type != "object" || s.Additional || len(s.Properties) != len(fields) || len(s.Required) != len(fields) {
			t.Errorf("%s: %+v", p, s)
		}
		for i, f := range fields {
			if s.Required[i] != string(f) {
				t.Errorf("%s: required[%d] = %s", p, i, s.Required[i])
			}
			typ := s.Properties[string(f)]["type"]
			wantType := "string"
			if f == FieldHashtags || f == FieldKeywords {
				wantType = "array"
			}
			if typ != wantType {
				t.Errorf("%s/%s: type %v", p, f, typ)
			}
		}
	}
	var s struct {
		Properties map[string]struct {
			MaxItems int `json:"maxItems"`
		} `json:"properties"`
	}
	_ = json.Unmarshal(Schema([]Field{FieldHashtags}, 7), &s)
	if s.Properties["hashtags"].MaxItems != 7 {
		t.Errorf("maxItems %d", s.Properties["hashtags"].MaxItems)
	}
}

func TestParseReply(t *testing.T) {
	fields := []Field{FieldCaption, FieldHashtags, FieldKeywords}
	tests := []struct {
		name, in string
		ok       bool
		want     Fields
	}{
		{"object", `{"caption":"Hi","hashtags":["#a","#b"],"keywords":["x"]}`, true, Fields{Caption: "Hi", Hashtags: []string{"#a", "#b"}, Keywords: []string{"x"}}},
		{"fence", "```json\n{\"caption\":\"Hi\"}\n```", true, Fields{Caption: "Hi", Hashtags: []string{}, Keywords: []string{}}},
		{"chatter", "Sure! {\"caption\":\"Hi\"} Hope that helps", true, Fields{Caption: "Hi", Hashtags: []string{}, Keywords: []string{}}},
		{"lists as strings", `{"caption":"Hi","hashtags":"#a #b","keywords":"x, y"}`, true, Fields{Caption: "Hi", Hashtags: []string{"#a #b"}, Keywords: []string{"x, y"}}},
		{"extra fields dropped", `{"caption":"Hi","title":"T"}`, true, Fields{Caption: "Hi", Hashtags: []string{}, Keywords: []string{}}},
		{"not json", "a dog", false, Fields{}},
		{"no wanted field", `{"title":"T"}`, false, Fields{}},
		{"array", `["a"]`, false, Fields{}},
		{"wrong type", `{"caption":5}`, false, Fields{}},
		{"truncated", `{"caption":"Hi`, false, Fields{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ParseReply(tt.in, fields)
			if ok != tt.ok || (ok && !reflect.DeepEqual(got, tt.want)) {
				t.Errorf("got %#v %v, want %#v %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func makeBatch(t *testing.T, e *env, names ...string) (string, []string) {
	t.Helper()
	e.vision.replies = []string{good("dog"), good("cat"), good("boat")}
	in := photos(t, t.TempDir(), names...)
	o := DefaultOptions()
	o.Preset = PresetEverything
	return captioned(t, e, in, o), in
}

func TestServiceStatus(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	st := svc.Status()
	if st.Model != "test-vision" || st.ModelLabel != "test-vision" || st.Problem != "" || st.ExifTool || st.FFmpeg || !st.SearchHints {
		t.Errorf("status %+v", st)
	}
	e.tools[deps.ExifTool], e.tools[deps.FFmpeg] = "x", "y"
	e.vision.model, e.vision.visionEr = "", core.Errorf(core.CodeDependencyMissing, "Install the Caption Writer pack")
	e.m.cfg.SearchInstalled = nil
	st = svc.Status()
	if st.Model != "" || st.Problem != "Install the Caption Writer pack" || !st.ExifTool || !st.FFmpeg || st.SearchHints {
		t.Errorf("status %+v", st)
	}
	if got := svc.Fields(PresetRename); !reflect.DeepEqual(got, []Field{FieldName}) {
		t.Errorf("fields %v", got)
	}
}

func TestServiceBatches(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	if got, err := svc.Batches(); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty: %v %v", got, err)
	}
	d1, in1 := makeBatch(t, e, "a.jpg", "b.jpg")
	// Make the first batch older and its first input vanish.
	b, _ := readBatchFile(d1)
	b.Created = 1000
	if err := writeBatchFile(b); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(in1[0])
	d2, in2 := makeBatch(t, e, "c.jpg")
	if _, err := e.m.updateItem(d2, 0, func(it *Item) { it.State = ItemFailed }); err != nil {
		t.Fatal(err)
	}
	// A folder without captions.json and a stray file are ignored.
	_ = os.MkdirAll(filepath.Join(e.lib, "Captions", "other"), 0o755)
	_ = os.WriteFile(filepath.Join(e.lib, "Captions", "stray.txt"), []byte("x"), 0o644)

	got, err := svc.Batches()
	if err != nil || len(got) != 2 {
		t.Fatalf("%+v %v", got, err)
	}
	if got[0].Dir != d2 || got[0].Count != 1 || got[0].Failed != 1 || got[0].Cover != in2[0] {
		t.Errorf("newest: %+v", got[0])
	}
	if got[1].Dir != d1 || got[1].Count != 2 || got[1].Cover != in1[1] || got[1].Created != 1000 {
		t.Errorf("older: %+v", got[1])
	}
}

func TestServiceBatchReadsDirFromFolder(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	dir, _ := makeBatch(t, e, "a.jpg")
	// A file that lies about its own folder.
	raw, _ := os.ReadFile(filepath.Join(dir, BatchFile))
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	m["dir"] = `C:\somewhere\else`
	raw, _ = json.Marshal(m)
	_ = os.WriteFile(filepath.Join(dir, BatchFile), raw, 0o644)
	b, err := svc.Batch(dir)
	if err != nil || b.Dir != dir || len(b.Items) != 1 {
		t.Fatalf("%+v %v", b, err)
	}
	for _, bad := range []string{"", filepath.Dir(dir), filepath.Join(dir, ".."), filepath.Join(e.lib, "Captions", "nope"), t.TempDir()} {
		if _, err := svc.Batch(bad); err == nil {
			t.Errorf("Batch(%q) should fail", bad)
		}
	}
}

func TestServiceSaveBatch(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	dir, in := makeBatch(t, e, "a.jpg", "b.jpg")
	b, _ := svc.Batch(dir)
	e.index.puts, e.index.order = nil, nil

	b.Items[0].Fields.Caption = "My caption #tagged 🎉"
	b.Items[0].Fields.Hashtags = []string{"#one", "#two", "#three", "#four", "#five", "#six", "#seven"}
	b.Items[0].Note = "the dog is Max"
	b.Items[1].Fields.Alt = "Image of something #x" // edited, so left alone
	b.Items[1].Edited = map[Field]bool{FieldAlt: true}
	b.Options.Tone = TonePlayful
	b.Options.Action = ActionRename // ignored
	b.Name = "hijacked"
	if err := svc.SaveBatch(b); err != nil {
		t.Fatal(err)
	}
	got, _ := svc.Batch(dir)
	if got.Name == "hijacked" || got.Options.Action != ActionCaption || got.Options.Tone != TonePlayful {
		t.Errorf("batch %+v", got.Options)
	}
	it := got.Items[0]
	if !it.Edited[FieldCaption] || !it.Edited[FieldHashtags] || it.Note != "the dog is Max" {
		t.Errorf("item 0 %+v", it)
	}
	if it.Fields.Caption != "My caption #tagged 🎉" || len(it.Fields.Hashtags) != 7 {
		t.Errorf("edited fields must be kept as typed: %+v", it.Fields)
	}
	if it.Fields.Alt != "A dog on a table" || it.Fields.Name != "dog on table" || it.State != ItemDone {
		t.Errorf("untouched fields: %+v", it.Fields)
	}
	if got.Items[1].State != ItemDone || got.Items[1].Fields.Alt != "Image of something #x" {
		t.Errorf("item 1 %+v", got.Items[1])
	}
	// csv rewritten and Smart search updated for the done items.
	csv, _ := os.ReadFile(filepath.Join(dir, CSVFile))
	if !strings.Contains(string(csv), "My caption") {
		t.Error("csv not updated")
	}
	if len(e.index.puts) != 2 || !strings.Contains(e.index.puts[in[0]][0].Text, "My caption") {
		t.Errorf("PutText %+v", e.index.puts)
	}

	// Rejections.
	bad := got
	bad.Items = bad.Items[:1]
	if err := svc.SaveBatch(bad); err == nil {
		t.Error("a different item count must fail")
	}
	bad = got
	bad.Items = append([]Item(nil), got.Items...)
	bad.Items[0].Input = filepath.Join(t.TempDir(), "other.jpg")
	if err := svc.SaveBatch(bad); err == nil {
		t.Error("changed inputs must fail")
	}
	bad = got
	bad.Version = 2
	if err := svc.SaveBatch(bad); err == nil {
		t.Error("wrong version must fail")
	}
	bad = got
	bad.Dir = t.TempDir()
	if err := svc.SaveBatch(bad); err == nil {
		t.Error("a folder outside Captions must fail")
	}
	bad = got
	bad.Options.Hashtags = 99
	if err := svc.SaveBatch(bad); err == nil {
		t.Error("bad settings must fail")
	}
}

func TestSaveBatchKeepsItemsStillRunning(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	dir, _ := makeBatch(t, e, "a.jpg")
	// The job finished item 0 while the UI still holds it as pending.
	b, _ := svc.Batch(dir)
	stale := b
	stale.Items = []Item{b.Items[0]}
	stale.Items[0].State = ItemPending
	stale.Items[0].Fields = Fields{}
	if err := svc.SaveBatch(stale); err != nil {
		t.Fatal(err)
	}
	got, _ := svc.Batch(dir)
	if got.Items[0].State != ItemDone || got.Items[0].Fields.Alt == "" {
		t.Errorf("a stale save wiped a finished item: %+v", got.Items[0])
	}
}

func TestServiceExportText(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	dir, _ := makeBatch(t, e, "a.jpg", "b.jpg")
	if _, err := e.m.updateItem(dir, 1, func(it *Item) { it.State = ItemFailed }); err != nil {
		t.Fatal(err)
	}
	md, err := svc.ExportText(dir, "md")
	if err != nil || len(md) != 1 || filepath.Dir(md[0]) != dir || filepath.Ext(md[0]) != ".md" {
		t.Fatalf("%v %v", md, err)
	}
	text, _ := os.ReadFile(md[0])
	if !strings.Contains(string(text), "## a.jpg") || !strings.Contains(string(text), "**Caption:** Look at this dog") || strings.Contains(string(text), "b.jpg") {
		t.Errorf("md:\n%s", text)
	}
	md2, _ := svc.ExportText(dir, "md")
	if md2[0] == md[0] {
		t.Error("exports must not overwrite")
	}
	txt, err := svc.ExportText(dir, "txt")
	if err != nil || len(txt) != 1 || filepath.Base(txt[0]) != "a.txt" {
		t.Fatalf("%v %v", txt, err)
	}
	one, _ := os.ReadFile(txt[0])
	if !strings.HasPrefix(string(one), "Caption\nLook at this dog\n\nHashtags\n#dog") {
		t.Errorf("txt:\n%s", one)
	}
	txt2, _ := svc.ExportText(dir, "txt")
	if filepath.Base(txt2[0]) != "a (1).txt" {
		t.Errorf("second txt %v", txt2)
	}
	if _, err := svc.ExportText(dir, "pdf"); err == nil {
		t.Error("unknown format must fail")
	}
	if _, err := svc.ExportText(t.TempDir(), "md"); err == nil {
		t.Error("a folder outside Captions must fail")
	}
}

func TestServiceDeleteBatch(t *testing.T) {
	e := newEnv(t)
	svc := NewService(nil, e.m)
	dir, _ := makeBatch(t, e, "a.jpg")
	outside := t.TempDir()
	_ = os.WriteFile(filepath.Join(outside, BatchFile), []byte("{}"), 0o644)
	for _, bad := range []string{outside, filepath.Join(e.lib, "Captions"), e.lib, ""} {
		if err := svc.DeleteBatch(bad); err == nil {
			t.Errorf("DeleteBatch(%q) should fail", bad)
		}
	}
	if len(e.trash.Trashed) != 0 {
		t.Fatalf("trashed %v", e.trash.Trashed)
	}
	if err := svc.DeleteBatch(dir); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(e.trash.Trashed, []string{dir}) {
		t.Errorf("trashed %v", e.trash.Trashed)
	}
	e.trash.Off = true
	d2, _ := makeBatch(t, e, "b.jpg")
	if err := svc.DeleteBatch(d2); err == nil {
		t.Error("without a trash the delete must fail")
	}
}
