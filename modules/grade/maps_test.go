package grade

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/media"
)

func installDepth(t *testing.T, m *Module) {
	t.Helper()
	if err := writeFile(m.DepthModelPath(), "onnx"); err != nil {
		t.Fatal(err)
	}
}

func TestPickFPSAndFitSize(t *testing.T) {
	for in, want := range map[float64]int{0: 30, 23.976: 24, 24: 24, 25: 25, 29.97: 30, 30: 30, 50: 60, 59.94: 60, 120: 60, 12: 24} {
		if got := pickFPS(in); got != want {
			t.Errorf("pickFPS(%v) = %d, want %d", in, got, want)
		}
	}
	for _, tc := range []struct{ w, h, max, ww, hh int }{
		{4032, 3024, 8192, 4032, 3024},
		{1921, 1081, 3840, 1920, 1080}, // odd sizes become even
		{7680, 4320, 3840, 3840, 2160}, // an 8K video exports at 3840
		{12000, 6000, 8192, 8192, 4096},
		{3000, 9000, 8192, 2730, 8192},
		{1, 1, 3840, 2, 2},
	} {
		w, h := fitSize(tc.w, tc.h, tc.max)
		if w != tc.ww || h != tc.hh || w%2 != 0 || h%2 != 0 {
			t.Errorf("fitSize(%d,%d,%d) = %dx%d, want %dx%d", tc.w, tc.h, tc.max, w, h, tc.ww, tc.hh)
		}
	}
}

func TestCacheKeyFollowsTheFile(t *testing.T) {
	m := newModule(t, nil, nil)
	f := writeJPEG(t, filepath.Join(t.TempDir(), "a.jpg"), 40, 30)
	d1, err := m.cacheDirFor(f)
	if err != nil {
		t.Fatal(err)
	}
	if d2, _ := m.cacheDirFor(f); d1 != d2 {
		t.Error("the key isn't stable")
	}
	if filepath.Dir(d1) != m.cfg.CacheDir {
		t.Errorf("dir %q isn't under the cache", d1)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(f, later, later); err != nil {
		t.Fatal(err)
	}
	if d3, _ := m.cacheDirFor(f); d3 == d1 {
		t.Error("a modified file kept its maps")
	}
	if _, err := m.cacheDirFor(filepath.Join(t.TempDir(), "gone.jpg")); core.AsAppError(err) == nil {
		t.Error("a missing file got a cache folder")
	}
}

func TestMapsStateForPicturesAndVideos(t *testing.T) {
	edit := &fakeEdit{}
	m := newModule(t, edit, nil)
	pic := writeJPEG(t, filepath.Join(t.TempDir(), "p.jpg"), 40, 30)
	st, err := m.Maps(pic)
	if err != nil {
		t.Fatal(err)
	}
	if st.Depth.Ready || st.Subject.Ready || st.Depth.Missing != "depth-v2s" || st.Subject.Missing != "bg-default" || st.People.Missing != "bg-default" {
		t.Errorf("empty state = %+v", st)
	}
	if st.Preparing == nil {
		t.Error("Preparing is nil (the wire type wants an empty list)")
	}

	// With the models installed nothing is missing, and ready maps say so.
	installDepth(t, m)
	edit.image, edit.people = true, true
	dir, _ := m.cacheDirFor(pic)
	if err := writeGray16(filepath.Join(dir, "depth.png")); err != nil {
		t.Fatal(err)
	}
	if err := writeGray16(filepath.Join(dir, "depth-thumb.png")); err != nil {
		t.Fatal(err)
	}
	st, _ = m.Maps(pic)
	if !st.Depth.Ready || st.Depth.Still != filepath.Join(dir, "depth.png") || st.Depth.Preview == "" || st.Depth.Missing != "" {
		t.Errorf("depth = %+v", st.Depth)
	}
	if st.Subject.Ready || st.Subject.Missing != "" {
		t.Errorf("subject = %+v", st.Subject)
	}

	// A video's maps are streams with their indexes.
	vid := filepath.Join(t.TempDir(), "v.mp4")
	if err := writeFile(vid, "x"); err != nil {
		t.Fatal(err)
	}
	vdir, _ := m.cacheDirFor(vid)
	for _, f := range []string{"subject-export.h264", "subject-export.idx.json", "subject-preview.h264"} {
		if err := writeFile(filepath.Join(vdir, f), "x"); err != nil {
			t.Fatal(err)
		}
	}
	st, _ = m.Maps(vid)
	if st.Subject.Ready {
		t.Error("a missing preview index still counts as ready")
	}
	if err := writeFile(filepath.Join(vdir, "subject-preview.idx.json"), "{}"); err != nil {
		t.Fatal(err)
	}
	st, _ = m.Maps(vid)
	if !st.Subject.Ready || st.Subject.Stream != filepath.Join(vdir, "subject-export.h264") || st.People != st.Subject {
		t.Errorf("subject = %+v, people = %+v", st.Subject, st.People)
	}
	edit.people = false
	if st, _ = m.Maps(vid); st.Depth.Missing != "" {
		t.Errorf("depth missing = %q with the model installed", st.Depth.Missing)
	}
}

func TestPrepareMapsJobForAPicture(t *testing.T) {
	edit := &fakeEdit{image: true}
	eng := &fakeEngine{}
	m := newModule(t, edit, eng)
	installDepth(t, m)
	pic := writeJPEG(t, filepath.Join(t.TempDir(), "p.jpg"), 64, 48)
	job, rec := newJob(t, []string{pic}, Options{Recipe: DefaultOptions().Recipe, Format: "same", Action: ActionMaps, MapKinds: []string{"depth", "people", "subject"}})
	if err := m.Validate(job.Inputs, job.Options); err != nil {
		t.Fatal(err)
	}
	if err := m.Run(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	if len(eng.calls) != 1 || eng.calls[0] != "depth.image" {
		t.Errorf("engine calls = %v", eng.calls)
	}
	if args := eng.args["depth.image"]; args["model"] != m.DepthModelPath() || filepath.Base(args["out"].(string)) != "depth.png" {
		t.Errorf("depth.image args = %v", args)
	}
	if len(edit.imageMattes) != 1 { // "people" and "subject" are one map
		t.Errorf("%d subject mattes", len(edit.imageMattes))
	}
	st, _ := m.Maps(pic)
	if !st.Depth.Ready || !st.Subject.Ready || st.Depth.Preview == "" || st.Subject.Preview == "" {
		t.Errorf("state = %+v", st)
	}
	if rec.result == nil {
		t.Error("no result")
	}

	// A second run finds everything made and does no work.
	eng.calls, edit.imageMattes = nil, nil
	job2, _ := newJob(t, []string{pic}, Options{Recipe: DefaultOptions().Recipe, Format: "same", Action: ActionMaps, MapKinds: []string{"depth", "subject"}})
	if err := m.Run(t.Context(), job2); err != nil {
		t.Fatal(err)
	}
	if len(eng.calls) != 0 || len(edit.imageMattes) != 0 {
		t.Errorf("redid cached maps: %v %v", eng.calls, edit.imageMattes)
	}
}

func TestPrepareMapsJobForAVideo(t *testing.T) {
	edit := &fakeEdit{people: true}
	eng := &fakeEngine{}
	m := newModule(t, edit, eng)
	installDepth(t, m)
	mediaProbeFn = func(_ context.Context, _, _ string) (media.Info, error) {
		return media.Info{DurationMs: 4000, Video: &media.VideoStream{Width: 1920, Height: 1080, FPS: 29.97}}, nil
	}
	t.Cleanup(func() { mediaProbeFn = media.Probe })
	vid := filepath.Join(t.TempDir(), "v.mp4")
	if err := writeFile(vid, "x"); err != nil {
		t.Fatal(err)
	}
	job, _ := newJob(t, []string{vid}, Options{Recipe: DefaultOptions().Recipe, Format: "same", Action: ActionMaps, MapKinds: []string{"depth", "subject"}})
	if err := m.Run(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	args := eng.args["depth.video"]
	if args == nil {
		t.Fatal("depth.video wasn't called")
	}
	if args["fps"] != 30 || args["width"] != 960 || args["height"] != 540 || args["name"] != "depth" || args["model"] != m.DepthModelPath() {
		t.Errorf("depth.video args = %v", args)
	}
	if len(edit.prepared) != 1 || edit.prepared[0] != 540 {
		t.Errorf("the edit stream was made at short sides %v, want [540]", edit.prepared)
	}
	if len(edit.indexed) != 2 {
		t.Errorf("indexed %v", edit.indexed)
	}
	if len(edit.videoMattes) != 1 {
		t.Errorf("%d people mattes", len(edit.videoMattes))
	}
	st, _ := m.Maps(vid)
	if !st.Depth.Ready || !st.Subject.Ready {
		t.Errorf("state = %+v", st)
	}
}

func TestMissingModelsRefuseWithThePackNamed(t *testing.T) {
	edit := &fakeEdit{}
	eng := &fakeEngine{}
	m := newModule(t, edit, eng)
	pic := writeJPEG(t, filepath.Join(t.TempDir(), "p.jpg"), 64, 48)
	for kind, hint := range map[string]string{"depth": "Color", "subject": "Image"} {
		job, _ := newJob(t, []string{pic}, Options{Recipe: DefaultOptions().Recipe, Format: "same", Action: ActionMaps, MapKinds: []string{kind}})
		err := m.Run(t.Context(), job)
		ae := core.AsAppError(err)
		if ae == nil || ae.Code != core.CodeDependencyMissing || !strings.Contains(ae.Hint, hint) {
			t.Errorf("%s: %v", kind, err)
		}
	}
	if len(eng.calls) != 0 {
		t.Errorf("the engine was called without a model: %v", eng.calls)
	}
}

func TestMapsValidation(t *testing.T) {
	m := newModule(t, nil, nil)
	pic := writeJPEG(t, filepath.Join(t.TempDir(), "p.jpg"), 64, 48)
	for name, o := range map[string]Options{
		"no kinds":     {Recipe: DefaultOptions().Recipe, Format: "same", Action: ActionMaps},
		"unknown kind": {Recipe: DefaultOptions().Recipe, Format: "same", Action: ActionMaps, MapKinds: []string{"sky"}},
	} {
		job, _ := newJob(t, []string{pic}, o)
		if err := m.Validate(job.Inputs, job.Options); core.AsAppError(err) == nil {
			t.Errorf("%s accepted", name)
		}
	}
	job, _ := newJob(t, []string{pic, pic}, Options{Recipe: DefaultOptions().Recipe, Format: "same", Action: ActionMaps, MapKinds: []string{"depth"}})
	if err := m.Validate(job.Inputs, job.Options); core.AsAppError(err) == nil {
		t.Error("two files accepted for a maps job")
	}
	if !m.IsInteractive(job.Options) || m.IsInteractive([]byte(`{"wild":0.5}`)) {
		t.Error("only maps jobs are interactive")
	}
}

func TestPruneCache(t *testing.T) {
	root := t.TempDir()
	mk := func(name string, size int, age time.Duration) string {
		dir := filepath.Join(root, name)
		if err := writeFile(filepath.Join(dir, "depth.png"), string(make([]byte, size))); err != nil {
			t.Fatal(err)
		}
		when := time.Now().Add(-age)
		if err := os.Chtimes(dir, when, when); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	old := mk("old", 10, 45*24*time.Hour)
	a := mk("a", 600, 3*time.Hour)
	b := mk("b", 600, 2*time.Hour)
	c := mk("c", 600, time.Hour)
	readDir := mk("read", 10, 3*time.Hour)

	pruneCache(root, 30, 1300)
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
	if exists(old) {
		t.Error("a 45-day-old folder survived")
	}
	if exists(a) {
		t.Error("the oldest folder survived the size cap")
	}
	if !exists(b) || !exists(c) {
		t.Error("the newer folders were removed")
	}
	if exists(readDir) {
		t.Error("an hour-old Read still was kept")
	}
	pruneCache(filepath.Join(root, "nope"), 30, 1) // a missing cache is fine
	(&Module{}).PruneCache()
}
