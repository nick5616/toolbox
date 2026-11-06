//go:build integration

package documents

import (
	"archive/zip"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/deps"
)

// realTool finds pandoc/typst on PATH or in $TOOLBOX_PANDOC / $TOOLBOX_TYPST,
// else skips (the managed copies live in the app's tools folder).
func realTool(t *testing.T, id string) string {
	t.Helper()
	if p := os.Getenv("TOOLBOX_" + strings.ToUpper(id)); p != "" {
		return p
	}
	p, err := exec.LookPath(id)
	if err != nil {
		t.Skipf("%s not found", id)
	}
	return p
}

func realJob(t *testing.T, input string, opts Options) (*core.JobContext, *[]string) {
	t.Helper()
	pandoc, typst := realTool(t, deps.Pandoc), ""
	if opts.To == FormatPDF {
		typst = realTool(t, deps.Typst)
	}
	var outs []string
	raw, _ := json.Marshal(opts)
	return core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: []string{input}, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) { outs = append(outs, p); return core.Output{Path: p}, nil },
		Tool: func(id string) (string, error) {
			if id == deps.Typst {
				return typst, nil
			}
			return pandoc, nil
		},
	}), &outs
}

func writeSample(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const mdSample = "# Title\n\nSome *emphasis* and a list:\n\n- one\n- two\n"

func runReal(t *testing.T, input string, opts Options) string {
	t.Helper()
	job, outs := realJob(t, input, opts)
	if err := New(t.TempDir()).Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(*outs) != 1 {
		t.Fatalf("outputs = %v", *outs)
	}
	return (*outs)[0]
}

func TestMarkdownToDocxAndBack(t *testing.T) {
	docx := runReal(t, writeSample(t, "a.md", mdSample), optsTo(FormatDOCX))
	zr, err := zip.OpenReader(docx)
	if err != nil {
		t.Fatalf("docx is not a zip: %v", err)
	}
	zr.Close()
	md := runReal(t, docx, optsTo(FormatMD))
	b, _ := os.ReadFile(md)
	if !strings.Contains(string(b), "Title") || !strings.Contains(string(b), "emphasis") {
		t.Errorf("round trip lost text: %q", b)
	}
}

func TestMarkdownToPDF(t *testing.T) {
	pdf := runReal(t, writeSample(t, "a.md", mdSample), optsTo(FormatPDF))
	b, _ := os.ReadFile(pdf)
	if !strings.HasPrefix(string(b), "%PDF") {
		t.Errorf("not a PDF: %.8q", b)
	}
}

func TestHTMLToEPUB(t *testing.T) {
	epub := runReal(t, writeSample(t, "a.html", "<html><head><title>T</title></head><body><h1>Hi</h1><p>text</p></body></html>"), optsTo(FormatEPUB))
	zr, err := zip.OpenReader(epub)
	if err != nil {
		t.Fatalf("epub is not a zip: %v", err)
	}
	zr.Close()
}
