package ocr

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	tests := []struct {
		name    string
		opts    string
		summary string
		roles   []string
		hasText bool
		problem string
	}{
		{"defaults", ``, "Latin · PDFs: searchable PDF · images: text", []string{"text", "pdf"}, true, ""},
		{"text for pdfs, json for images", `{"pdfOutput":"text","imageOutput":"json"}`, "Latin · PDFs: text · images: text + positions", []string{"json", "text"}, true, ""},
		{"both, json", `{"pdfOutput":"both","imageOutput":"json","language":"greek"}`, "Greek · PDFs: searchable PDF + text · images: text + positions", []string{"json", "text", "pdf"}, true, ""},
		{"no text anywhere", `{"pdfOutput":"searchable","imageOutput":"json"}`, "Latin · PDFs: searchable PDF · images: text + positions", []string{"json", "pdf"}, false, ""},
		{"bad language", `{"language":"klingon"}`, "", nil, false, "Choose a supported language"},
		{"bad pdf output", `{"pdfOutput":"zip"}`, "", nil, false, "Choose searchable PDF, text or both"},
	}
	m := &Module{}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, err := m.DescribeStep(json.RawMessage(tt.opts))
			if tt.problem != "" {
				if err == nil || core.AsAppError(err).Message != tt.problem {
					t.Fatalf("err = %v, want %q", err, tt.problem)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != tt.summary {
				t.Errorf("summary = %q, want %q", info.Summary, tt.summary)
			}
			var roles []string
			for _, p := range info.Produces {
				roles = append(roles, p.Role)
			}
			if !slices.Equal(roles, tt.roles) {
				t.Errorf("roles = %v, want %v", roles, tt.roles)
			}
			if has := len(info.Vars) == 1 && info.Vars[0].Name == "text"; has != tt.hasText {
				t.Errorf("vars = %+v, want text var = %v", info.Vars, tt.hasText)
			}
			if !slices.Contains(info.Accepts.Extensions, ".pdf") || !slices.Contains(info.Accepts.Extensions, ".png") {
				t.Errorf("accepts = %+v", info.Accepts)
			}
		})
	}
}

func TestPrepareStep(t *testing.T) {
	dir := t.TempDir()
	var files []core.RunFile
	for _, n := range []string{"a.png", "b.jpg"} {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		files = append(files, core.RunFile{Path: p})
	}
	m := &Module{}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"imageOutput":"json"}`),
		Item:    core.StepItem{Files: files},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Fatalf("jobs = %+v", jobs)
	}
	if o := jobs[0].Options.(Options); o.ImageOutput != ImageJSON || o.Language != LangLatin || o.PDFOutput != PDFSearchable || !o.SkipText {
		t.Errorf("options = %+v", o)
	}
}

func TestStepOutputs(t *testing.T) {
	dir := t.TempDir()
	txt := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(txt, []byte("Hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := (&Module{}).StepOutputs(core.Job{Outputs: []core.Output{
		{ID: "1", Path: filepath.Join(dir, "a.pdf"), Name: "a.pdf", Kind: core.KindDocument},
		{ID: "2", Path: txt, Name: "a.txt", Kind: core.KindDocument},
		{ID: "3", Path: filepath.Join(dir, "a.json"), Name: "a.json", Kind: core.KindDocument},
	}})
	if err != nil {
		t.Fatal(err)
	}
	roles := []string{res.Files[0].Role, res.Files[1].Role, res.Files[2].Role}
	if !slices.Equal(roles, []string{"pdf", "text", "json"}) || res.Files[0].RoleLabel != "Searchable PDF" {
		t.Errorf("files = %+v", res.Files)
	}
	if res.Vars["text"] != "Hello\nworld" {
		t.Errorf("text = %q", res.Vars["text"])
	}

	res, err = (&Module{}).StepOutputs(core.Job{Outputs: []core.Output{{ID: "1", Path: filepath.Join(dir, "x.pdf"), Name: "x.pdf"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := res.Vars["text"]; ok {
		t.Error("no .txt output, no text variable")
	}
}
