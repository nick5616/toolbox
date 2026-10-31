package upscale

import (
	"context"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	m := new(Module)
	tests := []struct {
		name, opts, summary string
		exts                []string
	}{
		{"defaults", `{}`, "Photo · 4×", nil},
		{"webp", `{"scale":2,"format":"webp"}`, "Photo · 2× · WebP", []string{".webp"}},
		{"jpg gpu", `{"model":"illustration","format":"jpg","device":"gpu"}`, "Illustration · 4× · JPG · GPU", []string{".jpg"}},
		{"png cpu fast", `{"model":"fast","format":"png","device":"cpu"}`, "Fast · 4× · PNG · CPU", []string{".png"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := m.DescribeStep(json.RawMessage(tc.opts))
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != tc.summary || info.Together || len(info.Produces) != 1 {
				t.Fatalf("info %+v", info)
			}
			p := info.Produces[0]
			if p.Role != "" || p.Kind != core.KindImage || !slices.Equal(p.Exts, tc.exts) {
				t.Errorf("product %+v", p)
			}
			if !slices.Contains(info.Accepts.Extensions, ".webp") {
				t.Errorf("accepts %v", info.Accepts.Extensions)
			}
		})
	}
	for _, bad := range []string{`{"scale":3}`, `{"model":"x"}`, `{"format":"gif"}`, `{"device":"tpu"}`, `{"x":1}`} {
		if _, err := m.DescribeStep(json.RawMessage(bad)); err == nil || core.AsAppError(err).Code != core.CodeValidation {
			t.Errorf("%s: err = %v", bad, err)
		}
	}
}

func TestPrepareStep(t *testing.T) {
	m := new(Module)
	dir := t.TempDir()
	var paths []string
	for _, n := range []string{"a.png", "b.png"} {
		p := filepath.Join(dir, n)
		f, err := os.Create(p)
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(f, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
			t.Fatal(err)
		}
		f.Close()
		paths = append(paths, p)
	}
	item := core.StepItem{}
	for _, p := range paths {
		item.Files = append(item.Files, core.RunFile{Path: p})
	}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{"scale":2}`), Item: item})
	if err != nil || len(jobs) != 1 || !slices.Equal(jobs[0].Inputs, paths) {
		t.Fatalf("jobs %+v err %v", jobs, err)
	}
	o, ok := jobs[0].Options.(Options)
	if !ok || o.Scale != 2 || o.Model != ModelPhoto || o.Format != FormatSame || o.Device != DeviceAuto {
		t.Fatalf("options %+v", jobs[0].Options)
	}
	raw, _ := json.Marshal(o)
	if err := m.Validate(jobs[0].Inputs, raw); err != nil {
		t.Errorf("Validate rejects the job: %v", err)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{}`)}); err == nil {
		t.Error("no files should fail")
	}
}

func TestStepOutputs(t *testing.T) {
	m := new(Module)
	res, err := m.StepOutputs(core.Job{Outputs: []core.Output{{ID: "o1", Path: "/o/a (4x).webp", Name: "a (4x).webp"}}})
	if err != nil || len(res.Files) != 1 {
		t.Fatalf("res %+v err %v", res, err)
	}
	f := res.Files[0]
	if f.Role != "" || f.Kind != core.KindImage || f.OutputID != "o1" || f.Name != "a (4x).webp" {
		t.Errorf("file %+v", f)
	}
}
