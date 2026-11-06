package posts

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func TestDescribeStep(t *testing.T) {
	e := newEnv(t)
	tests := []struct {
		name, opts, summary, wantErr string
	}{
		{"defaults", `{}`, "Carousel or reel", ""},
		{"carousel 1:1", `{"format":"carousel","aspect":"1:1"}`, "Carousel 1:1", ""},
		{"reel", `{"format":"reel"}`, "Reel", ""},
		{"story", `{"format":"story"}`, "Story", ""},
		{"bad format", `{"format":"feed"}`, "", "automatic, carousel, reel or story"},
		{"bad aspect", `{"aspect":"16:9"}`, "", "4:5, 1:1, 3:4 or 1.91:1"},
		{"long caption", `{"caption":"` + strings.Repeat("x", 2201) + `"}`, "", "caption is too long"},
		{"unknown option", `{"nope":1}`, "", "Invalid"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := e.m.DescribeStep(json.RawMessage(tc.opts))
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil || info.Summary != tc.summary {
				t.Fatalf("info = %+v, %v", info, err)
			}
			if len(info.Produces) != 2 || info.Produces[0].Role != "slide" || len(info.Vars) != 2 {
				t.Errorf("produces/vars = %+v %+v", info.Produces, info.Vars)
			}
		})
	}
	// Posts are no longer kept out of the catalogue.
	if e.m.Descriptor().NotAStep {
		t.Error("Post Builder is still NotAStep")
	}
}

func files(paths ...string) []core.RunFile {
	out := make([]core.RunFile, len(paths))
	for i, p := range paths {
		out[i] = core.RunFile{Path: p}
	}
	return out
}

func prepare(t *testing.T, e *testEnv, opts string, vars map[string]string, paths ...string) ([]core.StepJob, error) {
	t.Helper()
	return e.m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(opts), Item: core.StepItem{Label: "Trip", Files: files(paths...), Vars: vars},
	})
}

func TestPrepareStepFormats(t *testing.T) {
	e := newEnv(t)
	vars := map[string]string{"item": "Trip"}

	// auto: a lone video is a reel; photos are a carousel.
	jobs, err := prepare(t, e, `{}`, vars, "clip.mp4")
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v, %v", jobs, err)
	}
	if o := jobs[0].Options.(Options); o.Action != ActionMake || o.Format != "reel" || o.Name != "Trip" {
		t.Errorf("reel job = %+v", o)
	}
	jobs, _ = prepare(t, e, `{"caption":"Day at {item}"}`, vars, "a.jpg", "b.png", "c.mp4")
	if o := jobs[0].Options.(Options); len(jobs) != 1 || o.Format != "carousel" || o.Aspect != "4:5" || o.Caption != "Day at Trip" || len(jobs[0].Inputs) != 3 {
		t.Errorf("carousel job = %+v %+v", jobs[0].Inputs, o)
	}
	jobs, _ = prepare(t, e, `{}`, vars, "a.jpg")
	if o := jobs[0].Options.(Options); o.Format != "carousel" {
		t.Errorf("a lone photo should be a carousel: %+v", o)
	}

	// A reel per video; photos left out; no video is an error.
	jobs, err = prepare(t, e, `{"format":"reel","name":"{name}"}`, vars, "a.jpg", "one.mp4", "two.mov")
	if err != nil || len(jobs) != 2 || jobs[0].Inputs[0] != "one.mp4" || jobs[1].Inputs[0] != "two.mov" {
		t.Fatalf("reels = %+v, %v", jobs, err)
	}
	if o := jobs[1].Options.(Options); o.Name != "two 2" || o.KeepLocation {
		t.Errorf("second reel = %+v", o)
	}
	if _, err := prepare(t, e, `{"format":"reel"}`, vars, "a.jpg"); err == nil || !strings.Contains(err.Error(), "needs a video") {
		t.Errorf("reel of photos: %v", err)
	}

	// 45 photos make three posts of at most 20, numbered.
	var many []string
	for i := range 45 {
		many = append(many, filepath.Join("d", string(rune('a'+i%26))+".jpg"))
	}
	jobs, err = prepare(t, e, `{"format":"story","keepLocation":true}`, vars, many...)
	if err != nil || len(jobs) != 3 || len(jobs[0].Inputs) != 20 || len(jobs[2].Inputs) != 5 {
		t.Fatalf("story chunks = %d, %v", len(jobs), err)
	}
	if o := jobs[2].Options.(Options); o.Name != "Trip 3" || !o.KeepLocation || o.Format != "story" {
		t.Errorf("last job = %+v", o)
	}
	raw, _ := json.Marshal(jobs[0].Options)
	if err := e.m.Validate(jobs[0].Inputs, raw); err != nil {
		t.Errorf("a prepared job doesn't validate: %v", err)
	}
	if _, err := prepare(t, e, `{}`, vars); err == nil {
		t.Error("no files should fail")
	}
}

func TestValidateMake(t *testing.T) {
	e := newEnv(t)
	ok := `{"action":"make","format":"carousel","aspect":"4:5"}`
	if err := e.m.Validate([]string{"a.jpg"}, []byte(ok)); err != nil {
		t.Error(err)
	}
	tooMany := make([]string, 21)
	for _, tc := range []struct {
		name   string
		inputs []string
		opts   string
	}{
		{"no files", nil, ok},
		{"too many slides", tooMany, ok},
		{"bad format", []string{"a.jpg"}, `{"action":"make","format":"feed"}`},
		{"bad aspect", []string{"a.jpg"}, `{"action":"make","format":"carousel","aspect":"2:1"}`},
		{"reel of two", []string{"a.mp4", "b.mp4"}, `{"action":"make","format":"reel"}`},
		{"caption too long", []string{"a.jpg"}, `{"action":"make","format":"carousel","aspect":"1:1","caption":"` + strings.Repeat("x", 2201) + `"}`},
	} {
		if e.m.Validate(tc.inputs, []byte(tc.opts)) == nil {
			t.Errorf("%s should fail", tc.name)
		}
	}
}

// runMake runs a make job and returns its outputs and result.
func runMake(ctx context.Context, e *testEnv, inputs []string, o Options) ([]string, ExportResult, error) {
	raw, _ := json.Marshal(o)
	var outs []string
	var result json.RawMessage
	jc := core.NewJobContext(core.JobContext{ID: "j2", ModuleID: ModuleID, Inputs: inputs, Options: raw, OutputDir: e.outDir, TempDir: e.tmpDir}, core.JobHooks{
		Output: func(p string) (core.Output, error) { outs = append(outs, p); return core.Output{Path: p}, nil },
		Tool:   func(dep string) (string, error) { return e.m.cfg.Resolve(dep) },
		Result: func(r json.RawMessage) { result = r },
	})
	err := e.m.Run(ctx, jc)
	var res ExportResult
	if len(result) > 0 {
		_ = json.Unmarshal(result, &res)
	}
	return outs, res, err
}

func TestMakeJobCreatesAndExportsAPost(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	a, b, txt := filepath.Join(dir, "a.png"), filepath.Join(dir, "b.png"), filepath.Join(dir, "n.txt")
	writePNG(t, a, gradient(1200, 1500))
	writePNG(t, b, gradient(1100, 1400))
	if err := os.WriteFile(txt, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	outs, res, err := runMake(context.Background(), e, []string{a, b, txt}, Options{
		Action: ActionMake, Name: "Market day", Format: "carousel", Aspect: "4:5", Caption: "Hello #market",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ProjectID == "" || !strings.HasPrefix(filepath.Base(res.Folder), "Market day") {
		t.Fatalf("result = %+v", res)
	}
	var names []string
	for _, o := range outs {
		names = append(names, filepath.Base(o))
	}
	if strings.Join(names, ",") != "01.jpg,02.jpg,caption.txt" {
		t.Errorf("outputs = %v", names)
	}
	if got, _ := os.ReadFile(filepath.Join(res.Folder, "caption.txt")); string(got) != "Hello #market" {
		t.Errorf("caption = %q", got)
	}
	// The post is a Post Builder project the user can open and change.
	svc := NewService(nil, e.m)
	list, err := svc.List()
	if err != nil || len(list) != 1 || list[0].Name != "Market day" {
		t.Fatalf("projects = %+v, %v", list, err)
	}
	doc, err := svc.Get(res.ProjectID)
	if err != nil || len(doc.Slides) != 2 || doc.Caption != "Hello #market" || doc.KeepLocation {
		t.Fatalf("doc = %+v, %v", doc, err)
	}

	// The step reads the job back: roles, the folder and the caption.
	rawRes, _ := json.Marshal(res)
	var jobOuts []core.Output
	for _, o := range outs {
		jobOuts = append(jobOuts, core.Output{ID: filepath.Base(o), Path: o, Name: filepath.Base(o), Kind: core.KindForPath(o)})
	}
	step, err := e.m.StepOutputs(core.Job{ResultJSON: string(rawRes), Outputs: jobOuts})
	if err != nil || len(step.Files) != 3 {
		t.Fatalf("step = %+v, %v", step, err)
	}
	if step.Files[0].Role != "slide" || step.Files[2].Role != "caption" || step.Vars["caption"] != "Hello #market" || step.Vars["post_folder"] != res.Folder {
		t.Errorf("step = %+v", step)
	}
}

func TestMakeJobLeavesNothingBehindOnFailure(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	a := filepath.Join(dir, "a.png")
	writePNG(t, a, gradient(1200, 1500))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := runMake(ctx, e, []string{a}, Options{Action: ActionMake, Format: "carousel", Aspect: "4:5"}); err == nil {
		t.Fatal("a cancelled make job should fail")
	}
	if list, _ := NewService(nil, e.m).List(); len(list) != 0 {
		t.Errorf("an unfinished post was left behind: %+v", list)
	}
	if entries, _ := os.ReadDir(e.outDir); len(entries) != 0 {
		t.Errorf("leftover folders: %v", entries)
	}
	// Files that can't be slides make no post at all.
	txt := filepath.Join(dir, "n.txt")
	_ = os.WriteFile(txt, []byte("x"), 0o644)
	if _, _, err := runMake(context.Background(), e, []string{txt}, Options{Action: ActionMake, Format: "carousel", Aspect: "4:5"}); err == nil || !strings.Contains(err.Error(), "None of these files") {
		t.Errorf("err = %v", err)
	}
}
