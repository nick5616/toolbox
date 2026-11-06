package compress

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	_ "golang.org/x/image/webp"

	"toolbox/core"
)

// ---- helpers ----

type fileRec struct {
	mu      sync.Mutex
	outputs []string
}

// fileJob builds a JobContext for the file runners. tool may be nil (no tools).
func fileJob(t *testing.T, tool toolFunc) (*core.JobContext, *fileRec) {
	t.Helper()
	rec := &fileRec{}
	raw, _ := json.Marshal(DefaultOptions())
	return core.NewJobContext(core.JobContext{
		ID: "j1", ModuleID: ModuleID, Options: raw,
		OutputDir: filepath.Join(t.TempDir(), "out"), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) {
			rec.mu.Lock()
			defer rec.mu.Unlock()
			rec.outputs = append(rec.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool: func(id string) (string, error) {
			if tool == nil {
				return "", core.ErrDependencyMissing(id, "")
			}
			return tool(id)
		},
	}), rec
}

func fileFFmpeg(t *testing.T) toolFunc {
	t.Helper()
	dir := os.Getenv("TOOLBOX_TEST_FFMPEG_DIR")
	if dir == "" {
		dir = `C:\Users\nickb\repos\toolbox\.dev\p5-research\packs\win\ffmpeg-9.0.2-essentials_build\bin`
	}
	p := filepath.Join(dir, "ffmpeg.exe")
	if _, err := os.Stat(p); err != nil {
		lp, e := exec.LookPath("ffmpeg")
		if e != nil {
			t.Skipf("FFmpeg not found at %s", p)
		}
		p = lp
	}
	return func(id string) (string, error) {
		if id == "ffmpeg" {
			return p, nil
		}
		return "", core.ErrDependencyMissing(id, "")
	}
}

// noisyImage is a gradient with random noise (hard to compress).
func noisyImage(w, h int, alpha bool) *image.NRGBA {
	rng := rand.New(rand.NewSource(1))
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := uint8(255)
			if alpha && x < w/2 {
				a = 128
			}
			img.SetNRGBA(x, y, color.NRGBA{uint8(x*255/w) ^ uint8(rng.Intn(60)), uint8(y*255/h) + uint8(rng.Intn(40)), uint8(rng.Intn(256)), a})
		}
	}
	return img
}

// gradientImage is a smooth picture (compresses well as PNG).
func gradientImage(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x * 255 / w), uint8(y * 255 / h), 90, 255})
		}
	}
	return img
}

func writePNG(t *testing.T, path string, img image.Image) {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fileInput(t *testing.T, path string, limit int64, opts Options) input {
	t.Helper()
	n, err := fileSize(path)
	if err != nil {
		t.Fatal(err)
	}
	return input{Path: path, Size: n, Limit: limit, Opts: opts}
}

func decodeFile(t *testing.T, path string) (image.Image, string) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, format, err := image.Decode(f)
	if err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return img, format
}

// ---- photos: pure ----

func TestSearchQuality(t *testing.T) {
	size := func(q int) (int64, error) { return int64(q) * 1000, nil } // grows with q
	tests := []struct {
		name   string
		budget int64
		want   int
		ok     bool
	}{
		{"all fit", 200_000, 92, true},
		{"middle", 70_500, 70, true},
		{"only the lowest", 40_000, 40, true},
		{"nothing fits", 39_999, 40, false},
		{"exactly top", 92_000, 92, true},
	}
	for _, tt := range tests {
		q, _, loSize, ok, err := searchQuality(photoQMin, photoQMax, tt.budget, size)
		if err != nil || q != tt.want || ok != tt.ok || loSize != 40_000 {
			t.Errorf("%s: q=%d ok=%v lo=%d err=%v, want q=%d ok=%v", tt.name, q, ok, loSize, err, tt.want, tt.ok)
		}
	}
	// Binary search: about 6 encodes for 53 levels, not 53.
	calls := 0
	_, _, _, _, _ = searchQuality(40, 92, 70_500, func(q int) (int64, error) { calls++; return size(q) })
	if calls > 8 {
		t.Errorf("search used %d encodes", calls)
	}
	boom := errors.New("boom")
	if _, _, _, _, err := searchQuality(40, 92, 1, func(int) (int64, error) { return 0, boom }); !errors.Is(err, boom) {
		t.Errorf("error not passed on: %v", err)
	}
}

func TestNextScale(t *testing.T) {
	// 4x too big at q40: linear 0.5 x 0.95.
	got := nextScale(1, 4_000_000, 1_000_000)
	if got < 0.474 || got > 0.476 {
		t.Errorf("nextScale = %v", got)
	}
	if got := nextScale(0.5, 1_000_010, 1_000_000); got > 0.5*0.951 {
		t.Errorf("nextScale must always shrink: %v", got)
	}
}

func TestImageGrade(t *testing.T) {
	tests := []struct {
		q     int
		scale float64
		want  Grade
	}{
		{92, 1, GradeGreat}, {80, 1, GradeGreat}, {79, 1, GradeGood}, {65, 1, GradeGood},
		{64, 1, GradeFair}, {50, 1, GradeFair}, {49, 1, GradePoor}, {40, 1, GradePoor},
		{92, 0.49, GradeFair}, {70, 0.3, GradeFair}, {45, 0.3, GradePoor}, {100, 0.5, GradeGreat},
	}
	for _, tt := range tests {
		if got := imageGrade(tt.q, tt.scale); got != tt.want {
			t.Errorf("imageGrade(%d, %v) = %q, want %q", tt.q, tt.scale, got, tt.want)
		}
	}
}

func TestImagePlan(t *testing.T) {
	if got := imagePlan(fmtJPEG, fitResult{Quality: 78, W: 4032, H: 3024, OrigLong: 4032}); got != "JPEG quality 78 · 4032×3024" {
		t.Errorf("got %q", got)
	}
	if got := imagePlan(fmtJPEG, fitResult{Quality: 60, W: 2016, H: 1512, OrigLong: 4032}); got != "JPEG quality 60 · 4032 → 2016 px" {
		t.Errorf("got %q", got)
	}
	if got := imagePlan(fmtPNG, fitResult{W: 100, H: 50, OrigLong: 100}); got != "PNG · 100×50" {
		t.Errorf("got %q", got)
	}
	if got := imagePlan(fmtWebP, fitResult{Quality: 55, W: 10, H: 10, OrigLong: 10}); got != "WebP quality 55 · 10×10" {
		t.Errorf("got %q", got)
	}
}

func TestPickFormat(t *testing.T) {
	tests := []struct {
		opt       ImageFormat
		ext       string
		alpha, ff bool
		want      imgFormat
	}{
		{ImageAuto, ".png", false, true, fmtJPEG},
		{ImageAuto, ".png", true, true, fmtWebP},
		{ImageAuto, ".png", true, false, fmtPNG},
		{ImageJPEG, ".png", true, true, fmtJPEG},
		{ImageWebP, ".jpg", false, true, fmtWebP},
		{ImageKeep, ".jpg", false, true, fmtJPEG},
		{ImageKeep, ".jpeg", false, false, fmtJPEG},
		{ImageKeep, ".png", false, true, fmtPNG},
		{ImageKeep, ".webp", false, true, fmtWebP},
		{ImageKeep, ".webp", false, false, fmtJPEG},
		{ImageKeep, ".bmp", false, true, fmtJPEG},
		{ImageKeep, ".tiff", true, true, fmtWebP},
		{ImageKeep, ".heic", false, true, fmtJPEG},
	}
	for _, tt := range tests {
		if got := pickFormat(tt.opt, tt.ext, tt.alpha, tt.ff); got != tt.want {
			t.Errorf("pickFormat(%s,%s,alpha=%v,ff=%v) = %v, want %v", tt.opt, tt.ext, tt.alpha, tt.ff, got, tt.want)
		}
	}
}

func TestFitImageScalesWhenQualityIsNotEnough(t *testing.T) {
	img := noisyImage(800, 600, false)
	// Pretend size is proportional to pixels and quality-independent: the
	// search must scale to get under the budget.
	enc := func(i image.Image, q int) (int64, []byte, error) {
		b := i.Bounds()
		return int64(b.Dx() * b.Dy()), nil, nil
	}
	r, err := fitImage(context.Background(), img, enc, true, 120_000, 1)
	if err != nil || !r.OK {
		t.Fatalf("not ok: %+v %v", r, err)
	}
	if r.W >= 800 || r.W*r.H > 120_000 || r.OrigLong != 800 || r.Scale >= 1 {
		t.Errorf("unexpected fit %+v", r)
	}
	// Impossible: size never drops below the budget.
	hopeless := func(image.Image, int) (int64, []byte, error) { return 1 << 30, nil, nil }
	r, err = fitImage(context.Background(), img, hopeless, true, 1000, 1)
	if err != nil || r.OK {
		t.Fatalf("expected impossible: %+v %v", r, err)
	}
	if max(r.W, r.H) < photoFloorLong-1 {
		t.Errorf("went below the floor: %dx%d", r.W, r.H)
	}
}

// ---- photos: real ----

func TestRunImageJPEG(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.png")
	writePNG(t, src, noisyImage(3000, 2000, false))
	job, rec := fileJob(t, nil)
	const limit = 300_000
	res, err := runImage(context.Background(), job, fileInput(t, src, limit, DefaultOptions()))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Outputs) != 1 || len(rec.outputs) != 1 {
		t.Fatalf("outputs = %v", res.Outputs)
	}
	n, _ := fileSize(res.Outputs[0])
	if n > limit {
		t.Errorf("output %d bytes is over the limit", n)
	}
	img, format := decodeFile(t, res.Outputs[0])
	if format != "jpeg" || !strings.HasSuffix(res.Outputs[0], "photo (compressed).jpg") {
		t.Errorf("format %s path %s", format, res.Outputs[0])
	}
	b := img.Bounds()
	if b.Dx()*2 != b.Dy()*3 && absDiff(b.Dx()*2, b.Dy()*3) > 6 {
		t.Errorf("aspect changed: %dx%d", b.Dx(), b.Dy())
	}
	if res.Grade == "" || !strings.HasPrefix(res.Plan, "JPEG quality ") {
		t.Errorf("plan %q grade %q", res.Plan, res.Grade)
	}
}

func absDiff(a, b int) int {
	if a < b {
		return b - a
	}
	return a - b
}

func TestRunImageAppliesOrientation(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "rot.jpg")
	// A 1200x800 landscape JPEG tagged "rotate 90 CW" (6) must come out portrait.
	var enc bytes.Buffer
	if err := jpeg.Encode(&enc, noisyImage(1200, 800, false), &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	var tiff bytes.Buffer
	tiff.WriteString("MM")
	_ = binary.Write(&tiff, binary.BigEndian, uint16(42))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(8))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(1))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(0x0112))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(3))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(1))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(6))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(0))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(0))
	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	var out bytes.Buffer
	out.Write(enc.Bytes()[:2])
	out.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&out, binary.BigEndian, uint16(len(payload)+2))
	out.Write(payload)
	out.Write(enc.Bytes()[2:])
	if err := os.WriteFile(src, out.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	job, _ := fileJob(t, nil)
	res, err := runImage(context.Background(), job, fileInput(t, src, 150_000, DefaultOptions()))
	if err != nil {
		t.Fatal(err)
	}
	img, _ := decodeFile(t, res.Outputs[0])
	if b := img.Bounds(); b.Dy() <= b.Dx() {
		t.Errorf("expected portrait after orientation, got %dx%d", b.Dx(), b.Dy())
	}
}

func TestRunImageTransparentFallsBackToPNG(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "alpha.png")
	writePNG(t, src, noisyImage(1500, 1000, true))
	job, _ := fileJob(t, nil) // no FFmpeg
	const limit = 400_000
	res, err := runImage(context.Background(), job, fileInput(t, src, limit, DefaultOptions()))
	if err != nil {
		t.Fatal(err)
	}
	n, _ := fileSize(res.Outputs[0])
	_, format := decodeFile(t, res.Outputs[0])
	if format != "png" || n > limit || !strings.HasPrefix(res.Plan, "PNG") {
		t.Errorf("format %s size %d plan %q", format, n, res.Plan)
	}
}

func TestRunImageTransparentWebP(t *testing.T) {
	tool := fileFFmpeg(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "alpha.png")
	writePNG(t, src, noisyImage(1200, 800, true))
	job, _ := fileJob(t, tool)
	const limit = 150_000
	res, err := runImage(context.Background(), job, fileInput(t, src, limit, DefaultOptions()))
	if err != nil {
		t.Fatal(err)
	}
	n, _ := fileSize(res.Outputs[0])
	_, format := decodeFile(t, res.Outputs[0])
	if format != "webp" || n > limit || !strings.HasPrefix(res.Plan, "WebP quality") {
		t.Errorf("format %s size %d plan %q", format, n, res.Plan)
	}
}

func TestRunImageImpossible(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "p.png")
	writePNG(t, src, noisyImage(400, 300, false))
	job, _ := fileJob(t, nil)
	_, err := runImage(context.Background(), job, fileInput(t, src, 300, DefaultOptions()))
	ae := core.AsAppError(err)
	if ae == nil || ae.Code != core.CodeToolFailed || !strings.Contains(ae.Message, "Couldn't get it under") {
		t.Fatalf("err = %v", err)
	}
}

func TestEstimateImage(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.png")
	writePNG(t, src, noisyImage(1600, 1200, false))
	est := estimateImage(context.Background(), nil, fileInput(t, src, 200_000, DefaultOptions()))
	if !est.Possible || est.Problem != "" || est.Grade == "" || !strings.Contains(est.Plan, "JPEG") {
		t.Errorf("estimate = %+v", est)
	}
	est = estimateImage(context.Background(), nil, fileInput(t, src, 200, DefaultOptions()))
	if est.Possible || est.Plan != "Can't fit" {
		t.Errorf("impossible estimate = %+v", est)
	}
	bad := filepath.Join(dir, "bad.jpg")
	_ = os.WriteFile(bad, []byte("not a photo"), 0o644)
	if est := estimateImage(context.Background(), nil, fileInput(t, bad, 5, DefaultOptions())); est.Problem == "" {
		t.Errorf("expected a problem: %+v", est)
	}
}

// ---- GIF ----

func TestGifReduceAndNext(t *testing.T) {
	src := gifSource{Width: 800, Height: 600, Frames: 100, DurationSec: 5, FPS: 20}
	first := gifInitial(src, 10_000_000, 2_000_000)
	if first.Width >= 800 || first.Width < gifMinWidth || first.FPS >= 20 || first.FPS < gifMinFPS || first.Colors != 256 || first.Width%2 != 0 {
		t.Errorf("initial = %+v", first)
	}
	// size ∝ w²·fps: the predicted area x fps product is about 0.9 x budget ratio.
	ratio := float64(first.Width*first.Width*first.FPS) / float64(800*800*20)
	if ratio < 0.12 || ratio > 0.25 {
		t.Errorf("product ratio %v far from 0.18", ratio)
	}
	// Too big again: it must shrink further.
	next, changed := gifNext(first, 3_000_000, 2_000_000, src, 1)
	if !changed || next.Width*next.Width*next.FPS >= first.Width*first.Width*first.FPS {
		t.Errorf("next = %+v", next)
	}
	// Much smaller than the budget: it may grow, never beyond the source.
	grown, changed := gifNext(first, 500_000, 2_000_000, src, 1)
	if !changed || grown.Width > 800 || grown.FPS > 20 || grown.Width*grown.Width*grown.FPS <= first.Width*first.Width*first.FPS {
		t.Errorf("grown = %+v", grown)
	}
	// Colours drop on later attempts only.
	if n, _ := gifNext(first, 3_000_000, 2_000_000, src, 2); n.Colors != 128 {
		t.Errorf("attempt 2 colours = %d", n.Colors)
	}
	if n, _ := gifNext(first, 3_000_000, 2_000_000, src, 4); n.Colors != 64 {
		t.Errorf("attempt 4 colours = %d", n.Colors)
	}
	// At the floors nothing moves.
	floor := gifSettings{Width: gifMinWidth, FPS: gifMinFPS, Colors: 64}
	if _, changed := gifNext(floor, 3_000_000, 2_000_000, src, 5); changed {
		t.Error("floor settings should not change")
	}
	// Floors respect a tiny source.
	tiny := gifSource{Width: 40, Height: 40, Frames: 10, DurationSec: 2, FPS: 5}
	s := gifInitial(tiny, 10_000_000, 100_000)
	if s.Width != 40 || s.FPS < 4 {
		t.Errorf("tiny initial = %+v", s)
	}
}

func TestGifGradeAndPlan(t *testing.T) {
	for scale, want := range map[float64]Grade{1: GradeGreat, 0.8: GradeGreat, 0.7: GradeGood, 0.6: GradeGood, 0.5: GradeFair, 0.4: GradeFair, 0.39: GradePoor} {
		if got := gifGrade(scale); got != want {
			t.Errorf("gifGrade(%v) = %q, want %q", scale, got, want)
		}
	}
	if got := (gifSettings{480, 12, 128}).plan(); got != "GIF 480 px · 12 fps · 128 colours" {
		t.Errorf("plan = %q", got)
	}
}

func writeGIF(t *testing.T, path string, frames int) {
	t.Helper()
	g := &gif.GIF{}
	pal := color.Palette{}
	for i := 0; i < 256; i++ {
		pal = append(pal, color.RGBA{uint8(i), uint8(255 - i), uint8(i * 7), 255})
	}
	rng := rand.New(rand.NewSource(2))
	for f := 0; f < frames; f++ {
		img := image.NewPaletted(image.Rect(0, 0, 320, 240), pal)
		for i := range img.Pix {
			img.Pix[i] = uint8((i%320 + f*5 + rng.Intn(40)) % 256)
		}
		g.Image = append(g.Image, img)
		g.Delay = append(g.Delay, 5) // 20 fps
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadGIFAndEstimate(t *testing.T) {
	src := filepath.Join(t.TempDir(), "a.gif")
	writeGIF(t, src, 20)
	s, err := readGIF(src)
	if err != nil || s.Frames != 20 || s.Width != 320 || s.FPS < 19.9 || s.FPS > 20.1 {
		t.Fatalf("readGIF = %+v %v", s, err)
	}
	est := estimateGIF(context.Background(), nil, fileInput(t, src, 100_000, DefaultOptions()))
	if !est.Possible || !strings.HasPrefix(est.Plan, "GIF ") || est.Note != "GIFs are re-drawn until they fit" {
		t.Errorf("estimate = %+v", est)
	}
}

func TestRunGIF(t *testing.T) {
	tool := fileFFmpeg(t)
	src := filepath.Join(t.TempDir(), "a.gif")
	writeGIF(t, src, 30)
	in := fileInput(t, src, 0, DefaultOptions())
	in.Limit = in.Size / 3
	job, _ := fileJob(t, tool)
	res, err := runGIF(context.Background(), job, in)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := fileSize(res.Outputs[0])
	if n > in.Limit || !strings.HasSuffix(res.Outputs[0], ".gif") || res.Attempts < 1 || res.Attempts > gifMaxEncodes || res.Grade == "" {
		t.Errorf("size %d limit %d result %+v", n, in.Limit, res)
	}
	g, err := readGIF(res.Outputs[0])
	if err != nil || g.Frames < 2 {
		t.Errorf("output not animated: %+v %v", g, err)
	}
}

func TestRunGIFSingleFrameIsAPhoto(t *testing.T) {
	src := filepath.Join(t.TempDir(), "one.gif")
	g := &gif.GIF{}
	pal := color.Palette{}
	for i := 0; i < 256; i++ {
		pal = append(pal, color.RGBA{uint8(i), uint8(i / 2), uint8(255 - i), 255})
	}
	img := image.NewPaletted(image.Rect(0, 0, 600, 600), pal)
	rng := rand.New(rand.NewSource(3))
	for i := range img.Pix {
		img.Pix[i] = uint8(rng.Intn(256))
	}
	g.Image, g.Delay = []*image.Paletted{img}, []int{0}
	var buf bytes.Buffer
	_ = gif.EncodeAll(&buf, g)
	_ = os.WriteFile(src, buf.Bytes(), 0o644)
	job, _ := fileJob(t, nil)
	res, err := runGIF(context.Background(), job, fileInput(t, src, 100_000, DefaultOptions()))
	if err != nil {
		t.Fatal(err)
	}
	if _, format := decodeFile(t, res.Outputs[0]); format != "jpeg" {
		t.Errorf("format %s", format)
	}
}

// ---- PDF / Office ladders ----

func TestSearchLadder(t *testing.T) {
	tests := []struct {
		name    string
		fitFrom int // levels >= fitFrom fit; 6 = none
		want    int
		tried   []int
	}{
		{"all fit", 0, 0, []int{2, 0}},
		{"middle", 3, 3, []int{2, 4, 3}},
		{"last only", 5, 5, []int{2, 4, 5}},
		{"none", 6, -1, []int{2, 4, 5}},
		{"second", 1, 1, []int{2, 0, 1}},
	}
	for _, tt := range tests {
		var tried []int
		got, err := searchLadder(6, func(i int) (bool, error) {
			tried = append(tried, i)
			return i >= tt.fitFrom, nil
		})
		if err != nil || got != tt.want || !slices.Equal(tried, tt.tried) {
			t.Errorf("%s: got %d tried %v err %v, want %d tried %v", tt.name, got, tried, err, tt.want, tt.tried)
		}
	}
	boom := errors.New("boom")
	if _, err := searchLadder(6, func(int) (bool, error) { return false, boom }); !errors.Is(err, boom) {
		t.Errorf("err = %v", err)
	}
}

func TestLadderGradeAndPlans(t *testing.T) {
	want := []Grade{GradeGreat, GradeGood, GradeFair, GradeFair, GradePoor, GradePoor}
	for i, w := range want {
		if got := ladderGrade(i); got != w {
			t.Errorf("ladderGrade(%d) = %q, want %q", i, got, w)
		}
	}
	if got := pdfPlan(pdfLadder[2]); got != "Pictures at 110 dpi, quality 55" {
		t.Errorf("pdfPlan = %q", got)
	}
	if got := officePlan(officeLadder[2], 14); got != "14 pictures at ≤ 1600 px, quality 75" {
		t.Errorf("officePlan = %q", got)
	}
	if got := officePlan(officeLadder[0], 1); got != "1 picture at ≤ 2400 px, quality 85" {
		t.Errorf("officePlan = %q", got)
	}
	if pdfLadder[0] != (pdfLevel{220, 82}) || pdfLadder[5] != (pdfLevel{50, 25}) || officeLadder[0] != (officeLevel{2400, 85}) || officeLadder[5] != (officeLevel{800, 50}) {
		t.Error("ladders differ from the spec")
	}
}

func TestLockedPDF(t *testing.T) {
	err := lockedPDF(core.ValidationError("This PDF needs a password", nil))
	ae := core.AsAppError(err)
	if ae == nil || ae.Message != "This PDF is locked" || ae.Hint != "Unlock it with PDF Toolkit first" {
		t.Errorf("err = %v", err)
	}
	ae = core.AsAppError(lockedPDF(core.ValidationError("This PDF's permissions block editing", nil)))
	if ae.Message != "This PDF is locked" {
		t.Errorf("restricted: %v", ae)
	}
	other := core.ValidationError("This PDF is damaged and couldn't be read", nil)
	if lockedPDF(other) != error(other) {
		t.Error("other errors must pass through")
	}
}

func TestPDFSamples(t *testing.T) {
	dir := os.Getenv("TOOLBOX_PDF_INPUTS")
	if dir == "" {
		dir = `C:\Users\nickb\repos\toolbox\.dev\p4-research\pdf\inputs`
	}
	src := filepath.Join(dir, "scan_color.pdf")
	if _, err := os.Stat(src); err != nil {
		t.Skip("sample PDFs not present")
	}
	in := fileInput(t, src, 0, DefaultOptions())
	in.Limit = in.Size / 2
	job, _ := fileJob(t, nil)
	res, err := runPDF(context.Background(), job, in)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := fileSize(res.Outputs[0])
	if n > in.Limit || !strings.HasPrefix(res.Plan, "Pictures at ") || res.Grade == "" {
		t.Errorf("size %d limit %d result %+v", n, in.Limit, res)
	}
	// An encrypted PDF is "locked".
	enc := filepath.Join(dir, "encrypted_aes256_user123_owner456.pdf")
	if _, err := os.Stat(enc); err == nil {
		job, _ := fileJob(t, nil)
		_, err := runPDF(context.Background(), job, fileInput(t, enc, 1000, DefaultOptions()))
		if ae := core.AsAppError(err); ae == nil || ae.Message != "This PDF is locked" {
			t.Errorf("encrypted: %v", err)
		}
	}
	// Nothing fits.
	job, _ = fileJob(t, nil)
	_, err = runPDF(context.Background(), job, fileInput(t, src, 2000, DefaultOptions()))
	if ae := core.AsAppError(err); ae == nil || !strings.Contains(ae.Hint, "text and fonts") {
		t.Errorf("impossible: %v", err)
	}
}

func TestEstimatePDF(t *testing.T) {
	e := estimatePDF(context.Background(), nil, input{})
	if !e.Possible || e.Plan != "Recompresses its pictures until it fits" || e.Grade != "" || e.Note == "" {
		t.Errorf("estimate = %+v", e)
	}
}

// buildDocx makes a docx-like zip: [Content_Types].xml first, then a text
// part, a big JPEG, a PNG and an unrelated media-like part.
func buildDocx(t *testing.T, path string) (names []string, contents map[string][]byte) {
	t.Helper()
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, noisyImage(2600, 1800, false), &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	var pngb bytes.Buffer
	if err := png.Encode(&pngb, gradientImage(1800, 1400)); err != nil {
		t.Fatal(err)
	}
	contents = map[string][]byte{
		"[Content_Types].xml":    []byte(`<Types>` + strings.Repeat("x", 500) + `</Types>`),
		"word/document.xml":      []byte(strings.Repeat("<w:p>hello</w:p>", 500)),
		"word/media/image1.jpeg": jpg.Bytes(),
		"word/media/image2.png":  pngb.Bytes(),
		"word/media/vector.emf":  bytes.Repeat([]byte{1, 2, 3, 4, 5, 6, 7}, 100),
		"docProps/core.xml":      []byte("<core/>"),
	}
	names = []string{"[Content_Types].xml", "word/document.xml", "word/media/image1.jpeg", "word/media/image2.png", "word/media/vector.emf", "docProps/core.xml"}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, n := range names {
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write(contents[n])
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()
	return names, contents
}

func readZip(t *testing.T, path string) (names []string, contents map[string][]byte) {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	contents = map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		names = append(names, f.Name)
		contents[f.Name] = b
	}
	return names, contents
}

func TestRunOfficeKeepsOtherPartsIdentical(t *testing.T) {
	src := filepath.Join(t.TempDir(), "report.docx")
	wantNames, want := buildDocx(t, src)
	in := fileInput(t, src, 0, DefaultOptions())
	in.Limit = 400_000
	if in.Size < 3*in.Limit {
		t.Fatalf("fixture too small: %d", in.Size)
	}
	job, rec := fileJob(t, nil)
	res, err := runOffice(context.Background(), job, in)
	if err != nil {
		t.Fatal(err)
	}
	out := res.Outputs[0]
	if !strings.HasSuffix(out, "report (compressed).docx") || len(rec.outputs) != 1 {
		t.Errorf("output %s", out)
	}
	n, _ := fileSize(out)
	if n > in.Limit {
		t.Errorf("output %d over limit %d", n, in.Limit)
	}
	gotNames, got := readZip(t, out)
	if !slices.Equal(gotNames, wantNames) {
		t.Errorf("entry order changed: %v", gotNames)
	}
	for _, name := range []string{"[Content_Types].xml", "word/document.xml", "word/media/vector.emf", "docProps/core.xml"} {
		if !bytes.Equal(got[name], want[name]) {
			t.Errorf("%s changed", name)
		}
	}
	if len(got["word/media/image1.jpeg"]) >= len(want["word/media/image1.jpeg"]) {
		t.Error("jpeg not smaller")
	}
	if _, format, err := image.Decode(bytes.NewReader(got["word/media/image1.jpeg"])); err != nil || format != "jpeg" {
		t.Errorf("jpeg entry: %v %s", err, format)
	}
	if _, format, err := image.Decode(bytes.NewReader(got["word/media/image2.png"])); err != nil || format != "png" {
		t.Errorf("png entry: %v %s", err, format)
	}
	if !strings.Contains(res.Plan, "pictures at ≤") || res.Grade == "" {
		t.Errorf("plan %q grade %q", res.Plan, res.Grade)
	}
}

func TestRunOfficeCantFit(t *testing.T) {
	src := filepath.Join(t.TempDir(), "report.docx")
	buildDocx(t, src)
	job, _ := fileJob(t, nil)
	_, err := runOffice(context.Background(), job, fileInput(t, src, 1000, DefaultOptions()))
	if ae := core.AsAppError(err); ae == nil || !strings.Contains(ae.Message, "Couldn't get it under") {
		t.Errorf("err = %v", err)
	}
}

func TestEstimateOffice(t *testing.T) {
	src := filepath.Join(t.TempDir(), "report.docx")
	buildDocx(t, src)
	e := estimateOffice(context.Background(), nil, fileInput(t, src, 400_000, DefaultOptions()))
	if !e.Possible || e.Plan != "Shrinks 2 pictures" {
		t.Errorf("estimate = %+v", e)
	}
	e = estimateOffice(context.Background(), nil, fileInput(t, src, 100, DefaultOptions()))
	if e.Possible || e.Note != "The text and layout alone are over the limit" {
		t.Errorf("impossible estimate = %+v", e)
	}
	bad := filepath.Join(t.TempDir(), "bad.docx")
	_ = os.WriteFile(bad, []byte("nope"), 0o644)
	if e := estimateOffice(context.Background(), nil, fileInput(t, bad, 1, DefaultOptions())); e.Problem == "" {
		t.Errorf("expected a problem: %+v", e)
	}
}

func TestIsOfficePicture(t *testing.T) {
	for name, want := range map[string]bool{
		"word/media/image1.jpeg": true, "ppt/media/image2.PNG": true, "xl/media/a.jpg": true,
		"word/media/a.emf": false, "word/media/a.gif": false, "word/document.xml": false, "docProps/thumbnail.jpeg": false,
	} {
		if got := isOfficePicture(name); got != want {
			t.Errorf("isOfficePicture(%q) = %v", name, got)
		}
	}
}

// ---- other ----

func TestRunOther(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(src, []byte(strings.Repeat("hello compressible world\n", 40_000)), 0o644)
	in := fileInput(t, src, 100_000, DefaultOptions())
	job, _ := fileJob(t, nil)
	res, err := runOther(context.Background(), job, in)
	if err != nil {
		t.Fatal(err)
	}
	out := res.Outputs[0]
	if filepath.Base(out) != "notes.txt.zip" || res.Plan != "Zipped" || res.Grade != "" {
		t.Errorf("result %+v", res)
	}
	if n, _ := fileSize(out); n > in.Limit {
		t.Errorf("zip %d over the limit", n)
	}
	names, contents := readZip(t, out)
	orig, _ := os.ReadFile(src)
	if !slices.Equal(names, []string{"notes.txt"}) || !bytes.Equal(contents["notes.txt"], orig) {
		t.Error("zip content differs from the original")
	}
}

func TestRunOtherIncompressible(t *testing.T) {
	src := filepath.Join(t.TempDir(), "random.bin")
	b := make([]byte, 300_000)
	rand.New(rand.NewSource(4)).Read(b)
	_ = os.WriteFile(src, b, 0o644)
	job, _ := fileJob(t, nil)
	_, err := runOther(context.Background(), job, fileInput(t, src, 200_000, DefaultOptions()))
	ae := core.AsAppError(err)
	if ae == nil || ae.Hint != "This kind of file doesn't compress much. Try Local File Transfer to send it instead." {
		t.Errorf("err = %v", err)
	}
}

func TestEstimateOther(t *testing.T) {
	dir := t.TempDir()
	text := filepath.Join(dir, "big.log")
	_ = os.WriteFile(text, []byte(strings.Repeat("line of log text 12345\n", 600_000)), 0o644) // ~13 MB
	e := estimateOther(context.Background(), nil, fileInput(t, text, 2_000_000, DefaultOptions()))
	if !e.Possible || !strings.HasPrefix(e.Plan, "Zip (about ") || !strings.HasSuffix(e.Plan, "%)") {
		t.Errorf("text estimate = %+v", e)
	}
	rnd := filepath.Join(dir, "rand.bin")
	b := make([]byte, 1_000_000)
	rand.New(rand.NewSource(5)).Read(b)
	_ = os.WriteFile(rnd, b, 0o644)
	e = estimateOther(context.Background(), nil, fileInput(t, rnd, 500_000, DefaultOptions()))
	if e.Possible {
		t.Errorf("random data should not be possible: %+v", e)
	}
}

func TestPredictZip(t *testing.T) {
	if got := predictZip(1_000_000, 0.5); got != 500_200 {
		t.Errorf("predictZip = %d", got)
	}
	if r := zipRatio(nil); r != 1 {
		t.Errorf("empty ratio = %v", r)
	}
	if r := zipRatio(bytes.Repeat([]byte("a"), 10_000)); r > 0.05 {
		t.Errorf("repetitive ratio = %v", r)
	}
}
