//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/store"
	"toolbox/modules/composer"
	"toolbox/modules/posts"
	"toolbox/modules/videoeditor"
)

// TestPostSourcesE2E (SPEC.md §B13.7): a post made from a 60-file folder,
// a collage of 8 of its sources, a video stitched from 5 clips and two photo
// slides; the pool's usage reflects all three, and the export writes them.
// No AI engine: the collage's cut-outs are a UI flow, so the composition is
// built directly. Needs FFmpeg.
func TestPostSourcesE2E(t *testing.T) {
	support := t.TempDir()
	lib := filepath.Join(t.TempDir(), "Library")
	paths := core.NewPaths(support)
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(paths.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	em := &recorder{events: map[string]int{}}
	settings, err := core.NewSettingsService(db, em, lib)
	if err != nil {
		t.Fatal(err)
	}
	settings.SetSupportDir(paths.SupportDir)
	_ = os.MkdirAll(lib, 0o755)
	reg := core.NewRegistry()
	depSvc := deps.New(paths.BinDir, deps.Catalog(), reg, em)
	jobs := core.NewJobs(db, db, reg, em, depSvc.Resolve, settings.Current, paths.TmpDir)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	depSvc.Detect(ctx)
	ffmpeg, err := depSvc.Resolve(deps.FFmpeg)
	if err != nil {
		t.Skip("ffmpeg not available")
	}
	libDir := func() string { return lib }
	projectsDir := filepath.Join(paths.SupportDir, "projects")
	comp := composer.New(composer.Config{Store: db, ProjectsDir: projectsDir, CacheDir: filepath.Join(paths.CacheDir, "composer"),
		Jobs: jobs, Outputs: db, Emitter: em, LibraryDir: libDir})
	video := videoeditor.New(videoeditor.Config{Store: db, ProjectsDir: projectsDir, Resolve: depSvc.Resolve, Jobs: jobs})
	post := posts.New(posts.Config{Store: db, ProjectsDir: projectsDir, Composer: comp, Video: video, Resolve: depSvc.Resolve, LibraryDir: libDir})
	for _, err := range []error{composer.Register(reg, comp), videoeditor.Register(reg, video), posts.Register(reg, post)} {
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer jobs.Shutdown(10 * time.Second)
	wait := func(id string) core.Job {
		t.Helper()
		deadline := time.Now().Add(10 * time.Minute)
		for {
			j, err := jobs.Get(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if j.Status.Finished() {
				if j.Status != core.JobDone {
					t.Fatalf("%s %s: %s", j.ModuleID, j.Status, j.Error)
				}
				return j
			}
			if time.Now().After(deadline) {
				t.Fatal("timed out")
			}
			time.Sleep(150 * time.Millisecond)
		}
	}

	// --- a trip folder: 40 photos (some in a subfolder) and 20 clips ---
	trip := filepath.Join(t.TempDir(), "Thailand")
	if err := os.MkdirAll(filepath.Join(trip, "day 2"), 0o755); err != nil {
		t.Fatal(err)
	}
	var photos, clips []string
	for i := 0; i < 40; i++ {
		dir := trip
		if i >= 30 {
			dir = filepath.Join(trip, "day 2")
		}
		p := filepath.Join(dir, fmt.Sprintf("IMG_%04d.png", i))
		var buf bytes.Buffer
		if err := png.Encode(&buf, solid(1200, 1500, color.RGBA{uint8(i * 6), 120, 200, 255})); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		photos = append(photos, p)
	}
	src := filepath.Join(t.TempDir(), "src.mp4")
	if out, err := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4",
		"-f", "lavfi", "-i", "sine=duration=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v\n%s", err, out)
	}
	data, _ := os.ReadFile(src)
	for i := 0; i < 20; i++ {
		p := filepath.Join(trip, fmt.Sprintf("CLIP_%02d.mp4", i))
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
		clips = append(clips, p)
	}

	// --- the post from the folder ---
	psvc := posts.NewService(jobs, post)
	info, err := psvc.CreateFromFolder("Thailand", "carousel", "4:5", trip, false)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	pool, err := psvc.Sources(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pool) != 50 { // subfolders off: 30 photos + 20 clips
		t.Fatalf("pool without subfolders = %d", len(pool))
	}
	doc, _ := psvc.Get(info.ID)
	doc.Subfolders = true
	if _, err := psvc.Save(info.ID, "Thailand", doc); err != nil {
		t.Fatal(err)
	}
	if pool, err = psvc.Sources(info.ID); err != nil || len(pool) != 60 {
		t.Fatalf("pool with subfolders = %d, %v", len(pool), err)
	}
	t.Logf("60-file pool listed in %s", time.Since(start).Round(time.Millisecond))

	// --- a collage of 8 sources (background + 7 layers) ---
	cinfo, err := comp.Create(ctx, "Market", "4:5", photos[0])
	if err != nil {
		t.Fatal(err)
	}
	cdoc, _ := comp.Get(ctx, cinfo.ID)
	for i, p := range photos[1:8] {
		cdoc.Layers = append(cdoc.Layers, composer.Layer{ID: fmt.Sprintf("l%d", i), Kind: "image", X: 0.2 + 0.08*float64(i), Y: 0.5, Size: 0.2, Opacity: 1,
			Image: &composer.ImageLayer{Ref: composer.ImageRef{Path: p}, Crop: composer.Rect{W: 1, H: 1}}, Look: composer.Look{Preset: "none"}})
	}
	if _, err := comp.Save(ctx, cinfo.ID, "Market", cdoc); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, solid(1080, 1350, color.RGBA{220, 180, 90, 255}))
	if err := comp.SaveRender(ctx, cinfo.ID, "png", base64.StdEncoding.EncodeToString(buf.Bytes())); err != nil {
		t.Fatal(err)
	}

	// --- a video stitched from 5 clips (Quick vlog, no song) ---
	vsvc := videoeditor.NewService(jobs, video)
	pj, err := vsvc.Plan(videoeditor.PlanRequest{Paths: clips[:5], Aspect: "4:5", Order: "as-given", Transition: "fade"})
	if err != nil {
		t.Fatal(err)
	}
	var pr videoeditor.PlanResult
	if err := json.Unmarshal([]byte(wait(pj.ID).ResultJSON), &pr); err != nil || pr.ProjectID == "" {
		t.Fatalf("plan: %v", err)
	}

	// --- slides: the collage, the video, and 2 photos (one also in the collage) ---
	doc, _ = psvc.Get(info.ID)
	doc.Slides = []posts.Slide{
		{ID: "s1", Kind: "composition", ProjectID: cinfo.ID, Zoom: 1},
		{ID: "s2", Kind: "video", ProjectID: pr.ProjectID, Zoom: 1},
		{ID: "s3", Kind: "photo", Path: photos[3], Zoom: 1},
		{ID: "s4", Kind: "photo", Path: photos[35], Zoom: 1},
	}
	if _, err := psvc.Save(info.ID, "Thailand", doc); err != nil {
		t.Fatal(err)
	}
	pool, err = psvc.Sources(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	used := map[string][]string{}
	for _, s := range pool {
		used[s.Path] = s.UsedIn
	}
	for path, want := range map[string][]string{
		photos[0]: {"s1"}, photos[3]: {"s1", "s3"}, photos[7]: {"s1"}, photos[35]: {"s4"},
		clips[0]: {"s2"}, clips[4]: {"s2"}, photos[20]: nil, clips[10]: nil,
	} {
		got := append([]string{}, used[path]...)
		slices.Sort(got)
		if len(want) == 0 && len(got) == 0 {
			continue
		}
		if !slices.Equal(got, want) {
			t.Errorf("%s used in %v, want %v", filepath.Base(path), got, want)
		}
	}
	for _, is := range psvc.Check(doc) {
		t.Logf("check %s: %s", is.Level, is.Message)
		if is.Level == "error" {
			t.Fatalf("check error: %s", is.Message)
		}
	}

	// --- export ---
	ej, err := psvc.Export(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	var er posts.ExportResult
	_ = json.Unmarshal([]byte(wait(ej.ID).ResultJSON), &er)
	for _, name := range []string{"01.jpg", "02.mp4", "03.jpg", "04.jpg", "caption.txt", "post.json"} {
		if _, err := os.Stat(filepath.Join(er.Folder, name)); err != nil {
			t.Fatalf("missing %s in %s", name, er.Folder)
		}
	}
	for _, p := range photos {
		if _, err := os.Stat(p); err != nil {
			t.Fatal("a source was touched")
		}
	}
}
