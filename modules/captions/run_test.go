package captions

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
)

func postingOptions() Options {
	o := DefaultOptions()
	o.Context = "Lisbon trip. The dog is Max."
	return o
}

func TestRunCaptionHappyPath(t *testing.T) {
	e := newEnv(t)
	in := photos(t, filepath.Join(t.TempDir(), "trip"), "a.jpg", "b.jpg", "c.jpg")
	e.vision.replies = []string{good("dog"), good("cat"), good("boat")}
	o := postingOptions()
	o.Notes = map[string]string{in[1]: "this is Max"}
	before := hashFiles(t, in)

	rec, err := mustRun(t, e, in, o)
	if err != nil {
		t.Fatal(err)
	}
	dir := rec.batchDir(t)
	if filepath.Dir(dir) != filepath.Join(e.lib, "Captions") || !strings.HasPrefix(filepath.Base(dir), "Lisbon trip. The dog") {
		t.Errorf("batch folder %q", dir)
	}
	b, err := readBatchFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if b.Model != "test-vision" || len(b.Items) != 3 || b.Version != 1 {
		t.Fatalf("batch: %+v", b)
	}
	for i, it := range b.Items {
		if it.Input != in[i] || it.State != ItemDone || it.Seed == 0 {
			t.Errorf("item %d: %+v", i, it)
		}
	}
	// Repairs were applied: no opener in alt, spam tag filtered, hashtags limited to 5.
	f := b.Items[0].Fields
	if f.Alt != "A dog on a table" || f.Caption != "Look at this dog" || f.Title != "" || len(f.Keywords) != 0 {
		t.Errorf("fields: %+v", f)
	}
	if !reflect.DeepEqual(f.Hashtags, []string{"#dog", "#table", "#day", "#light", "#extra"}) {
		t.Errorf("hashtags: %v", f.Hashtags)
	}
	// Order and prompts: one call per file, in order, the note only on file 2.
	if e.vision.callCount() != 3 {
		t.Fatalf("%d calls", e.vision.callCount())
	}
	for i, c := range e.vision.calls {
		if c.Model != "test-vision" || len(c.Images) != 1 || c.Temperature != 0.4 || c.Purpose != "Writing captions" || c.Seed != b.Items[i].Seed {
			t.Errorf("call %d: %+v", i, c)
		}
		if !strings.Contains(c.Prompt, "Lisbon trip. The dog is Max.") {
			t.Errorf("call %d lacks the context: %s", i, c.Prompt)
		}
		if has := strings.Contains(c.Prompt, "Note for this file: this is Max"); has != (i == 1) {
			t.Errorf("call %d note present = %v", i, has)
		}
		if !strings.Contains(c.System, NoIdentifyRule) {
			t.Errorf("call %d lacks the no-identification rule", i)
		}
		if !json.Valid(c.JSONSchema) {
			t.Errorf("schema: %s", c.JSONSchema)
		}
	}
	// Events, outputs, csv, Smart search.
	if len(e.events.list) != 3 || e.events.list[2].Index != 2 || e.events.list[0].Dir != dir || e.events.list[0].JobID != "job1" || e.events.list[0].Item.State != ItemDone {
		t.Errorf("events: %+v", e.events.list)
	}
	if !rec.hasOutput(BatchFile) || !rec.hasOutput(CSVFile) {
		t.Errorf("outputs: %+v", rec.outputs)
	}
	for _, o := range rec.outputs {
		if !reflect.DeepEqual(o.Inputs, in) {
			t.Errorf("lineage of %s: %v", o.Path, o.Inputs)
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, CSVFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), "\xef\xbb\xbf") {
		t.Error("csv has no BOM")
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(raw), "\xef\xbb\xbf"))).ReadAll()
	if err != nil || len(rows) != 4 || rows[0][0] != "file" || rows[1][0] != "a.jpg" || rows[1][1] != "A dog on a table" || rows[1][3] != "#dog #table #day #light #extra" {
		t.Errorf("csv: %v %v", rows, err)
	}
	if len(e.index.puts) != 3 {
		t.Errorf("PutText calls: %d", len(e.index.puts))
	}
	chunk := e.index.puts[in[0]]
	if len(chunk) != 1 || chunk[0].Source != core.TextSourceCaption || !strings.Contains(chunk[0].Text, "A dog on a table") || !strings.Contains(chunk[0].Text, "#dog") {
		t.Errorf("chunk: %+v", chunk)
	}
	for p, h := range hashFiles(t, in) {
		if before[p] != h {
			t.Errorf("input %s changed", p)
		}
	}
}

func TestRunCaptionFailedItemContinues(t *testing.T) {
	e := newEnv(t)
	in := photos(t, t.TempDir(), "a.jpg", "b.jpg", "c.jpg")
	// a: good. b: bad JSON twice. c: bad once, then good (the retry).
	e.vision.fn = func(n int, req core.CompletionRequest) (string, error) {
		switch n {
		case 0:
			return good("dog"), nil
		case 1, 2:
			return "I think this is a dog", nil
		case 3:
			return "```json\n{not json", nil
		}
		if strings.Contains(req.Prompt, RetryNote) {
			return "```json\n" + good("boat") + "\n```", nil
		}
		return "nope", nil
	}
	rec, err := mustRun(t, e, in, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := readBatchFile(rec.batchDir(t))
	states := []string{b.Items[0].State, b.Items[1].State, b.Items[2].State}
	if !reflect.DeepEqual(states, []string{ItemDone, ItemFailed, ItemDone}) {
		t.Fatalf("states %v", states)
	}
	if b.Items[1].Reason == "" || !strings.Contains(b.Items[1].Reason, "format") {
		t.Errorf("reason %q", b.Items[1].Reason)
	}
	if b.Items[2].Fields.Alt != "A boat on a table" {
		t.Errorf("retry result: %+v", b.Items[2].Fields)
	}
	var res result
	_ = json.Unmarshal(rec.result, &res)
	if res.Done != 2 || res.Failed != 1 {
		t.Errorf("result %+v", res)
	}
	if len(e.events.list) != 3 || e.events.list[1].Item.State != ItemFailed {
		t.Errorf("events %+v", e.events.list)
	}
	if len(e.index.puts) != 2 {
		t.Errorf("failed items must not be indexed: %d", len(e.index.puts))
	}
}

func TestRunCaptionCancelKeepsWhatIsDone(t *testing.T) {
	e := newEnv(t)
	in := photos(t, t.TempDir(), "a.jpg", "b.jpg", "c.jpg")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.vision.fn = func(n int, _ core.CompletionRequest) (string, error) {
		if n == 1 {
			cancel()
		}
		return good("dog"), nil
	}
	rec := &recorder{}
	err := e.m.Run(ctx, e.job(in, DefaultOptions(), rec))
	if err == nil || ctx.Err() == nil {
		t.Fatalf("want cancellation, got %v", err)
	}
	b, rerr := readBatchFile(rec.batchDir(t))
	if rerr != nil {
		t.Fatal(rerr)
	}
	got := []string{b.Items[0].State, b.Items[1].State, b.Items[2].State}
	if !reflect.DeepEqual(got, []string{ItemDone, ItemDone, ItemPending}) {
		t.Errorf("states %v", got)
	}
	if !rec.hasOutput(BatchFile) || !rec.hasOutput(CSVFile) {
		t.Error("the partial batch should still be registered")
	}
	if e.vision.callCount() != 2 {
		t.Errorf("%d calls", e.vision.callCount())
	}
}

func TestRunCaptionEngineFailureStops(t *testing.T) {
	e := newEnv(t)
	in := photos(t, t.TempDir(), "a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg")
	e.vision.fn = func(int, core.CompletionRequest) (string, error) {
		return "", core.Errorf(core.CodeToolFailed, "Not enough memory for the model")
	}
	rec, err := mustRun(t, e, in, DefaultOptions())
	if err == nil || !strings.Contains(err.Error(), "Not enough memory") {
		t.Fatalf("err %v", err)
	}
	if e.vision.callCount() != maxEngineFailures {
		t.Errorf("%d calls, want %d", e.vision.callCount(), maxEngineFailures)
	}
	b, _ := readBatchFile(rec.batchDir(t))
	if b.Items[0].State != ItemFailed || b.Items[4].State != ItemPending {
		t.Errorf("states %v %v", b.Items[0].State, b.Items[4].State)
	}
}

func TestRunCaptionNoVisionModel(t *testing.T) {
	e := newEnv(t)
	e.vision.visionEr = core.Errorf(core.CodeDependencyMissing, "Install the Caption Writer pack")
	in := photos(t, t.TempDir(), "a.jpg")
	_, err := mustRun(t, e, in, DefaultOptions())
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeDependencyMissing || ae.Message != "Install the Caption Writer pack" {
		t.Fatalf("err %v", err)
	}
	// An explicit model overrides the missing default.
	e.vision.replies = []string{good("dog")}
	o := DefaultOptions()
	o.Model = "my-model"
	if _, err := mustRun(t, e, in, o); err != nil {
		t.Fatal(err)
	}
	if e.vision.calls[0].Model != "my-model" {
		t.Errorf("model %q", e.vision.calls[0].Model)
	}
}

func TestRunCaptionHintsAndOptions(t *testing.T) {
	e := newEnv(t)
	e.index.labels = []string{"dog", "beach"}
	e.index.text = "OPEN 9-5"
	e.vision.replies = []string{`{"title":"Dog","keywords":["dog"],"description":"A dog.","name":"dog"}`}
	in := photos(t, t.TempDir(), "a.jpg")
	o := DefaultOptions()
	o.Preset = PresetCatalogue
	o.Language = "Portuguese"
	if _, err := mustRun(t, e, in, o); err != nil {
		t.Fatal(err)
	}
	c := e.vision.calls[0]
	if !strings.Contains(c.Prompt, "Hints: Labels: dog, beach; Text found: OPEN 9-5") {
		t.Errorf("prompt: %s", c.Prompt)
	}
	if !strings.Contains(c.System, "Write all text in Portuguese") {
		t.Errorf("system: %s", c.System)
	}
	// Hints off: not asked.
	e.index.asked = nil
	o.UseHints = false
	if _, err := mustRun(t, e, in, o); err != nil {
		t.Fatal(err)
	}
	if len(e.index.asked) != 0 || strings.Contains(e.vision.calls[1].Prompt, "Hints:") {
		t.Errorf("hints used while off: %v", e.index.asked)
	}
}

func TestRunCaptionSeeds(t *testing.T) {
	e := newEnv(t)
	e.vision.replies = []string{good("dog")}
	in := photos(t, t.TempDir(), "a.jpg", "b.jpg")
	o := DefaultOptions()
	if _, err := mustRun(t, e, in, o); err != nil {
		t.Fatal(err)
	}
	s := []int64{e.vision.calls[0].Seed, e.vision.calls[1].Seed}
	if s[0] == 0 || s[0] == s[1] || s[0] != seedFor(in[0]) {
		t.Errorf("seeds %v", s)
	}
	o.Seed = 7
	if _, err := mustRun(t, e, in, o); err != nil {
		t.Fatal(err)
	}
	if e.vision.calls[2].Seed != 7 {
		t.Errorf("seed %d", e.vision.calls[2].Seed)
	}
}

func TestRunCaptionVideoFrames(t *testing.T) {
	e := newEnv(t)
	logPath := e.useFakeTools()
	e.vision.replies = []string{good("dog")}
	dir := t.TempDir()
	vid := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(vid, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	rec, err := mustRun(t, e, []string{vid}, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	c := e.vision.calls[0]
	if len(c.Images) != VideoFrames || !strings.Contains(c.Prompt, "frames from one video") {
		t.Errorf("images %d, prompt %s", len(c.Images), c.Prompt)
	}
	log, _ := os.ReadFile(logPath)
	lines := strings.Split(strings.TrimSpace(string(log)), "\n")
	if len(lines) != VideoFrames || !strings.Contains(lines[0], "-ss\x1f5.000") || !strings.Contains(lines[5], "-ss\x1f55.000") {
		t.Errorf("ffmpeg calls: %q", lines)
	}
	if !strings.Contains(lines[0], "min(896,iw)") {
		t.Errorf("scale filter: %s", lines[0])
	}
	b, _ := readBatchFile(rec.batchDir(t))
	if b.Items[0].State != ItemDone {
		t.Errorf("item %+v", b.Items[0])
	}
}

func TestRunCaptionVideoNeedsFFmpeg(t *testing.T) {
	e := newEnv(t)
	e.vision.replies = []string{good("dog")}
	dir := t.TempDir()
	vid := filepath.Join(dir, "clip.mp4")
	_ = os.WriteFile(vid, []byte("video"), 0o644)
	in := append(photos(t, dir, "a.jpg"), vid)
	rec, err := mustRun(t, e, in, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := readBatchFile(rec.batchDir(t))
	if b.Items[0].State != ItemDone || b.Items[1].State != ItemFailed || b.Items[1].Reason != "Needs FFmpeg for videos" {
		t.Errorf("items %+v", b.Items)
	}
}

func TestRunCaptionNamesAndPatterns(t *testing.T) {
	e := newEnv(t)
	e.vision.replies = []string{`{"name":"Dog on the beach","title":"x"}`}
	in := photos(t, t.TempDir(), "a.jpg", "b.jpg")
	o := DefaultOptions()
	o.Preset = PresetRename
	o.NamePattern = NameNumber
	o.Kebab = true
	rec, err := mustRun(t, e, in, o)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := readBatchFile(rec.batchDir(t))
	if b.Items[0].Fields.Name != "01-dog-on-the-beach" || b.Items[1].Fields.Name != "02-dog-on-the-beach" {
		t.Errorf("names %q %q", b.Items[0].Fields.Name, b.Items[1].Fields.Name)
	}
	// Only the preset's fields are asked for.
	if s := string(e.vision.calls[0].JSONSchema); strings.Contains(s, "caption") || !strings.Contains(s, `"name"`) {
		t.Errorf("schema %s", s)
	}
	// {date} is the file's date.
	o.NamePattern = NameDate
	o.Kebab = false
	if _, err := mustRun(t, e, in[:1], o); err != nil {
		t.Fatal(err)
	}
}

func TestBatchFolderNaming(t *testing.T) {
	e := newEnv(t)
	e.vision.replies = []string{good("dog")}
	dir := filepath.Join(t.TempDir(), "Summer holiday")
	in := photos(t, dir, "a.jpg")
	rec, err := mustRun(t, e, in, DefaultOptions()) // no context: the input's folder
	if err != nil {
		t.Fatal(err)
	}
	d1 := rec.batchDir(t)
	if !strings.HasPrefix(filepath.Base(d1), "Summer holiday ") {
		t.Errorf("folder %q", d1)
	}
	rec2, err := mustRun(t, e, in, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if d2 := rec2.batchDir(t); d2 == d1 || !strings.Contains(filepath.Base(d2), "(1)") {
		t.Errorf("second batch %q should be unique", d2)
	}
	if got := batchName("one two three four five six", nil); got != "one two three four" {
		t.Errorf("name %q", got)
	}
	if got := batchName("", []string{"a/b.jpg"}); got != "a" {
		t.Errorf("name %q", got)
	}
}

func TestRegenerate(t *testing.T) {
	e := newEnv(t)
	in := photos(t, t.TempDir(), "a.jpg", "b.jpg")
	e.vision.replies = []string{good("dog"), good("cat")}
	rec, err := mustRun(t, e, in, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	dir := rec.batchDir(t)
	b, _ := readBatchFile(dir)
	oldSeed := b.Items[0].Seed
	// The user edited the caption of item 0 and the alt of item 1.
	m := e.m
	_, err = m.updateItem(dir, 0, func(it *Item) {
		it.Fields.Caption, it.Edited = "My own words", map[Field]bool{FieldCaption: true}
	})
	if err != nil {
		t.Fatal(err)
	}
	e.events.list = nil
	e.vision.replies = []string{good("fox")}
	ro := DefaultOptions()
	ro.Action, ro.Batch, ro.Index, ro.KeepEdited = ActionRegenerate, dir, 0, true
	if !m.IsInteractive(mustJSON(ro)) {
		t.Error("regenerating one item is interactive")
	}
	rrec := &recorder{}
	if err := m.Run(context.Background(), e.job(nil, ro, rrec)); err != nil {
		t.Fatal(err)
	}
	b, _ = readBatchFile(dir)
	f := b.Items[0].Fields
	if f.Caption != "My own words" || f.Alt != "A fox on a table" || b.Items[0].Seed == oldSeed || b.Items[0].Seed == 0 {
		t.Errorf("item 0 after regenerate: %+v seed %d (was %d)", f, b.Items[0].Seed, oldSeed)
	}
	if b.Items[1].Fields.Alt != "A cat on a table" {
		t.Errorf("item 1 should be untouched: %+v", b.Items[1].Fields)
	}
	if len(e.events.list) != 1 || e.events.list[0].Index != 0 {
		t.Errorf("events %+v", e.events.list)
	}
	if got := e.vision.calls[len(e.vision.calls)-1].Seed; got != b.Items[0].Seed {
		t.Errorf("seed used %d", got)
	}
	// Without KeepEdited, and for every item.
	e.vision.replies = []string{good("owl")}
	ro.Index, ro.KeepEdited = -1, false
	if m.IsInteractive(mustJSON(ro)) {
		t.Error("regenerating everything is not interactive")
	}
	if err := m.Run(context.Background(), e.job(nil, ro, &recorder{})); err != nil {
		t.Fatal(err)
	}
	b, _ = readBatchFile(dir)
	if b.Items[0].Fields.Caption != "Look at this owl" || b.Items[1].Fields.Alt != "An owl on a table" && b.Items[1].Fields.Alt != "A owl on a table" {
		t.Errorf("after regenerate all: %+v / %+v", b.Items[0].Fields, b.Items[1].Fields)
	}
	if b.Items[0].Edited[FieldCaption] {
		t.Error("edited flags should clear")
	}
	if len(e.index.puts) == 0 {
		t.Error("PutText expected")
	}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func TestValidate(t *testing.T) {
	e := newEnv(t)
	in := photos(t, t.TempDir(), "a.jpg")
	txt := filepath.Join(t.TempDir(), "a.txt")
	_ = os.WriteFile(txt, []byte("x"), 0o644)
	batch := filepath.Join(e.lib, "Captions", "B 2026-01-01")
	_ = os.MkdirAll(batch, 0o755)
	_ = os.WriteFile(filepath.Join(batch, BatchFile), []byte("{}"), 0o644)

	mod := func(f func(o *Options)) Options {
		o := DefaultOptions()
		f(&o)
		return o
	}
	tests := []struct {
		name   string
		inputs []string
		o      Options
		ok     bool
	}{
		{"ok", in, DefaultOptions(), true},
		{"no inputs", nil, DefaultOptions(), false},
		{"missing file", []string{filepath.Join(t.TempDir(), "nope.jpg")}, DefaultOptions(), false},
		{"unsupported", []string{txt}, DefaultOptions(), false},
		{"too many", make([]string, MaxInputs+1), DefaultOptions(), false},
		{"bad preset", in, mod(func(o *Options) { o.Preset = "x" }), false},
		{"bad tone", in, mod(func(o *Options) { o.Tone = "x" }), false},
		{"bad length", in, mod(func(o *Options) { o.Length = "x" }), false},
		{"bad pattern", in, mod(func(o *Options) { o.NamePattern = "x" }), false},
		{"hashtags 16", in, mod(func(o *Options) { o.Hashtags = 16 }), false},
		{"hashtags -1", in, mod(func(o *Options) { o.Hashtags = -1 }), false},
		{"hashtags 15", in, mod(func(o *Options) { o.Hashtags = 15 }), true},
		{"context long", in, mod(func(o *Options) { o.Context = strings.Repeat("é", MaxContext+1) }), false},
		{"context max", in, mod(func(o *Options) { o.Context = strings.Repeat("é", MaxContext) }), true},
		{"note long", in, mod(func(o *Options) { o.Notes = map[string]string{in[0]: strings.Repeat("x", MaxNote+1)} }), false},
		{"bad action", in, mod(func(o *Options) { o.Action = "x" }), false},
		{"write no batch", nil, mod(func(o *Options) { o.Action = ActionWrite }), false},
		{"write outside", nil, mod(func(o *Options) { o.Action, o.Batch = ActionWrite, filepath.Dir(in[0]) }), false},
		{"write the root", nil, mod(func(o *Options) { o.Action, o.Batch = ActionWrite, filepath.Join(e.lib, "Captions") }), false},
		{"write ok", nil, mod(func(o *Options) { o.Action, o.Batch = ActionWrite, batch }), true},
		{"rename ok", nil, mod(func(o *Options) { o.Action, o.Batch = ActionRename, batch }), true},
		{"regenerate ok", nil, mod(func(o *Options) { o.Action, o.Batch, o.Index = ActionRegenerate, batch, 0 }), true},
		{"regenerate missing batch", nil, mod(func(o *Options) { o.Action, o.Batch = ActionRegenerate, batch+"x" }), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := e.m.Validate(tt.inputs, mustJSON(tt.o))
			if (err == nil) != tt.ok {
				t.Errorf("err = %v, want ok=%v", err, tt.ok)
			}
		})
	}
	if err := e.m.Validate(in, json.RawMessage(`{"bogus":1}`)); err == nil {
		t.Error("unknown fields must be rejected")
	}
}
