package exif

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	m := new(Module)
	tests := []struct {
		name, opts, summary string
		templates           int
	}{
		{"strip location", `{}`, "Strip location", 0},
		{"strip all", `{"action":"strip-all"}`, "Strip all metadata · keep orientation", 0},
		{"strip all drop orientation", `{"action":"strip-all","keepOrientation":false}`, "Strip all metadata", 0},
		{"edit one", `{"action":"edit","fields":{"Copyright":"© {year}"}}`, "Edit Copyright", 6},
		{"edit many", `{"action":"edit","fields":{"Title":"a","Artist":"b","Copyright":"c"}}`, "Edit 3 fields", 6},
		{"templated date", `{"action":"edit","fields":{"DateTimeOriginal":"{date}"}}`, "Edit DateTimeOriginal", 6},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := m.DescribeStep(json.RawMessage(tc.opts))
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != tc.summary || info.Together || len(info.Produces) != 1 || len(info.Templates) != tc.templates {
				t.Fatalf("info %+v", info)
			}
			if p := info.Produces[0]; p.Role != "" || p.Kind != "" || p.Exts != nil {
				t.Errorf("product %+v", p)
			}
			if !slices.Equal(info.Accepts.Extensions, []string{".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tif", ".tiff"}) {
				t.Errorf("accepts %v", info.Accepts.Extensions)
			}
		})
	}
	if info, _ := m.DescribeStep(json.RawMessage(`{"action":"edit","fields":{"Title":"x"}}`)); !slices.Contains(info.Templates, "/fields/Title") {
		t.Errorf("templates %v", info.Templates)
	}
	for _, bad := range []string{
		`{"action":"explode"}`, `{"action":"edit"}`, `{"action":"edit","fields":{"Nope":"x"}}`,
		`{"action":"edit","fields":{"DateTimeOriginal":"yesterday"}}`, `{"action":"edit","fields":{"Title":"a\nb"}}`, `{"x":1}`,
	} {
		if _, err := m.DescribeStep(json.RawMessage(bad)); err == nil || core.AsAppError(err).Code != core.CodeValidation {
			t.Errorf("%s: err = %v", bad, err)
		}
	}
}

func files(paths ...string) []core.RunFile {
	var out []core.RunFile
	for _, p := range paths {
		out = append(out, core.RunFile{Path: p, Name: p, RoleLabel: "Photo"})
	}
	return out
}

func TestPrepareStep(t *testing.T) {
	m := new(Module)
	ctx := context.Background()

	t.Run("strip is one submission", func(t *testing.T) {
		jobs, err := m.PrepareStep(ctx, core.StepRequest{Options: json.RawMessage(`{"action":"strip-all"}`),
			Item: core.StepItem{Files: files("a.jpg", "b.png")}})
		if err != nil || len(jobs) != 1 || !slices.Equal(jobs[0].Inputs, []string{"a.jpg", "b.png"}) {
			t.Fatalf("jobs %+v err %v", jobs, err)
		}
		if o := jobs[0].Options.(Options); o.Action != ActionStripAll || !o.KeepOrientation {
			t.Errorf("options %+v", o)
		}
	})
	t.Run("plain edit is one submission", func(t *testing.T) {
		jobs, err := m.PrepareStep(ctx, core.StepRequest{Options: json.RawMessage(`{"action":"edit","fields":{"Artist":"Me {{x}}"}}`),
			Item: core.StepItem{Files: files("a.jpg", "b.png")}})
		if err != nil || len(jobs) != 1 {
			t.Fatalf("jobs %+v err %v", jobs, err)
		}
		if got := jobs[0].Options.(Options).Fields["Artist"]; got != "Me {x}" {
			t.Errorf("artist %q", got)
		}
	})
	t.Run("variables make one job per file", func(t *testing.T) {
		jobs, err := m.PrepareStep(ctx, core.StepRequest{
			Options: json.RawMessage(`{"action":"edit","fields":{"Title":"{label} / {name}","Artist":"Me"}}`),
			Item:    core.StepItem{Files: files("a.jpg", "b.png"), Vars: map[string]string{"label": "Trip"}},
		})
		if err != nil || len(jobs) != 2 {
			t.Fatalf("jobs %+v err %v", jobs, err)
		}
		titles := []string{jobs[0].Options.(Options).Fields["Title"], jobs[1].Options.(Options).Fields["Title"]}
		if !slices.Equal(titles, []string{"Trip / a", "Trip / b"}) {
			t.Errorf("titles %v", titles)
		}
		if jobs[0].Options.(Options).Fields["Artist"] != "Me" || !slices.Equal(jobs[1].Inputs, []string{"b.png"}) {
			t.Errorf("jobs %+v", jobs)
		}
	})
	t.Run("expanded value is checked", func(t *testing.T) {
		_, err := m.PrepareStep(ctx, core.StepRequest{
			Options: json.RawMessage(`{"action":"edit","fields":{"DateTimeOriginal":"{when}"}}`),
			Item:    core.StepItem{Files: files("a.jpg"), Vars: map[string]string{"when": "tomorrow"}},
		})
		if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeValidation {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("no files", func(t *testing.T) {
		if _, err := m.PrepareStep(ctx, core.StepRequest{Options: json.RawMessage(`{}`)}); err == nil {
			t.Error("want error")
		}
	})
}

func TestStepOutputs(t *testing.T) {
	m := new(Module)
	res, err := m.StepOutputs(core.Job{Outputs: []core.Output{{ID: "o1", Path: "/o/a (clean).jpg", Name: "a (clean).jpg", Kind: core.KindImage}}})
	if err != nil || len(res.Files) != 1 {
		t.Fatalf("res %+v err %v", res, err)
	}
	if f := res.Files[0]; f.Role != "" || f.OutputID != "o1" || f.Kind != core.KindImage {
		t.Errorf("file %+v", f)
	}
}
