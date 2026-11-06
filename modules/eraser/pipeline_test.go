package eraser

import (
	"context"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func newMasksModule(t *testing.T) *Module {
	t.Helper()
	root := t.TempDir()
	// The layout main.go uses: <support>/tmp/eraser for job masks.
	return &Module{maskDir: filepath.Join(root, "tmp", "eraser")}
}

func writeImage(t *testing.T, dir, name string, w, h int) string {
	t.Helper()
	p := filepath.Join(dir, name)
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, image.NewGray(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSavedMasksLifecycle(t *testing.T) {
	m := newMasksModule(t)
	if got, err := m.listMasks(); err != nil || len(got) != 0 {
		t.Fatalf("empty list = %v, %v", got, err)
	}
	sm, err := m.saveMask("  Tripod spot ", maskB64(t, 40, 30, true))
	if err != nil {
		t.Fatal(err)
	}
	if sm.Name != "Tripod spot" || sm.Width != 40 || sm.Height != 30 || sm.CreatedAt == 0 || !maskIDRe.MatchString(sm.ID) {
		t.Fatalf("saved = %+v", sm)
	}
	if dir := m.savedMasksDir(); filepath.Base(dir) != "masks" || filepath.Base(filepath.Dir(dir)) != "eraser" || strings.Contains(dir, "tmp") {
		t.Errorf("saved masks dir = %s", dir)
	}
	second, err := m.saveMask("Other", maskB64(t, 20, 20, true))
	if err != nil {
		t.Fatal(err)
	}
	list, err := m.listMasks()
	if err != nil || len(list) != 2 {
		t.Fatalf("list = %v, %v", list, err)
	}
	if list[0].CreatedAt < list[1].CreatedAt {
		t.Errorf("not newest first: %+v", list)
	}
	url, err := m.maskDataURL(sm.ID)
	if err != nil || !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("data url = %.40s, %v", url, err)
	}

	for _, tc := range []struct {
		name, mask string
	}{
		{"blank name", ""},
		{"duplicate name", "tripod SPOT"},
	} {
		name := tc.mask
		if _, err := m.saveMask(name, maskB64(t, 10, 10, true)); err == nil {
			t.Errorf("%s saved", tc.name)
		}
	}
	if _, err := m.saveMask("Empty", maskB64(t, 10, 10, false)); err == nil {
		t.Error("an unpainted mask saved")
	}
	if _, err := m.saveMask("Junk", "not base64!"); err == nil {
		t.Error("junk saved")
	}
	if _, err := m.saveMask(strings.Repeat("n", 61), maskB64(t, 10, 10, true)); err == nil {
		t.Error("a 61-character name saved")
	}

	if err := m.deleteMask(second.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.deleteMask(second.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("deleting twice: %v", err)
	}
	if _, err := m.maskDataURL(second.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("reading a deleted mask: %v", err)
	}
	for _, bad := range []string{"../x", "", "ABC", strings.Repeat("a", 23)} {
		if err := m.deleteMask(bad); err == nil {
			t.Errorf("deleteMask(%q) accepted", bad)
		}
	}
	if list, _ := m.listMasks(); len(list) != 1 || list[0].ID != sm.ID {
		t.Errorf("list after delete = %+v", list)
	}
}

func TestSavedMasksLimit(t *testing.T) {
	m := newMasksModule(t)
	m.SetSavedMasksDir(filepath.Join(t.TempDir(), "masks"))
	for i := range maxSavedMasks {
		if _, err := m.saveMask(strings.Repeat("m", 1)+string(rune('A'+i/26))+string(rune('a'+i%26)), maskB64(t, 4, 4, true)); err != nil {
			t.Fatalf("mask %d: %v", i, err)
		}
	}
	if _, err := m.saveMask("one too many", maskB64(t, 4, 4, true)); err == nil {
		t.Error("the 51st mask saved")
	}
}

func TestFitsMask(t *testing.T) {
	sm := SavedMask{Width: 4000, Height: 3000}
	for _, tc := range []struct {
		w, h int
		fits bool
	}{
		{4000, 3000, true},
		{2000, 1500, true},  // same shape: the engine scales the mask
		{1000, 750, true},   //
		{3000, 4000, false}, // portrait: not the same shape
		{4000, 2250, false}, // 16:9
		{4000, 3060, false}, // 2% off is too far
		{4000, 3020, true},  // within tolerance
		{0, 0, false},
	} {
		got := fitsMask(sm, tc.w, tc.h) == ""
		if got != tc.fits {
			t.Errorf("%dx%d fits = %v, want %v", tc.w, tc.h, got, tc.fits)
		}
	}
	if why := fitsMask(sm, 3000, 4000); !strings.Contains(why, "3000×4000") || !strings.Contains(why, "4000×3000") {
		t.Errorf("reason = %q", why)
	}
}

func TestDescribeStep(t *testing.T) {
	m := newMasksModule(t)
	sm, err := m.saveMask("Lamp post", maskB64(t, 40, 30, true))
	if err != nil {
		t.Fatal(err)
	}
	info, err := m.DescribeStep(json.RawMessage(`{"model":"fast","maskId":"` + sm.ID + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	if info.Summary != "“Lamp post” · Fast model" || len(info.Produces) != 1 || info.Produces[0].Role != "erased" || info.Produces[0].Kind != core.KindImage {
		t.Errorf("info = %+v", info)
	}
	for _, tc := range []struct{ name, opts, want string }{
		{"no mask", `{}`, "Choose a saved mask"},
		{"deleted mask", `{"maskId":"` + strings.Repeat("a", 24) + `"}`, "doesn't exist"},
		{"bad model", `{"model":"huge","maskId":"` + sm.ID + `"}`, "Best or Fast"},
		{"unknown option", `{"nope":1}`, "Invalid"},
	} {
		if _, err := m.DescribeStep(json.RawMessage(tc.opts)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want %q", tc.name, err, tc.want)
		}
	}
	if (&Module{}).Descriptor().NotAStep {
		t.Error("Object Eraser is kept out of the catalogue")
	}
}

func TestPrepareStepAppliesTheMaskToPhotosOfTheSameShape(t *testing.T) {
	m := newMasksModule(t)
	sm, err := m.saveMask("Tripod", maskB64(t, 400, 300, true))
	if err != nil {
		t.Fatal(err)
	}
	photos := t.TempDir()
	same := writeImage(t, photos, "same.png", 400, 300)
	bigger := writeImage(t, photos, "bigger.png", 800, 600)
	portrait := writeImage(t, photos, "portrait.png", 300, 400)
	wide := writeImage(t, photos, "wide.png", 640, 360)
	opts := json.RawMessage(`{"model":"fast","maskId":"` + sm.ID + `"}`)
	prep := func(paths ...string) ([]core.StepJob, error) {
		files := make([]core.RunFile, len(paths))
		for i, p := range paths {
			files[i] = core.RunFile{Path: p}
		}
		return m.PrepareStep(context.Background(), core.StepRequest{Options: opts, Item: core.StepItem{Files: files}})
	}

	jobs, err := prep(same, portrait, bigger, wide)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 || jobs[0].Inputs[0] != same || jobs[1].Inputs[0] != bigger {
		t.Fatalf("jobs = %+v", jobs)
	}
	first, second := jobs[0].Options.(Options), jobs[1].Options.(Options)
	if first.Model != ModelFast || !strings.HasPrefix(first.Note, "Skipped: portrait.png is 300×400 but the mask is 400×300") || !strings.Contains(first.Note, "wide.png") {
		t.Errorf("note = %q", first.Note)
	}
	if second.Note != "" {
		t.Errorf("only the first job carries the note: %q", second.Note)
	}
	// Each job has its own copy of the mask, inside the job mask folder, which
	// the job deletes; the saved mask itself is untouched.
	for _, o := range []Options{first, second} {
		if !m.insideMaskDir(o.MaskPath) {
			t.Errorf("mask %s is outside the mask folder", o.MaskPath)
		}
		if _, err := os.Stat(o.MaskPath); err != nil {
			t.Errorf("mask copy missing: %v", err)
		}
		raw, _ := json.Marshal(o)
		if err := m.Validate([]string{same}, raw); err != nil {
			t.Errorf("the prepared job doesn't validate: %v", err)
		}
	}
	if first.MaskPath == second.MaskPath {
		t.Error("jobs share a mask file")
	}
	if _, err := m.readMask(sm.ID); err != nil {
		t.Errorf("the saved mask was damaged: %v", err)
	}

	// Nothing fits: the step fails and says why for each photo.
	if _, err := prep(portrait, wide); err == nil || !strings.Contains(err.Error(), "portrait.png") || !strings.Contains(err.Error(), "wide.png") {
		t.Errorf("nothing fits: %v", err)
	}
	// An unreadable photo is skipped with a reason, not a crash.
	broken := filepath.Join(photos, "broken.png")
	if err := os.WriteFile(broken, []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	jobs, err = prep(broken, same)
	if err != nil || len(jobs) != 1 || !strings.Contains(jobs[0].Options.(Options).Note, "broken.png couldn't be read") {
		t.Fatalf("broken photo: %+v, %v", jobs, err)
	}
	if _, err := prep(); err == nil {
		t.Error("no photos should fail")
	}
}

func TestRunAddsTheStepNoteToTheWarning(t *testing.T) {
	maskDir, modelsDir := t.TempDir(), t.TempDir()
	input := touch(t, t.TempDir(), "Cat.jpg")
	out := filepath.Join(t.TempDir(), "Cat (erased).jpg")
	spec := models[ModelBest]
	if err := os.MkdirAll(filepath.Join(modelsDir, "eraser"), 0o755); err != nil {
		t.Fatal(err)
	}
	touch(t, filepath.Join(modelsDir, "eraser"), spec.File)
	mask := touch(t, maskDir, "a.png")
	r := &rec{}
	fc := &fakeCaller{result: `{"regions":1,"warning":"","output":` + quote(out) + `}`}
	m := &Module{sc: fc, modelsDir: modelsDir, maskDir: maskDir}
	o := Options{Model: ModelBest, MaskPath: mask, Note: "Skipped: x.jpg is a different shape"}
	if err := m.Run(context.Background(), newJob(r, input, optsJSON(t, o), t.TempDir())); err != nil {
		t.Fatal(err)
	}
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil || res.Warning != "Skipped: x.jpg is a different shape" {
		t.Errorf("result = %s (%v)", r.result, err)
	}
	st, err := m.StepOutputs(core.Job{Outputs: []core.Output{{ID: "1", Path: out, Name: filepath.Base(out)}}})
	if err != nil || len(st.Files) != 1 || st.Files[0].Role != "erased" {
		t.Errorf("step outputs = %+v, %v", st, err)
	}
}
