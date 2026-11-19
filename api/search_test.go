package api

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

type fakeIndex struct {
	q      core.SearchQuery
	texts  []core.MediaText
	label  string
	on     bool
	limit  int
	retry  []string
	called bool
}

func (f *fakeIndex) Status() core.SearchStatus { return core.SearchStatus{} }
func (f *fakeIndex) Query(_ context.Context, q core.SearchQuery) (core.SearchPage, error) {
	f.q = q
	return core.SearchPage{}, nil
}
func (f *fakeIndex) Things(context.Context) ([]core.LabelCount, error) { return nil, nil }
func (f *fakeIndex) Labels(context.Context, string) ([]core.MediaLabel, error) {
	return nil, nil
}
func (f *fakeIndex) SetUserLabel(_ context.Context, _, label string, on bool) error {
	f.label, f.on, f.called = label, on, true
	return nil
}
func (f *fakeIndex) Texts(context.Context, string) ([]core.MediaText, error) { return f.texts, nil }
func (f *fakeIndex) ReadAgain(context.Context, string) error                 { return nil }
func (f *fakeIndex) Failures(_ context.Context, limit int) ([]core.SearchFailure, error) {
	f.limit = limit
	return nil, nil
}
func (f *fakeIndex) Retry(_ context.Context, p []string) error { f.retry = p; return nil }
func (f *fakeIndex) Settings() core.SearchSettings             { return core.DefaultSearchSettings() }
func (f *fakeIndex) SetSettings(context.Context, core.SearchSettings) error {
	return nil
}
func (f *fakeIndex) Rescan() error                     { return nil }
func (f *fakeIndex) Rebuild(context.Context) error     { return nil }
func (f *fakeIndex) DeleteIndex(context.Context) error { return nil }
func (f *fakeIndex) Warm()                             {}

func isValidation(err error) bool {
	ae := core.AsAppError(err)
	return ae != nil && ae.Code == core.CodeValidation
}

func TestQueryLimitClamp(t *testing.T) {
	for _, c := range []struct{ in, want int }{{0, 200}, {-3, 200}, {50, 50}, {900, 500}} {
		f := &fakeIndex{}
		s := &SearchService{Index: f}
		if _, err := s.Query(core.SearchQuery{Limit: c.in}); err != nil {
			t.Fatal(err)
		}
		if f.q.Limit != c.want {
			t.Errorf("limit %d -> %d, want %d", c.in, f.q.Limit, c.want)
		}
	}
	s := &SearchService{Index: &fakeIndex{}}
	if _, err := s.Query(core.SearchQuery{Similar: "rel/x.png"}); !isValidation(err) {
		t.Errorf("relative similar path: %v", err)
	}
}

func TestSetLabelRules(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "a.png")
	f := &fakeIndex{}
	s := &SearchService{Index: f}
	if err := s.SetLabel(abs, "  Red Door ", true); err != nil || f.label != "red door" || !f.on {
		t.Fatalf("got %q %v err %v", f.label, f.on, err)
	}
	for name, label := range map[string]string{"empty": "  ", "long": strings.Repeat("x", 41), "control": "a\x07b"} {
		f.called = false
		if err := s.SetLabel(abs, label, true); !isValidation(err) || f.called {
			t.Errorf("%s: err %v called %v", name, err, f.called)
		}
	}
	if err := s.SetLabel("a.png", "ok", true); !isValidation(err) {
		t.Errorf("relative path: %v", err)
	}
}

func TestFailuresAndRetry(t *testing.T) {
	f := &fakeIndex{}
	s := &SearchService{Index: f}
	_, _ = s.Failures(10000)
	if f.limit != 500 {
		t.Errorf("limit %d", f.limit)
	}
	if err := s.Retry([]string{"x.png"}); !isValidation(err) {
		t.Errorf("retry relative: %v", err)
	}
}

func TestSaveTextTxt(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "talk.mp4")
	f := &fakeIndex{texts: []core.MediaText{
		{Source: core.TextSourceSpeech, Pos: 65000, EndPos: 70000, Text: "second line"},
		{Source: core.TextSourceSpeech, Pos: 0, EndPos: 4000, Text: "first line"},
		{Source: core.TextSourceOCR, Pos: -1, EndPos: -1, Text: "EXIT"},
	}}
	var gotTitle, gotName string
	s := &SearchService{Index: f, SaveDialog: func(title, name string) (string, error) {
		gotTitle, gotName = title, name
		return filepath.Join(dir, name), nil
	}}
	out, err := s.SaveText(in, "txt")
	if err != nil {
		t.Fatal(err)
	}
	if gotName != "talk (text).txt" || gotTitle == "" {
		t.Errorf("dialog %q %q", gotTitle, gotName)
	}
	b, _ := os.ReadFile(out)
	want := "Words read in the picture\nEXIT\n\nSpeech\n[0:00] first line\n[1:05] second line\n"
	if string(b) != want {
		t.Errorf("got %q want %q", b, want)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".toolbox-text-*")); len(left) != 0 {
		t.Errorf("temp files left: %v", left)
	}
}

func TestSaveTextSRT(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "talk.mp4")
	f := &fakeIndex{texts: []core.MediaText{
		{Source: core.TextSourceSpeech, Pos: 3_723_004, EndPos: 3_725_000, Text: "late"},
		{Source: core.TextSourceSpeech, Pos: 1000, EndPos: 2500, Text: "early"},
		{Source: core.TextSourceOCR, Pos: -1, Text: "ignored"},
	}}
	var gotName string
	s := &SearchService{Index: f, SaveDialog: func(_, name string) (string, error) {
		gotName = name
		return filepath.Join(dir, name), nil
	}}
	out, err := s.SaveText(in, "srt")
	if err != nil {
		t.Fatal(err)
	}
	if gotName != "talk.srt" {
		t.Errorf("name %q", gotName)
	}
	b, _ := os.ReadFile(out)
	want := "1\n00:00:01,000 --> 00:00:02,500\nearly\n\n2\n01:02:03,004 --> 01:02:05,000\nlate\n\n"
	if string(b) != want {
		t.Errorf("got %q want %q", b, want)
	}
}

func TestSaveTextEdges(t *testing.T) {
	dir := t.TempDir()
	in := filepath.Join(dir, "pic.png")
	if err := os.WriteFile(in, []byte("orig"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := &fakeIndex{texts: []core.MediaText{{Source: core.TextSourceOCR, Pos: -1, Text: "hello"}}}
	dest := ""
	s := &SearchService{Index: f, SaveDialog: func(string, string) (string, error) { return dest, nil }}

	// no transcript
	if _, err := s.SaveText(in, "srt"); !isValidation(err) || !strings.Contains(err.Error(), "no transcript") {
		t.Errorf("srt without speech: %v", err)
	}
	// cancelled
	if out, err := s.SaveText(in, "txt"); out != "" || err != nil {
		t.Errorf("cancel: %q %v", out, err)
	}
	// never overwrite the input
	dest = in
	if _, err := s.SaveText(in, "txt"); !isValidation(err) {
		t.Errorf("overwrite input: %v", err)
	}
	if b, _ := os.ReadFile(in); string(b) != "orig" {
		t.Errorf("input changed: %q", b)
	}
	// bad format / relative path
	if _, err := s.SaveText(in, "pdf"); !isValidation(err) {
		t.Errorf("format: %v", err)
	}
	if _, err := s.SaveText("pic.png", "txt"); !isValidation(err) {
		t.Errorf("relative: %v", err)
	}
	// nothing to save
	empty := &SearchService{Index: &fakeIndex{}, SaveDialog: s.SaveDialog}
	if _, err := empty.SaveText(in, "txt"); !isValidation(err) {
		t.Errorf("empty: %v", err)
	}
}
