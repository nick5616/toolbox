package pipelines

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func adapter(h *harness, a Action) *step { return &step{m: h.m, action: a} }

// jobOptions decodes the Options of a prepared job.
func jobOptions(t *testing.T, j core.StepJob) Options {
	t.Helper()
	var o Options
	if err := json.Unmarshal(mustJSON(t, j.Options), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

func TestDescribeStepSummaries(t *testing.T) {
	ok := t.TempDir()
	tg := &fakeTG{reply: nil}
	h := newHarness(t, tg)
	cases := []struct {
		name    string
		action  Action
		opts    any
		summary string
		check   func(t *testing.T, info core.StepInfo)
	}{
		{"rename", ActionRename, RenameStep{Template: "{name} · {bpm} BPM"}, "Rename to {name} · {bpm} BPM", func(t *testing.T, i core.StepInfo) {
			if len(i.Produces) != 1 || !i.Produces[0].Many || i.Templates[0] != "/template" {
				t.Fatalf("info = %+v", i)
			}
		}},
		{"write md", ActionChat, ChatStep{Mode: ChatWrite, Prompt: "p", OutputName: "n", Format: FormatMD, Temperature: 0.3}, "Write notes (Markdown)", func(t *testing.T, i core.StepInfo) {
			if !i.NoFiles || i.Produces[0].Exts[0] != ".md" || i.Vars[0].Name != "reply" || len(i.Warnings) != 0 {
				t.Fatalf("info = %+v", i)
			}
		}},
		{"write txt", ActionChat, ChatStep{Mode: ChatWrite, Prompt: "p", OutputName: "n", Format: FormatTXT}, "Write notes (Text)", nil},
		{"extract", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p", Fields: receiptFields, SaveJSON: true}, "Extract 3 fields", func(t *testing.T, i core.StepInfo) {
			if len(i.Vars) != 3 || i.Vars[1].Name != "merchant" || len(i.Produces) != 1 || i.Produces[0].Role != "json" {
				t.Fatalf("info = %+v", i)
			}
		}},
		{"extract one", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p", Fields: receiptFields[:1]}, "Extract 1 field", func(t *testing.T, i core.StepInfo) {
			if len(i.Produces) != 0 {
				t.Fatalf("no JSON saved, but produces %+v", i.Produces)
			}
		}},
		{"table", ActionTable, TableStep{Name: "t", Columns: []TableColumn{{"a", "{x}"}, {"b", "{y}"}}}, "CSV · 2 columns", func(t *testing.T, i core.StepInfo) {
			if !i.Together || !i.NoFiles || len(i.Templates) != 3 || i.Templates[2] != "/columns/1/value" {
				t.Fatalf("info = %+v", i)
			}
		}},
		{"zip together", ActionZip, ZipStep{Together: true, Name: "z"}, "One zip for the run", func(t *testing.T, i core.StepInfo) {
			if !i.Together {
				t.Fatal("should be together")
			}
		}},
		{"zip each", ActionZip, ZipStep{Name: "{item}"}, "One zip per item", func(t *testing.T, i core.StepInfo) {
			if i.Together {
				t.Fatal("should not be together")
			}
		}},
		{"copy", ActionCopy, CopyStep{Folder: ok, Subfolder: "{pipeline}/{date}"}, "Copy to " + ok, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			info, err := adapter(h, c.action).DescribeStep(mustJSON(t, c.opts))
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != c.summary {
				t.Fatalf("summary = %q, want %q", info.Summary, c.summary)
			}
			if info.Warnings == nil || info.Vars == nil || info.Secrets == nil {
				t.Fatal("slices must be non-nil")
			}
			if c.check != nil {
				c.check(t, info)
			}
		})
	}
}

func TestDescribeStepProblems(t *testing.T) {
	h := newHarness(t, &fakeTG{})
	tooLong := strings.Repeat("x", maxPromptChars+1)
	var many []ChatField
	for i := 0; i < 13; i++ {
		many = append(many, ChatField{Name: "f" + strings.Repeat("a", i), Label: "L", Type: "text"})
	}
	var cols []TableColumn
	for i := 0; i < 31; i++ {
		cols = append(cols, TableColumn{Header: "h", Value: "v"})
	}
	file := writeFile(t, filepath.Join(t.TempDir(), "f.txt"), "x")
	cases := []struct {
		name   string
		action Action
		opts   any
		want   string
	}{
		{"empty template", ActionRename, RenameStep{Template: "  "}, "new name"},
		{"unknown field", ActionRename, map[string]any{"template": "x", "bogus": 1}, "Invalid options"},
		{"bad mode", ActionChat, ChatStep{Mode: "chat", Prompt: "p"}, "write text or extract"},
		{"no prompt", ActionChat, ChatStep{Mode: ChatWrite, OutputName: "n", Format: FormatMD}, "prompt"},
		{"long prompt", ActionChat, ChatStep{Mode: ChatWrite, Prompt: tooLong, OutputName: "n", Format: FormatMD}, "at most 8000"},
		{"long system", ActionChat, ChatStep{Mode: ChatWrite, Prompt: "p", System: strings.Repeat("s", maxSystemChars+1), OutputName: "n", Format: FormatMD}, "instructions"},
		{"temperature", ActionChat, ChatStep{Mode: ChatWrite, Prompt: "p", OutputName: "n", Format: FormatMD, Temperature: 1.6}, "Temperature"},
		{"bad format", ActionChat, ChatStep{Mode: ChatWrite, Prompt: "p", OutputName: "n", Format: "doc"}, "Markdown or plain"},
		{"no fields", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p"}, "1 to 12"},
		{"too many fields", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p", Fields: many}, "1 to 12"},
		{"builtin name", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p", Fields: []ChatField{{Name: "date", Label: "D", Type: "date"}}}, "built-in"},
		{"bad name", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p", Fields: []ChatField{{Name: "Total", Label: "D", Type: "text"}}}, "lowercase"},
		{"dup name", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p", Fields: []ChatField{{Name: "a", Label: "A", Type: "text"}, {Name: "a", Label: "B", Type: "text"}}}, "twice"},
		{"bad type", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p", Fields: []ChatField{{Name: "a", Label: "A", Type: "blob"}}}, "text, number or date"},
		{"no label", ActionChat, ChatStep{Mode: ChatExtract, Prompt: "p", Fields: []ChatField{{Name: "a", Type: "text"}}}, "label"},
		{"no columns", ActionTable, TableStep{Name: "t"}, "1 to 30"},
		{"too many columns", ActionTable, TableStep{Name: "t", Columns: cols}, "1 to 30"},
		{"no heading", ActionTable, TableStep{Name: "t", Columns: []TableColumn{{Header: "", Value: "v"}}}, "heading"},
		{"no zip name", ActionZip, ZipStep{Together: true}, "name for the zip"},
		{"no folder", ActionCopy, CopyStep{}, "Choose a folder"},
		{"relative folder", ActionCopy, CopyStep{Folder: "x/y"}, "full path"},
		{"missing folder", ActionCopy, CopyStep{Folder: filepath.Join(t.TempDir(), "nope")}, "doesn't exist"},
		{"folder is a file", ActionCopy, CopyStep{Folder: file}, "isn't a folder"},
		{"in library", ActionCopy, CopyStep{Folder: h.library}, "outside your Library"},
		{"dotdot", ActionCopy, CopyStep{Folder: t.TempDir(), Subfolder: "a/../b"}, "can't go up"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := adapter(h, c.action).DescribeStep(mustJSON(t, c.opts))
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Code != core.CodeValidation || !strings.Contains(ae.Message, c.want) {
				t.Fatalf("err = %v, want a validation error containing %q", err, c.want)
			}
		})
	}
}

func TestDescribeChatWarnsWhenNotReady(t *testing.T) {
	opts := mustJSON(t, ChatStep{Mode: ChatWrite, Prompt: "p", OutputName: "n", Format: FormatMD})
	h := newHarness(t, &fakeTG{ready: core.Errorf(core.CodeDependencyMissing, "No chat model").WithHint("Download a model in Local Chat first")})
	info, err := adapter(h, ActionChat).DescribeStep(opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Warnings) != 1 || info.Warnings[0] != "No chat model · Download a model in Local Chat first" {
		t.Fatalf("warnings = %v", info.Warnings)
	}
	h = newHarness(t, nil)
	if info, _ = adapter(h, ActionChat).DescribeStep(opts); len(info.Warnings) != 1 {
		t.Fatalf("no generator should warn: %v", info.Warnings)
	}
}

func TestPrepareRename(t *testing.T) {
	h := newHarness(t, nil)
	req := core.StepRequest{
		Pipeline: "Sampling", Options: mustJSON(t, RenameStep{Template: "{name} · {bpm} BPM · {role}"}),
		Item: core.StepItem{Index: 0, Label: "Song", Vars: map[string]string{"name": "Song", "bpm": "128"}, Files: []core.RunFile{
			{Path: "/lib/Stems/Song (bass).flac", Name: "Song (bass).flac", Role: "bass", RoleLabel: "Bass", OutputID: "o1"},
			{Path: "/in/other.wav", Name: "other.wav"},
		}},
	}
	jobs, err := adapter(h, ActionRename).PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v err = %v", jobs, err)
	}
	o := jobOptions(t, jobs[0])
	if o.Action != ActionRename || o.Pipeline != "Sampling" || len(o.Rename) != 2 {
		t.Fatalf("options = %+v", o)
	}
	a, b := o.Rename[0], o.Rename[1]
	if a.Name != "Song (bass) · 128 BPM · Bass" || !a.Move || a.OutputID != "o1" || a.Role != "bass" || a.RoleLabel != "Bass" {
		t.Fatalf("op a = %+v", a)
	}
	if b.Name != "other · 128 BPM · " || b.Move {
		t.Fatalf("op b = %+v", b)
	}
	if len(jobs[0].Inputs) != 2 {
		t.Fatalf("inputs = %v", jobs[0].Inputs)
	}
	// the options pass the module's own Validate
	if err := h.m.Validate(jobs[0].Inputs, mustJSON(t, jobs[0].Options)); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareRenameSplitsBigRuns(t *testing.T) {
	h := newHarness(t, nil)
	var files []core.RunFile
	for i := 0; i < 250; i++ {
		files = append(files, core.RunFile{Path: filepath.Join("/in", fmt.Sprintf("f%d.wav", i)), OutputID: "o"})
	}
	jobs, err := adapter(h, ActionRename).PrepareStep(context.Background(), core.StepRequest{
		Options: mustJSON(t, DefaultRename()), Item: core.StepItem{Files: files, Vars: map[string]string{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 3 {
		t.Fatalf("%d jobs, want 3 chunks of ≤ %d", len(jobs), maxOpsPerJob)
	}
}

func TestPrepareChatCollectsFileAndUsedVars(t *testing.T) {
	h := newHarness(t, &fakeTG{})
	dir := t.TempDir()
	srt := writeFile(t, filepath.Join(dir, "a.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHello\n")
	txt := writeFile(t, filepath.Join(dir, "b.txt"), "World")
	wav := writeFile(t, filepath.Join(dir, "c.wav"), "RIFF")
	req := core.StepRequest{
		Pipeline: "Lecture",
		Options: mustJSON(t, ChatStep{Mode: ChatWrite, System: "Answer in {language}", Prompt: "Notes of {file} about {item} {missing}",
			OutputName: "{item} (study notes)", Format: FormatMD, Temperature: 0.3}),
		Item: core.StepItem{Label: "L1", Vars: map[string]string{"item": "L1", "language": "en", "unused": "zzz", "name": "L1"},
			Files: []core.RunFile{{Path: srt}, {Path: txt}, {Path: wav}}},
	}
	jobs, err := adapter(h, ActionChat).PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v err = %v", jobs, err)
	}
	c := jobOptions(t, jobs[0]).Chat
	if c == nil {
		t.Fatal("no chat options")
	}
	if c.Vars["file"] != "Hello\n\nWorld" || c.Vars["item"] != "L1" || c.Vars["language"] != "en" {
		t.Fatalf("vars = %v", c.Vars)
	}
	if _, ok := c.Vars["unused"]; ok {
		t.Fatal("only the variables the prompt uses may be passed")
	}
	if c.OutputName != "L1 (study notes)" || c.Prompt != "Notes of {file} about {item} {missing}" || c.Label != "Lecture" {
		t.Fatalf("chat = %+v", c)
	}
	if err := h.m.Validate(jobs[0].Inputs, mustJSON(t, jobs[0].Options)); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareChatRefusesBigFiles(t *testing.T) {
	h := newHarness(t, &fakeTG{})
	big := writeFile(t, filepath.Join(t.TempDir(), "big.txt"), strings.Repeat("a", maxTextFileBytes+1))
	_, err := adapter(h, ActionChat).PrepareStep(context.Background(), core.StepRequest{
		Options: mustJSON(t, ChatStep{Mode: ChatWrite, Prompt: "{file}", OutputName: "n", Format: FormatMD}),
		Item:    core.StepItem{Files: []core.RunFile{{Path: big}}},
	})
	if err == nil || !strings.Contains(err.Error(), "256 KiB") {
		t.Fatalf("err = %v", err)
	}
}

func TestPrepareChatExtractNamesJSONAfterItem(t *testing.T) {
	h := newHarness(t, &fakeTG{})
	jobs, err := adapter(h, ActionChat).PrepareStep(context.Background(), core.StepRequest{
		Pipeline: "Receipts",
		Options:  mustJSON(t, ChatStep{Mode: ChatExtract, Prompt: "{text}", Fields: receiptFields, SaveJSON: true}),
		Item:     core.StepItem{Label: "r1.jpg", Vars: map[string]string{"item": "r1", "text": "Cafe"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := jobOptions(t, jobs[0]).Chat
	if c.OutputName != "r1" || len(c.Fields) != 3 || c.Vars["text"] != "Cafe" {
		t.Fatalf("chat = %+v", c)
	}
}

func TestPrepareTableRowsPerItem(t *testing.T) {
	h := newHarness(t, nil)
	var cols []TableColumn
	for _, p := range [][2]string{{"File", "{item}"}, {"Merchant", "{merchant}"}, {"Total", "{total} {currency}"}} {
		cols = append(cols, TableColumn{p[0], p[1]})
	}
	req := core.StepRequest{
		Pipeline: "Receipts", Started: 1767268800000, // 2026-01-01T12:00:00Z
		Options: mustJSON(t, TableStep{Name: "{pipeline} {date}", Columns: cols}),
		Items: []core.StepItem{
			{Index: 3, Vars: map[string]string{"item": "r1", "merchant": "Cafe", "total": "4.50", "currency": "EUR", "pipeline": "Receipts", "date": "2026-01-01"}},
			{Index: 4, Vars: map[string]string{"item": "r2", "merchant": "Shop", "total": "9", "currency": "USD", "pipeline": "Receipts", "date": "2026-01-01"}},
			{Index: 5, Vars: map[string]string{"item": "r3"}},
		},
	}
	jobs, err := adapter(h, ActionTable).PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v err = %v", jobs, err)
	}
	tb := jobOptions(t, jobs[0]).Table
	if tb.Name != "Receipts 2026-01-01" || strings.Join(tb.Header, ",") != "File,Merchant,Total" {
		t.Fatalf("table = %+v", tb)
	}
	got := [][]string{{"r1", "Cafe", "4.50 EUR"}, {"r2", "Shop", "9 USD"}, {"r3", "", " "}}
	for i, row := range tb.Rows {
		if strings.Join(row, "|") != strings.Join(got[i], "|") {
			t.Fatalf("row %d = %q, want %q", i, row, got[i])
		}
	}
}

func TestPrepareZipTogetherAndPerItem(t *testing.T) {
	h := newHarness(t, nil)
	f := func(ps ...string) []core.RunFile {
		var out []core.RunFile
		for _, p := range ps {
			out = append(out, core.RunFile{Path: p})
		}
		return out
	}
	req := core.StepRequest{
		Pipeline: "Before sharing", Started: 1767268800000,
		Options: mustJSON(t, ZipStep{Together: true, Name: "{pipeline} {date}"}),
		Items: []core.StepItem{
			{Files: f("/a/1.png", "/a/2.png"), Vars: map[string]string{"item": "one"}},
			{Files: f("/a/2.png", "/a/3.png"), Vars: map[string]string{"item": "two"}},
		},
	}
	jobs, err := adapter(h, ActionZip).PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v err = %v", jobs, err)
	}
	z := jobOptions(t, jobs[0]).Zip
	if strings.Join(z.Files, ",") != "/a/1.png,/a/2.png,/a/3.png" || z.Name != "Before sharing 2026-01-01" {
		t.Fatalf("zip = %+v", z)
	}

	req = core.StepRequest{
		Pipeline: "P", Options: mustJSON(t, ZipStep{Name: "{item}"}),
		Item: core.StepItem{Files: f("/a/1.png"), Vars: map[string]string{"item": "one"}},
	}
	jobs, err = adapter(h, ActionZip).PrepareStep(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if z := jobOptions(t, jobs[0]).Zip; z.Name != "one" || len(z.Files) != 1 {
		t.Fatalf("zip = %+v", z)
	}
}

func TestPrepareCopyBuildsSubfolder(t *testing.T) {
	h := newHarness(t, nil)
	dest := t.TempDir()
	jobs, err := adapter(h, ActionCopy).PrepareStep(context.Background(), core.StepRequest{
		Pipeline: "My: Pipe", Options: mustJSON(t, CopyStep{Folder: dest, Subfolder: "{pipeline}/{date}/x"}),
		Item: core.StepItem{Vars: map[string]string{"pipeline": "My: Pipe", "date": "2026-01-01"},
			Files: []core.RunFile{{Path: "/a/1.png", Role: "r", RoleLabel: "R", OutputID: "o1"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := jobOptions(t, jobs[0]).Copy
	want := filepath.Join(dest, "My- Pipe", "2026-01-01", "x")
	if c.Folder != want || len(c.Carry) != 1 || c.Carry[0].OutputID != "o1" {
		t.Fatalf("copy = %+v, want folder %s", c, want)
	}
}

func TestStepOutputsOfCopyAndEmpty(t *testing.T) {
	h := newHarness(t, nil)
	res, err := adapter(h, ActionTable).StepOutputs(core.Job{})
	if err != nil || len(res.Files) != 0 || res.Vars == nil {
		t.Fatalf("empty = %+v %v", res, err)
	}
	if _, err := adapter(h, ActionZip).StepOutputs(core.Job{ResultJSON: "{nope"}); err == nil {
		t.Fatal("want a decode error")
	}
}

// End to end through the adapter: Prepare, Validate, Run, StepOutputs.
func TestRenameThroughAdapter(t *testing.T) {
	h := newHarness(t, nil)
	made := writeFile(t, filepath.Join(h.library, "Stems", "Song (bass).flac"), "f")
	id := h.outputs.add(made)
	s := adapter(h, ActionRename)
	jobs, err := s.PrepareStep(context.Background(), core.StepRequest{
		Pipeline: "Sampling", Options: mustJSON(t, RenameStep{Template: "{name} · {bpm} BPM"}),
		Item: core.StepItem{Vars: map[string]string{"bpm": "128"}, Files: []core.RunFile{{Path: made, Role: "bass", RoleLabel: "Bass", OutputID: id.ID}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec, err := h.run(jobOptions(t, jobs[0]))
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.StepOutputs(core.Job{ID: "j", ResultJSON: string(rec.result)})
	if err != nil || len(res.Files) != 1 {
		t.Fatalf("outputs = %+v %v", res, err)
	}
	f := res.Files[0]
	if filepath.Base(f.Path) != "Song (bass) · 128 BPM.flac" || f.Role != "bass" || f.RoleLabel != "Bass" || f.OutputID != id.ID || f.Kind != core.KindAudio {
		t.Fatalf("file = %+v", f)
	}
}
