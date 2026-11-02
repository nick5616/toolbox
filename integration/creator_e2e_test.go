//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/media"
	"toolbox/core/sidecar"
	"toolbox/core/store"
	"toolbox/core/viz"
	"toolbox/modules/bgremove"
	"toolbox/modules/composer"
	"toolbox/modules/posts"
	"toolbox/modules/videoeditor"
)

// Part B end-to-end (SPEC.md §B9 "the market scenario") on the real backend:
// a composition with a real cut-out, a Quick vlog cut on the beat, and a 4:5
// carousel exported to a folder. The dev sandbox's tools are used read-only;
// everything written lives in temp dirs.
// Run: TOOLBOX_CREATOR_E2E=1 go test -tags integration -run TestCreatorE2E -v -timeout 30m ./integration/

func TestCreatorE2E(t *testing.T) {
	if os.Getenv("TOOLBOX_CREATOR_E2E") != "1" {
		t.Skip("set TOOLBOX_CREATOR_E2E=1")
	}
	repo, _ := filepath.Abs("..")
	toolsDir := filepath.Join(repo, ".dev", "support")
	if _, err := os.Stat(filepath.Join(toolsDir, "sidecar")); err != nil {
		t.Skip("no sandbox engine in .dev/support")
	}
	models := filepath.Join(t.TempDir(), "models")
	for _, sub := range []string{"bg"} {
		if src := filepath.Join(toolsDir, "models", sub); dirExists(src) {
			copyTree(t, src, filepath.Join(models, sub))
		}
	}
	support := t.TempDir()
	lib := filepath.Join(t.TempDir(), "Library")
	paths := core.NewPathsWithTools(support, toolsDir)
	paths.ModelsDir = models
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
	engine := sidecar.NewManager(paths, func() (string, error) { return depSvc.Resolve(sidecar.DepID) }, em)
	depSvc.RegisterVirtual(deps.Spec{ID: sidecar.DepID, Name: "AI engine", Managed: true},
		func(ctx context.Context) core.DepStatus { return sidecar.Detect(ctx, paths) })
	engine.SetFFmpegResolver(func() (string, error) { return depSvc.Resolve(deps.FFmpeg) })
	defer engine.Stop()

	projectsDir := filepath.Join(paths.SupportDir, "projects")
	comp := composer.New(composer.Config{Store: db, ProjectsDir: projectsDir, CacheDir: filepath.Join(paths.CacheDir, "composer"),
		Engine: engine, Jobs: jobs, Outputs: db, Emitter: em, LibraryDir: func() string { return lib }})
	analyzer := viz.NewAnalyzer(filepath.Join(paths.CacheDir, "visualizer"), paths.ModelsDir, engine, nil)
	video := videoeditor.New(videoeditor.Config{Store: db, ProjectsDir: projectsDir, Engine: engine, Analyzer: analyzer,
		Resolve: depSvc.Resolve, Jobs: jobs})
	post := posts.New(posts.Config{Store: db, ProjectsDir: projectsDir, Engine: engine, Composer: comp, Video: video, Resolve: depSvc.Resolve})
	for _, err := range []error{
		bgremove.Register(reg, engine, paths.ModelsDir), composer.Register(reg, comp),
		videoeditor.Register(reg, video), posts.Register(reg, post),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer jobs.Shutdown(10 * time.Second)
	depSvc.Detect(ctx)
	for _, s := range depSvc.List() {
		if (s.ID == sidecar.DepID || s.ID == deps.FFmpeg) && s.State != core.DepOK {
			t.Skipf("%s is %s", s.ID, s.State)
		}
	}
	ffmpeg, _ := depSvc.Resolve(deps.FFmpeg)
	ffprobe, _ := depSvc.Resolve(deps.FFprobe)
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command(ffmpeg, append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v\n%s", err, out)
		}
	}
	waitJob := func(id string, timeout time.Duration) core.Job {
		t.Helper()
		deadline := time.Now().Add(timeout)
		for {
			j, err := jobs.Get(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if j.Status.Finished() {
				if j.Status != core.JobDone {
					lines, _ := jobs.Logs(ctx, id)
					for _, l := range lines {
						t.Log(l.Text)
					}
					t.Fatalf("job %s %s: %s (%s)", j.ModuleID, j.Status, j.Error, j.ErrorHint)
				}
				return j
			}
			if time.Now().After(deadline) {
				t.Fatalf("job %s timed out at %.0f%%", j.ModuleID, j.Progress*100)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}

	// --- inputs ---
	in := t.TempDir()
	market := filepath.Join(in, "market.jpg")
	shirt := filepath.Join(in, "shirt.jpg")
	copyFile(t, filepath.Join(repo, ".dev", "inputs", "Paris trip.jpg"), market)
	copyFile(t, filepath.Join(repo, ".dev", "inputs", "p3_src.jpg"), shirt)
	sideways := filepath.Join(in, "sideways.jpg")
	writeOrientedJPEG(t, sideways, 1200, 800, 6) // stored landscape, displayed portrait
	var clips []string
	for i, src := range []string{"testsrc", "smptebars", "rgbtestsrc"} {
		p := filepath.Join(in, "clip"+string(rune('1'+i))+".mp4")
		run("-f", "lavfi", "-i", src+"=size=1280x720:rate=30:duration=8", "-f", "lavfi", "-i", "sine=frequency=330:duration=8",
			"-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", p)
		clips = append(clips, p)
	}
	song := filepath.Join(in, "song.wav")
	run("-f", "lavfi", "-i", "sine=frequency=220:duration=24", "-f", "lavfi", "-i",
		"aevalsrc=0.8*exp(-30*mod(t\\,0.5))*sin(2*PI*60*t):d=24", "-filter_complex", "amix=inputs=2", song)

	// --- 1. Composition: market background + a real cut-out ---
	start := time.Now()
	info, err := comp.Create(ctx, "Market haul", "4:5", market)
	if err != nil {
		t.Fatal(err)
	}
	j, err := comp.RemoveBackground(ctx, shirt)
	if err != nil {
		t.Fatal(err)
	}
	cut := waitJob(j.ID, 10*time.Minute)
	if len(cut.Outputs) == 0 {
		t.Fatal("no cut-out")
	}
	doc, err := comp.Get(ctx, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	doc.Layers = append(doc.Layers, composer.Layer{
		ID: "l1", Kind: "image", Name: "Shirt", X: 0.3, Y: 0.6, Size: 0.4, Opacity: 1,
		Image:   &composer.ImageLayer{Ref: composer.ImageRef{Path: cut.Outputs[0].Path, Original: shirt}, Crop: composer.Rect{W: 1, H: 1}},
		Outline: composer.Outline{On: true, Width: 0.01, Color: "#ffffff"},
		Shadow:  composer.Shadow{On: true, Blur: 0.02, OffsetY: 0.01, Opacity: 0.4, Color: "#000000"},
		Look:    composer.Look{Preset: "none"},
	})
	if _, err := comp.Save(ctx, info.ID, "Market haul", doc); err != nil {
		t.Fatalf("save composition: %v", err)
	}
	// The webview renders compositions; stand in with a solid 1080×1350 PNG.
	var buf bytes.Buffer
	if err := png.Encode(&buf, solid(1080, 1350, color.RGBA{200, 120, 60, 255})); err != nil {
		t.Fatal(err)
	}
	if err := comp.SaveRender(ctx, info.ID, "png", base64.StdEncoding.EncodeToString(buf.Bytes())); err != nil {
		t.Fatal(err)
	}
	t.Logf("composition with a real cut-out in %s", time.Since(start).Round(time.Millisecond))

	// --- 2. Quick vlog cut on the beat ---
	start = time.Now()
	vsvc := videoeditor.NewService(jobs, video)
	pj, err := vsvc.Plan(videoeditor.PlanRequest{Paths: append(clips, sideways), MusicPath: song, Aspect: "4:5",
		Order: "as-given", BeatCut: true, Transition: "fade"})
	if err != nil {
		t.Fatal(err)
	}
	planned := waitJob(pj.ID, 10*time.Minute)
	var pr videoeditor.PlanResult
	if err := json.Unmarshal([]byte(planned.ResultJSON), &pr); err != nil || pr.ProjectID == "" {
		t.Fatalf("plan result %q: %v", planned.ResultJSON, err)
	}
	vdoc, err := video.Get(ctx, pr.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("quick vlog planned in %s: %d clips, %d ms", time.Since(start).Round(time.Millisecond), len(vdoc.Clips), videoeditor.DurationMs(vdoc))
	rj, err := vsvc.Render(pr.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	rendered := waitJob(rj.ID, 15*time.Minute)
	vinfo, err := media.Probe(ctx, ffprobe, rendered.Outputs[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if vinfo.Video == nil || vinfo.Video.Width != 1080 || vinfo.Video.Height != 1350 {
		t.Fatalf("vlog frame = %+v", vinfo.Video)
	}
	if d := vinfo.DurationMs - videoeditor.DurationMs(vdoc); d < -100 || d > 100 {
		t.Fatalf("vlog duration %d ms vs timeline %d ms", vinfo.DurationMs, videoeditor.DurationMs(vdoc))
	}
	t.Logf("vlog rendered in %s", time.Since(start).Round(time.Millisecond))

	// --- 3. Post: photos + composition + vlog + a clip, exported ---
	start = time.Now()
	psvc := posts.NewService(jobs, post)
	pinfo, err := psvc.Create("Trip dump", "carousel", "4:5", []string{market, sideways, clips[0]})
	if err != nil {
		t.Fatal(err)
	}
	pdoc, err := psvc.Get(pinfo.ID)
	if err != nil {
		t.Fatal(err)
	}
	pdoc.Slides = append(pdoc.Slides,
		posts.Slide{ID: core.NewID(), Kind: "composition", ProjectID: info.ID, Zoom: 1, AltText: "Market haul"},
		posts.Slide{ID: core.NewID(), Kind: "video", ProjectID: pr.ProjectID, Zoom: 1})
	pdoc.Caption = "Market day 🧺 #travel #market"
	if _, err := psvc.Save(pinfo.ID, "Trip dump", pdoc); err != nil {
		t.Fatal(err)
	}
	for _, is := range psvc.Check(pdoc) {
		t.Logf("check %s: %s", is.Level, is.Message)
		if is.Level == "error" {
			t.Fatalf("check error: %s", is.Message)
		}
	}
	ej, err := psvc.Export(pinfo.ID)
	if err != nil {
		t.Fatal(err)
	}
	exported := waitJob(ej.ID, 15*time.Minute)
	var er posts.ExportResult
	if err := json.Unmarshal([]byte(exported.ResultJSON), &er); err != nil {
		t.Fatal(err)
	}
	t.Logf("exported %s in %s", er.Folder, time.Since(start).Round(time.Millisecond))
	want := []string{"01.jpg", "02.jpg", "03.mp4", "04.jpg", "05.mp4", "caption.txt", "alt-text.txt", "post.json"}
	for _, name := range want {
		if _, err := os.Stat(filepath.Join(er.Folder, name)); err != nil {
			t.Fatalf("missing %s", name)
		}
	}
	for _, name := range []string{"01.jpg", "02.jpg", "04.jpg"} {
		f, err := os.Open(filepath.Join(er.Folder, name))
		if err != nil {
			t.Fatal(err)
		}
		cfg, _, err := image.DecodeConfig(f)
		f.Close()
		if err != nil || cfg.Width != 1080 || cfg.Height != 1350 {
			t.Fatalf("%s is %dx%d (%v)", name, cfg.Width, cfg.Height, err)
		}
	}
	for _, name := range []string{"03.mp4", "05.mp4"} {
		vi, err := media.Probe(ctx, ffprobe, filepath.Join(er.Folder, name))
		if err != nil || vi.Video == nil || vi.Video.Width != 1080 || vi.Video.Height != 1350 || vi.DurationMs > 60_000 {
			t.Fatalf("%s: %+v (%v)", name, vi.Video, err)
		}
	}
	caption, _ := os.ReadFile(filepath.Join(er.Folder, "caption.txt"))
	if !strings.Contains(string(caption), "#travel") {
		t.Fatalf("caption.txt = %q", caption)
	}
	// The sideways photo was stored landscape with orientation 6: its slide is
	// framed from the upright (portrait) image, so the top-left is the stored
	// image's bottom-left colour.
	f, err := os.Open(filepath.Join(er.Folder, "02.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	r, g, b, _ := img.At(20, 20).RGBA()
	if !(b > r && b > g) {
		t.Fatalf("02.jpg isn't upright: top-left is %d,%d,%d (want blue)", r>>8, g>>8, b>>8)
	}
	if _, err := os.Stat(shirt); err != nil {
		t.Fatal("an input was touched")
	}
}

func solid(w, h int, c color.Color) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	return img
}

// writeOrientedJPEG writes a w×h JPEG whose left half is red and right half
// is green, except the bottom-left quarter is blue, with EXIF orientation o.
// For o = 6 (rotate 90° clockwise to display) the stored bottom-left becomes
// the displayed top-left.
func writeOrientedJPEG(t *testing.T, path string, w, h, o int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.RGBA{220, 30, 30, 255}
			if x >= w/2 {
				c = color.RGBA{30, 200, 30, 255}
			}
			if x < w/2 && y >= h/2 {
				c = color.RGBA{30, 30, 230, 255}
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 92}); err != nil {
		t.Fatal(err)
	}
	// APP1 Exif: big-endian TIFF with one IFD0 entry, Orientation (SHORT) = o.
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, byte(o), 0, 0, 0, 0, 0, 0}
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}
	seg = append(seg, payload...)
	data := buf.Bytes()
	out := append([]byte{}, data[:2]...) // SOI
	out = append(out, seg...)
	out = append(out, data[2:]...)
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatal(err)
	}
}
