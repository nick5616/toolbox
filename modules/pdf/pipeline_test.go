package pdf

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"testing"

	"toolbox/core"
)

func raw(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDescribeStep(t *testing.T) {
	m := new(Module)
	step := func(mut func(o *StepOptions)) json.RawMessage {
		o := DefaultStepOptions()
		mut(&o)
		return raw(t, o)
	}
	tests := []struct {
		name     string
		opts     json.RawMessage
		summary  string
		together bool
		secret   string
		role     string
		many     bool
		ext      string
		accepts  string
	}{
		{"merge", step(func(o *StepOptions) {}), "Merge into one PDF", true, "", "pdf", false, ".pdf", ".pdf"},
		{"split one", step(func(o *StepOptions) { o.Action = ActionSplit }), "Split every 1 page", false, "", "pdf", true, ".pdf", ".pdf"},
		{"split three", step(func(o *StepOptions) { o.Action = ActionSplit; o.Every = 3 }), "Split every 3 pages", false, "", "pdf", true, ".pdf", ".pdf"},
		{"compress", step(func(o *StepOptions) { o.Action = ActionCompress }), "Compress · balanced", false, "", "pdf", false, ".pdf", ".pdf"},
		{"images", step(func(o *StepOptions) { o.Action = ActionImagesToPDF }), "Photos → PDF · A4", true, "", "pdf", false, ".pdf", ".png"},
		{"pages", step(func(o *StepOptions) { o.Action = ActionPDFToImages }), "Pages → PNG · 150 dpi", false, "", "page", true, ".png", ".pdf"},
		{"pages jpg", step(func(o *StepOptions) { o.Action = ActionPDFToImages; o.ImageFormat = ImageJPG; o.DPI = 300 }), "Pages → JPG · 300 dpi", false, "", "page", true, ".jpg", ".pdf"},
		{"protect", step(func(o *StepOptions) { o.Action = ActionProtect }), "Add a password", false, "New PDF password", "pdf", false, ".pdf", ".pdf"},
		{"unlock", step(func(o *StepOptions) { o.Action = ActionUnlock }), "Remove the password", false, "PDF password", "pdf", false, ".pdf", ".pdf"},
		{"partial keeps defaults", json.RawMessage(`{"action":"split"}`), "Split every 1 page", false, "", "pdf", true, ".pdf", ".pdf"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := m.DescribeStep(tc.opts)
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != tc.summary || info.Together != tc.together {
				t.Errorf("summary %q together %v", info.Summary, info.Together)
			}
			if len(info.Produces) != 1 {
				t.Fatalf("produces %+v", info.Produces)
			}
			p := info.Produces[0]
			if p.Role != tc.role || p.Many != tc.many || !slices.Equal(p.Exts, []string{tc.ext}) {
				t.Errorf("product %+v", p)
			}
			if !slices.Contains(info.Accepts.Extensions, tc.accepts) {
				t.Errorf("accepts %v", info.Accepts.Extensions)
			}
			if tc.accepts == ".pdf" && len(info.Accepts.Extensions) != 1 {
				t.Errorf("pdf actions accept only PDFs: %v", info.Accepts.Extensions)
			}
			if tc.secret == "" && len(info.Secrets) != 0 {
				t.Errorf("secrets %+v", info.Secrets)
			}
			if tc.secret != "" && (len(info.Secrets) != 1 || info.Secrets[0].Key != "password" || info.Secrets[0].Label != tc.secret) {
				t.Errorf("secrets %+v", info.Secrets)
			}
		})
	}
}

func TestDescribeStepProblems(t *testing.T) {
	m := new(Module)
	tests := []struct{ name, json string }{
		{"organize", `{"action":"organize"}`},
		{"unknown", `{"action":"explode"}`},
		{"every", `{"action":"split","every":-1}`},
		{"level", `{"action":"compress","level":"tiny"}`},
		{"pageSize", `{"action":"images-to-pdf","pageSize":"a0"}`},
		{"margin", `{"action":"images-to-pdf","margin":"huge"}`},
		{"format", `{"action":"pdf-to-images","imageFormat":"gif"}`},
		{"dpi", `{"action":"pdf-to-images","dpi":100}`},
		{"unknown field", `{"action":"merge","bogus":1}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := m.DescribeStep(json.RawMessage(tc.json)); !isCode(err, core.CodeValidation) {
				t.Errorf("err = %v", err)
			}
		})
	}
	// Fields of other actions are not checked.
	if _, err := m.DescribeStep(json.RawMessage(`{"action":"merge","dpi":100}`)); err != nil {
		t.Errorf("merge ignores dpi: %v", err)
	}
}

func rf(path string) core.RunFile { return core.RunFile{Path: path, Name: filepath.Base(path)} }

func item(i int, paths ...string) core.StepItem {
	it := core.StepItem{Index: i, Vars: map[string]string{}}
	for _, p := range paths {
		it.Files = append(it.Files, rf(p))
	}
	return it
}

func jobOpts(t *testing.T, j core.StepJob) Options {
	t.Helper()
	o, ok := j.Options.(Options)
	if !ok {
		t.Fatalf("options type %T", j.Options)
	}
	return o
}

func TestPrepareStepGrouping(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	a := writePDF(t, dir, "a.pdf", 2, 612, 792)
	b := writePDF(t, dir, "b.pdf", 1, 612, 792)
	c := writePDF(t, dir, "c.pdf", 3, 612, 792)
	img := gradientPNG(t, dir, "p.png", 40, 40)
	img2 := gradientPNG(t, dir, "q.png", 40, 40)
	ctx := context.Background()

	t.Run("merge is one job in item order", func(t *testing.T) {
		jobs, err := m.PrepareStep(ctx, core.StepRequest{
			Options: raw(t, DefaultStepOptions()),
			Items:   []core.StepItem{item(0, a), item(1, b, c)},
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(jobs) != 1 || !slices.Equal(jobs[0].Inputs, []string{a, b, c}) || jobOpts(t, jobs[0]).Action != ActionMerge {
			t.Fatalf("jobs %+v", jobs)
		}
	})
	t.Run("merge of one file makes no job", func(t *testing.T) {
		jobs, err := m.PrepareStep(ctx, core.StepRequest{
			Options: raw(t, DefaultStepOptions()), Items: []core.StepItem{item(0, a)},
		})
		if err != nil || jobs == nil || len(jobs) != 0 {
			t.Fatalf("jobs %+v err %v", jobs, err)
		}
	})
	t.Run("images to pdf is one job", func(t *testing.T) {
		o := DefaultStepOptions()
		o.Action = ActionImagesToPDF
		jobs, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, o), Items: []core.StepItem{item(0, img), item(1, img2)}})
		if err != nil {
			t.Fatal(err)
		}
		if len(jobs) != 1 || len(jobs[0].Inputs) != 2 || jobOpts(t, jobs[0]).PageSize != PageA4 {
			t.Fatalf("jobs %+v", jobs)
		}
	})
	t.Run("split is one job per file", func(t *testing.T) {
		o := DefaultStepOptions()
		o.Action = ActionSplit
		o.Every = 2
		jobs, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, o), Item: item(0, a, b)})
		if err != nil {
			t.Fatal(err)
		}
		if len(jobs) != 2 || !slices.Equal(jobs[1].Inputs, []string{b}) {
			t.Fatalf("jobs %+v", jobs)
		}
		got := jobOpts(t, jobs[0])
		if got.Action != ActionSplit || got.SplitMode != SplitEvery || got.Every != 2 || got.PasswordRef != "" {
			t.Errorf("options %+v", got)
		}
		if err := m.Validate(jobs[0].Inputs, raw(t, got)); err != nil {
			t.Errorf("Validate rejects the job: %v", err)
		}
	})
	t.Run("wrong kind of input", func(t *testing.T) {
		if _, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, DefaultStepOptions()), Items: []core.StepItem{item(0, a, img)}}); !isCode(err, core.CodeValidation) {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("no files", func(t *testing.T) {
		if _, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, DefaultStepOptions())}); !isCode(err, core.CodeValidation) {
			t.Errorf("err = %v", err)
		}
	})
}

func TestPrepareStepSecrets(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	plain := writePDF(t, dir, "plain.pdf", 2, 612, 792)
	ctx := context.Background()

	// Protect: the secret becomes the new password behind a passwordRef.
	po := DefaultStepOptions()
	po.Action = ActionProtect
	if _, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, po), Item: item(0, plain)}); !isCode(err, core.CodeValidation) {
		t.Fatalf("missing secret err = %v", err)
	}
	jobs, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, po), Item: item(0, plain), Secrets: map[string]string{"password": "s3cret"}})
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs %+v err %v", jobs, err)
	}
	ref := jobOpts(t, jobs[0]).PasswordRef
	if ref == "" {
		t.Fatal("no passwordRef")
	}
	if pw, np, ok := m.state.sec.get(ref); !ok || pw != "" || np != "s3cret" {
		t.Errorf("secret = %q %q %v", pw, np, ok)
	}
	if b, _ := json.Marshal(jobs[0].Options); json.Valid(b) && contains(string(b), "s3cret") {
		t.Errorf("password leaked into options: %s", b)
	}
	if err := m.Validate(jobs[0].Inputs, raw(t, jobOpts(t, jobs[0]))); err != nil {
		t.Errorf("Validate rejects the job: %v", err)
	}

	// Run it for real, then unlock the result with the same password.
	r, _, err := runJob(t, m, jobs[0].Inputs, jobOpts(t, jobs[0]))
	if err != nil {
		t.Fatal(err)
	}
	prot := r.outputs[0]
	uo := DefaultStepOptions()
	uo.Action = ActionUnlock
	if _, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, uo), Item: item(0, prot), Secrets: map[string]string{"password": "wrong"}}); !isCode(err, core.CodeValidation) {
		t.Errorf("wrong password err = %v", err)
	}
	jobs, err = m.PrepareStep(ctx, core.StepRequest{Options: raw(t, uo), Item: item(0, prot), Secrets: map[string]string{"password": "s3cret"}})
	if err != nil || len(jobs) != 1 {
		t.Fatalf("unlock jobs %+v err %v", jobs, err)
	}
	if pw, _, ok := m.state.sec.get(jobOpts(t, jobs[0]).PasswordRef); !ok || pw != "s3cret" {
		t.Errorf("unlock secret = %q %v", pw, ok)
	}

	// Document checks: unlocking a plain file, compressing an encrypted one.
	if _, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, uo), Item: item(0, plain), Secrets: map[string]string{"password": "x"}}); !isCode(err, core.CodeValidation) {
		t.Errorf("unlock plain err = %v", err)
	}
	co := DefaultStepOptions()
	co.Action = ActionCompress
	if _, err := m.PrepareStep(ctx, core.StepRequest{Options: raw(t, co), Item: item(0, prot)}); !isCode(err, core.CodeValidation) {
		t.Errorf("compress encrypted err = %v", err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestStepOutputs(t *testing.T) {
	m := new(Module)
	optJSON := func(a Action) string { return string(raw(t, opts(a))) }
	out := func(p string, k core.OutputKind) core.Output {
		return core.Output{ID: "id-" + filepath.Base(p), Path: p, Name: filepath.Base(p), Kind: k}
	}
	tests := []struct {
		name  string
		job   core.Job
		files []string
		role  string
		label string
	}{
		{"merge", core.Job{OptionsJSON: optJSON(ActionMerge), Outputs: []core.Output{out("/o/merged.pdf", core.KindDocument)}}, []string{"/o/merged.pdf"}, "pdf", "PDF"},
		{"split many", core.Job{OptionsJSON: optJSON(ActionSplit), Outputs: []core.Output{out("/o/a1.pdf", core.KindDocument), out("/o/a2.pdf", core.KindDocument)}}, []string{"/o/a1.pdf", "/o/a2.pdf"}, "pdf", "PDF"},
		{"pages", core.Job{OptionsJSON: optJSON(ActionPDFToImages), Outputs: []core.Output{out("/o/p1.png", core.KindImage)}}, []string{"/o/p1.png"}, "page", "Page"},
		{"compress", core.Job{OptionsJSON: optJSON(ActionCompress), Inputs: []string{"/i/in.pdf"}, Outputs: []core.Output{out("/o/in (compressed).pdf", core.KindDocument)}}, []string{"/o/in (compressed).pdf"}, "pdf", "PDF"},
		{"compress already compact passes the input through", core.Job{OptionsJSON: optJSON(ActionCompress), Inputs: []string{"/i/in.pdf"}}, []string{"/i/in.pdf"}, "pdf", "PDF"},
		{"split without output is not a pass-through", core.Job{OptionsJSON: optJSON(ActionSplit), Inputs: []string{"/i/in.pdf"}}, nil, "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res, err := m.StepOutputs(tc.job)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, f := range res.Files {
				got = append(got, f.Path)
				if f.Role != tc.role || f.RoleLabel != tc.label {
					t.Errorf("file %+v", f)
				}
			}
			if !slices.Equal(got, tc.files) {
				t.Errorf("files %v, want %v", got, tc.files)
			}
		})
	}
}
