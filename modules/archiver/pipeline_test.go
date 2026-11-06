package archiver

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"

	"toolbox/core"
)

func TestLinksFromList(t *testing.T) {
	txt := "\r\n# my links\r\nhttps://a.example/1\r\n  http://b.example/2  \r\nnot a link\r\nftp://x/y\r\n"
	want := []string{"https://a.example/1", "http://b.example/2"}
	if got := linksFromList(txt); !reflect.DeepEqual(got, want) {
		t.Errorf("txt = %v", got)
	}
	url := "[InternetShortcut]\r\nURL=https://c.example/page?a=b=c\r\nIconIndex=0\r\n"
	if got := linksFromList(url); !reflect.DeepEqual(got, []string{"https://c.example/page?a=b=c"}) {
		t.Errorf("url = %v", got)
	}
}

func TestDescribeStep(t *testing.T) {
	m := fakeModule()
	info, err := m.DescribeStep(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 1 || info.Produces[0].Role != "page" {
		t.Errorf("produces = %+v", info.Produces)
	}
	info, err = m.DescribeStep(json.RawMessage(`{"alsoPdf":true,"renderJs":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 2 || info.Produces[1].Role != "pdf" || info.Summary == "" {
		t.Errorf("info = %+v", info)
	}
	m.browser = func() (string, string) { return "", "" }
	if _, err := m.DescribeStep(json.RawMessage(`{"alsoPdf":true}`)); err == nil {
		t.Error("alsoPdf without a browser must be a problem")
	}
}

func TestPrepareStep(t *testing.T) {
	m := fakeModule()
	dir := t.TempDir()
	list := filepath.Join(dir, "links.txt")
	writeFile(t, list, "https://a.example/1\nhttps://a.example/1\nhttps://b.example/\n")
	req := core.StepRequest{Item: core.StepItem{Files: []core.RunFile{
		{Path: list}, {Path: "https://c.example/"},
	}}}
	jobs, err := m.PrepareStep(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://a.example/1", "https://b.example/", "https://c.example/"}
	if len(jobs) != 1 || !reflect.DeepEqual(jobs[0].Inputs, want) {
		t.Errorf("jobs = %+v", jobs)
	}

	empty := filepath.Join(dir, "empty.txt")
	writeFile(t, empty, "nothing here\n")
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: empty}}}}); err == nil {
		t.Error("no links must be an error")
	}
	priv := filepath.Join(dir, "priv.txt")
	writeFile(t, priv, "http://10.0.0.1/\n")
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: priv}}}}); err == nil {
		t.Error("private link must be rejected")
	}
}

func TestStepOutputs(t *testing.T) {
	m := fakeModule()
	res, err := m.StepOutputs(core.Job{
		Title:  "T",
		Inputs: []string{"https://e.com/"},
		Outputs: []core.Output{
			{ID: "1", Path: "/o/a.html", Name: "a.html"},
			{ID: "2", Path: "/o/a.pdf", Name: "a.pdf"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 || res.Files[0].Role != "page" || res.Files[1].Role != "pdf" {
		t.Errorf("files = %+v", res.Files)
	}
	if res.Vars["title"] != "T" || res.Vars["url"] != "https://e.com/" {
		t.Errorf("vars = %v", res.Vars)
	}
}
