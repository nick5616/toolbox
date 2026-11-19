package mediaindex

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/imaging"
	"toolbox/core/media"
	ix "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
)

func TestFP16(t *testing.T) {
	for _, c := range []struct {
		bits uint16
		want float32
	}{{0x3C00, 1}, {0xC000, -2}, {0x3800, 0.5}, {0x0000, 0}, {0x0001, 5.9604645e-08}, {0x7BFF, 65504}} {
		if got := fp16ToFloat32(c.bits); got != c.want {
			t.Errorf("fp16ToFloat32(%#x) = %v, want %v", c.bits, got, c.want)
		}
	}
	if !math.IsInf(float64(fp16ToFloat32(0x7C00)), 1) {
		t.Error("0x7C00 should be +Inf")
	}
	for _, f := range []float32{0, 1, -1, 0.333, 0.0123, -0.7071, 123.5} {
		back := fp16ToFloat32(float32ToFP16(f))
		if d := float64(back - f); d > 1e-3*math.Abs(float64(f))+1e-6 || d < -1e-3*math.Abs(float64(f))-1e-6 {
			t.Errorf("round trip %v -> %v", f, back)
		}
	}
	v, err := decodeVector(encodeVec([]float32{1, 0.5, -1, 0}), 4)
	if err != nil || len(v) != 4 || v[1] != 0.5 || v[2] != -1 {
		t.Errorf("decodeVector = %v, %v", v, err)
	}
	if v, err := decodeVector("", 4); v != nil || err != nil {
		t.Errorf("empty = %v, %v", v, err)
	}
	if _, err := decodeVector(encodeVec([]float32{1, 2}), 4); err == nil {
		t.Error("wrong length should fail")
	}
}

func TestVideoSchedule(t *testing.T) {
	for _, c := range []struct {
		dur         int64
		start, step int64
		count       int
	}{
		{60_000, 1875, 3750, 16},
		{10_000, 1000, 2000, 5},
		{3_000, 1000, 2000, 1},
		{500, 250, 2000, 1},
		{3_600_000, 112_500, 225_000, 16},
		{0, 0, 2000, 1},
	} {
		s := videoSchedule(c.dur)
		if s.StartMs != c.start || s.StepMs != c.step || s.Count != c.count {
			t.Errorf("videoSchedule(%d) = %+v, want start %d step %d count %d", c.dur, s, c.start, c.step, c.count)
		}
		for _, ms := range s.Times() {
			if c.dur > 0 && (ms < 0 || ms > c.dur) {
				t.Errorf("videoSchedule(%d): time %d outside the video", c.dur, ms)
			}
		}
	}
	if got := videoSchedule(10_000).Times(); fmt.Sprint(got) != "[1000 3000 5000 7000 9000]" {
		t.Errorf("times = %v", got)
	}
	if s := middleSchedule(9000); s.StartMs != 0 || s.StepMs != 4500 || s.Count != 2 {
		t.Errorf("middle = %+v", s)
	}
}

func TestDedupeHashes(t *testing.T) {
	h := func(bits uint64) imaging.DHash { return imaging.DHash{Bits: bits} }
	// 0 and 1 differ by 1 bit (dropped); 2 differs by 8 from 0 (kept); 3 is
	// within 6 of 2 (dropped); 4 is far (kept); 5 equals 0 but the last kept is 4 (kept).
	got := dedupeHashes([]imaging.DHash{h(0), h(1), h(0xFF), h(0xFF ^ 0b11), h(0xFFFF_0000_0000_FF00), h(0)}, 6)
	if fmt.Sprint(got) != "[0 2 4 5]" {
		t.Errorf("kept = %v", got)
	}
	if got := dedupeHashes(nil, 6); len(got) != 0 {
		t.Errorf("empty = %v", got)
	}
}

func TestPrepareOrientsAndSizes(t *testing.T) {
	dir := t.TempDir()
	plain := writeJPEGFile(t, dir, "plain.jpg", halves(900, 300))
	raw, _ := os.ReadFile(plain)
	rotated := filepath.Join(dir, "rotated.jpg")
	if err := os.WriteFile(rotated, withExifOrientation(raw, 6), 0o644); err != nil {
		t.Fatal(err)
	}
	if imaging.Orientation(rotated) != 6 {
		t.Fatal("test fixture: orientation not readable")
	}

	var sizes []image.Point
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, &sizes, nil)}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	job := newJob(t, []string{plain, rotated}, ix.BatchOptions{ReadText: true}, nil)
	if err := im.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(w.batches) != 1 || len(w.batches[0]) != 2 {
		t.Fatalf("batches = %+v", w.batches)
	}
	res := w.batches[0]
	if res[0].Path != plain || res[1].Path != rotated {
		t.Errorf("order: %s, %s", res[0].Path, res[1].Path)
	}
	for _, r := range res {
		if r.Failed != "" || r.Kind != core.MediaKindImage || len(r.Vectors) != 1 || r.Vectors[0].Pos != -1 || r.Size == 0 || r.ModMs == 0 {
			t.Errorf("result = %+v", r)
		}
		if len(r.Vectors[0].Vec) != testDim {
			t.Errorf("vec len %d", len(r.Vectors[0].Vec))
		}
	}
	// Sizes: plain 900×300 → short side 224 → 672×224; rotated is upright 300×900 → 224×672.
	got := map[image.Point]bool{}
	for _, s := range sizes {
		got[s] = true
	}
	if !got[image.Pt(672, 224)] || !got[image.Pt(224, 672)] {
		t.Errorf("embedded sizes = %v", sizes)
	}
	// The OCR copy keeps the oriented size (≤ 1600): upright 300×900 for the rotated file.
	ocr := filepath.Join(job.TempDir, "1-a-ocr.jpg")
	img, err := readImage(ocr)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 300 || b.Dy() != 900 {
		t.Errorf("ocr copy = %v", b)
	}
	// Red left half rotates clockwise to the top.
	r, _, bl, _ := img.At(150, 100).RGBA()
	r2, _, b2, _ := img.At(150, 800).RGBA()
	if r < 0xC000 || bl > 0x4000 || b2 < 0xC000 || r2 > 0x4000 {
		t.Errorf("orientation not applied: top=(r %x b %x) bottom=(r %x b %x)", r, bl, r2, b2)
	}
}

func TestPrepareBigImageIsReduced(t *testing.T) {
	dir := t.TempDir()
	p := writeJPEGFile(t, dir, "big.jpg", halves(3000, 2000))
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, nil, nil)}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	job := newJob(t, []string{p}, ix.BatchOptions{ReadText: true}, nil)
	if err := im.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	img, err := readImage(filepath.Join(job.TempDir, "0-a-ocr.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 1600 || b.Dy() != 1066 {
		t.Errorf("ocr copy = %v, want 1600×1066", b)
	}
	if len(c.named("ocr.image")) != 0 {
		t.Error("OCR must not run when the gate says no")
	}
}

type fakeHEIC struct{ png string }

func (f fakeHEIC) ToPNG(context.Context, string) (string, error) { return f.png, nil }
func (f fakeHEIC) Available() bool                               { return true }

func TestPrepareHEICThroughConverter(t *testing.T) {
	dir := t.TempDir()
	pngPath := filepath.Join(dir, "converted.png")
	f, _ := os.Create(pngPath)
	if err := png.Encode(f, halves(400, 300)); err != nil {
		t.Fatal(err)
	}
	f.Close()
	heic := filepath.Join(dir, "IMG_1.HEIC")
	if err := os.WriteFile(heic, []byte("not really heic"), 0o644); err != nil {
		t.Fatal(err)
	}
	imaging.SetHEICConverter(fakeHEIC{png: pngPath})
	defer imaging.SetHEICConverter(nil)

	var sizes []image.Point
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, &sizes, nil)}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	if err := im.Run(context.Background(), newJob(t, []string{heic}, ix.BatchOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	r := w.batches[0][0]
	if r.Failed != "" || len(r.Vectors) != 1 || r.Kind != core.MediaKindImage {
		t.Errorf("result = %+v", r)
	}
	if len(sizes) != 1 || sizes[0] != image.Pt(299, 224) && sizes[0] != image.Pt(298, 224) {
		t.Errorf("sizes = %v", sizes)
	}

	// Without a converter the file fails with a reason; the batch carries on.
	imaging.SetHEICConverter(nil)
	w2 := &fakeWriter{}
	im2, _ := newModules(w2, c, nil)
	if err := im2.Run(context.Background(), newJob(t, []string{heic}, ix.BatchOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if r := w2.batches[0][0]; r.Failed == "" {
		t.Errorf("HEIC without converter = %+v", r)
	}
}

func TestPrepareGIFFirstAndMiddleFrame(t *testing.T) {
	pal := color.Palette{color.White, color.Black, color.RGBA{R: 255, A: 255}}
	mk := func(c uint8) *image.Paletted {
		im := image.NewPaletted(image.Rect(0, 0, 64, 48), pal)
		for i := range im.Pix {
			im.Pix[i] = c
		}
		return im
	}
	g := &gif.GIF{Image: []*image.Paletted{mk(0), mk(1), mk(2), mk(0)}, Delay: []int{10, 20, 30, 5}}
	p := filepath.Join(t.TempDir(), "anim.gif")
	f, _ := os.Create(p)
	if err := gif.EncodeAll(f, g); err != nil {
		t.Fatal(err)
	}
	f.Close()

	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, nil, nil)}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	if err := im.Run(context.Background(), newJob(t, []string{p}, ix.BatchOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	r := w.batches[0][0]
	if len(r.Vectors) != 2 || r.Vectors[0].Pos != -1 || r.Vectors[1].Pos != 300 {
		t.Errorf("vectors = %+v", r.Vectors)
	}
	// A still GIF has one frame.
	still := filepath.Join(t.TempDir(), "still.gif")
	f, _ = os.Create(still)
	_ = gif.Encode(f, mk(1), nil)
	f.Close()
	w2 := &fakeWriter{}
	im2, _ := newModules(w2, c, nil)
	if err := im2.Run(context.Background(), newJob(t, []string{still}, ix.BatchOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if len(w2.batches[0][0].Vectors) != 1 {
		t.Errorf("still gif vectors = %+v", w2.batches[0][0].Vectors)
	}
}

// stripes returns a picture whose dHash differs strongly by kind.
func stripes(kind int) image.Image {
	img := image.NewNRGBA(image.Rect(0, 0, 360, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 360; x++ {
			var v uint8
			switch kind {
			case 0: // rising gradient
				v = uint8(x * 255 / 359)
			case 1: // falling gradient
				v = uint8(255 - x*255/359)
			default: // alternating columns of the dHash grid
				if (x/40)%2 == 0 {
					v = 40
				} else {
					v = 220
				}
			}
			img.SetNRGBA(x, y, color.NRGBA{v, v, v, 255})
		}
	}
	return img
}

func withVideoFakes(t *testing.T, dur int64, hasVideo bool, kinds []int) {
	t.Helper()
	oldProbe, oldExtract := probeMedia, extractVideoFrames
	t.Cleanup(func() { probeMedia, extractVideoFrames = oldProbe, oldExtract })
	probeMedia = func(_ context.Context, _, _ string) (media.Info, error) {
		info := media.Info{DurationMs: dur}
		if hasVideo {
			info.Video = &media.VideoStream{Width: 360, Height: 200}
		}
		return info, nil
	}
	extractVideoFrames = func(_ context.Context, _, _, dir string, s frameSchedule) ([]string, error) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		var files []string
		for i, k := range kinds {
			files = append(files, writeJPEGFile(t, dir, fmt.Sprintf("f%03d.jpg", i+1), stripes(k)))
		}
		return files, nil
	}
}

func TestPrepareVideoFramesDedupe(t *testing.T) {
	// Frames 0,1 alike; 2,3 alike; 4 different: keep 0, 2, 4.
	withVideoFakes(t, 20_000, true, []int{0, 0, 2, 2, 1})
	vid := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(vid, []byte("video"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, nil, nil)}}
	w := &fakeWriter{needsOCR: func(v []float32) bool { return true }}
	c.handlers["ocr.image"] = ocrHandler(t, map[string]string{"0-v0-ocr.jpg": "Slide one", "0-v2-ocr.jpg": "Slide one", "0-v4-ocr.jpg": "Other words"})
	im, _ := newModules(w, c, nil)
	job := newJob(t, []string{vid}, ix.BatchOptions{ReadText: true}, nil)
	if err := im.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	r := w.batches[0][0]
	if r.Kind != core.MediaKindVideo || r.Failed != "" {
		t.Fatalf("result = %+v", r)
	}
	s := videoSchedule(20_000)
	times := s.Times()
	var pos []int64
	for _, v := range r.Vectors {
		pos = append(pos, v.Pos)
	}
	if fmt.Sprint(pos) != fmt.Sprint([]int64{times[0], times[2], times[4]}) {
		t.Errorf("positions = %v, want frames 0,2,4 of %v", pos, times)
	}
	// Frame 2 reads the same words as frame 0: stored once. Frame 4 differs.
	if len(r.Texts) != 2 || r.Texts[0].Pos != times[0] || r.Texts[1].Pos != times[4] || r.Texts[0].Source != core.TextSourceOCR {
		t.Errorf("texts = %+v", r.Texts)
	}
}

func TestPrepareVideoWithoutVideoStreamAndWithoutFFmpeg(t *testing.T) {
	withVideoFakes(t, 20_000, false, nil)
	vid := filepath.Join(t.TempDir(), "podcast.mp4")
	_ = os.WriteFile(vid, []byte("v"), 0o644)
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	if err := im.Run(context.Background(), newJob(t, []string{vid}, ix.BatchOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	r := w.batches[0][0]
	if r.Failed != "" || r.Skipped != "" || len(r.Vectors) != 0 || r.Kind != core.MediaKindVideo {
		t.Errorf("no video stream = %+v", r)
	}
	if len(c.named("search.embed_images")) != 0 {
		t.Error("nothing to embed, so no engine call")
	}

	w2 := &fakeWriter{}
	im2, _ := newModules(w2, c, nil)
	if err := im2.Run(context.Background(), newJob(t, []string{vid}, ix.BatchOptions{}, map[string]bool{deps.FFmpeg: true})); err != nil {
		t.Fatal(err)
	}
	if r := w2.batches[0][0]; r.Skipped != "needs FFmpeg" {
		t.Errorf("no FFmpeg = %+v", r)
	}
}

// fakePDF is a Renderer over a fixed set of pages.
type fakePDF struct {
	pages     []string // text layer per page
	pwd       bool
	renderLog []string
}

func (f *fakePDF) PageCount(context.Context, []byte, string) (int, error) {
	if f.pwd {
		return 0, core.ValidationError("This PDF needs a password", nil)
	}
	return len(f.pages), nil
}

func (f *fakePDF) Render(_ context.Context, _ []byte, _ string, page, dpi int) (image.Image, error) {
	f.renderLog = append(f.renderLog, fmt.Sprintf("%d@%d", page, dpi))
	// US Letter at dpi.
	return image.NewNRGBA(image.Rect(0, 0, 85*dpi/10, 110*dpi/10)), nil
}

func (f *fakePDF) PageText(_ context.Context, _ []byte, _ string, page int) (string, error) {
	return f.pages[page-1], nil
}

func TestPreparePDFTextLayerAndOCRFallback(t *testing.T) {
	long := strings.Repeat("A real sentence on this page. ", 5)
	pdf := &fakePDF{pages: []string{long, "12", "", long, long, "", long}}
	p := filepath.Join(t.TempDir(), "doc.pdf")
	_ = os.WriteFile(p, []byte("%PDF-1.4 fake"), 0o644)

	var sizes []image.Point
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){
		"search.embed_images": embedHandler(t, &sizes, nil),
		"ocr.image":           ocrHandler(t, map[string]string{"0-p1-ocr.jpg": "page two words", "0-p2-ocr.jpg": "", "0-p5-ocr.jpg": "scan six"}),
	}}
	w := &fakeWriter{needsOCR: func([]float32) bool { return false }}
	im, _ := newModules(w, c, pdf)
	job := newJob(t, []string{p}, ix.BatchOptions{ReadText: true}, nil)
	if err := im.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	r := w.batches[0][0]
	if r.Kind != core.MediaKindPDF || r.Failed != "" || r.Skipped != "" {
		t.Fatalf("result = %+v", r)
	}
	// Pictures: pages 1–4 only, each 224 px on the short side.
	if len(r.Vectors) != 4 || len(sizes) != 4 {
		t.Fatalf("vectors = %d, sizes = %v", len(r.Vectors), sizes)
	}
	for i, v := range r.Vectors {
		if v.Pos != int64(i) {
			t.Errorf("vector %d pos = %d", i, v.Pos)
		}
	}
	for _, s := range sizes {
		if min(s.X, s.Y) != 224 {
			t.Errorf("page picture %v: short side not 224", s)
		}
	}
	// Text layer: every page's chunks, source pdf, Pos = page index; then OCR.
	var pdfPages []int64
	var ocr []core.MediaText
	for _, tx := range r.Texts {
		switch tx.Source {
		case core.TextSourcePDF:
			pdfPages = append(pdfPages, tx.Pos)
		case core.TextSourceOCR:
			ocr = append(ocr, tx)
		}
	}
	if fmt.Sprint(pdfPages) != "[0 1 3 4 6]" { // page 2 and 5 have no text at all
		t.Errorf("pdf text pages = %v", pdfPages)
	}
	// Pages 1 ("12": < 20 chars), 2 and 5 get OCR; page 2 reads nothing.
	if len(ocr) != 2 || ocr[0].Pos != 1 || ocr[0].Text != "page two words" || ocr[1].Pos != 5 || ocr[1].Text != "scan six" {
		t.Errorf("ocr = %+v", ocr)
	}
	if n := len(c.named("ocr.image")); n != 3 {
		t.Errorf("ocr calls = %d, want 3 (the pages without a text layer)", n)
	}
	// Without Read text, no page is rendered for OCR and the engine isn't asked.
	c2 := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, nil, nil)}}
	w2 := &fakeWriter{}
	im2, _ := newModules(w2, c2, &fakePDF{pages: pdf.pages})
	if err := im2.Run(context.Background(), newJob(t, []string{p}, ix.BatchOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if len(c2.named("ocr.image")) != 0 || len(w2.batches[0][0].Vectors) != 4 {
		t.Errorf("readText off: %+v", w2.batches[0][0])
	}
}

func TestPreparePDFEncryptedIsSkipped(t *testing.T) {
	p := filepath.Join(t.TempDir(), "locked.pdf")
	_ = os.WriteFile(p, []byte("%PDF"), 0o644)
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, &fakePDF{pwd: true})
	if err := im.Run(context.Background(), newJob(t, []string{p}, ix.BatchOptions{ReadText: true}, nil)); err != nil {
		t.Fatal(err)
	}
	if r := w.batches[0][0]; r.Skipped != "password protected" || r.Failed != "" {
		t.Errorf("result = %+v", r)
	}
}

func TestPrepareDocsAndAudio(t *testing.T) {
	dir := t.TempDir()
	txt := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(txt, []byte("Meeting notes about the budget\nSecond line"), 0o644)
	srt := filepath.Join(dir, "talk.srt")
	_ = os.WriteFile(srt, []byte("1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:02,000 --> 00:00:04,000\nthere\n"), 0o644)
	wav := filepath.Join(dir, "song.mp3")
	_ = os.WriteFile(wav, []byte("audio"), 0o644)
	weird := filepath.Join(dir, "thing.xyz")
	_ = os.WriteFile(weird, []byte("?"), 0o644)

	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	if err := im.Run(context.Background(), newJob(t, []string{txt, srt, wav, weird}, ix.BatchOptions{ReadText: true}, nil)); err != nil {
		t.Fatal(err)
	}
	res := w.batches[0]
	if res[0].Kind != core.MediaKindDoc || len(res[0].Texts) != 1 || res[0].Texts[0].Source != core.TextSourceDoc ||
		!strings.Contains(res[0].Texts[0].Text, "budget") || res[0].Texts[0].Pos != -1 {
		t.Errorf("txt = %+v", res[0])
	}
	if len(res[1].Texts) != 1 || res[1].Texts[0].Text != "Hello there" || res[1].Texts[0].Pos != 1000 || res[1].Texts[0].EndPos != 4000 {
		t.Errorf("srt = %+v", res[1].Texts)
	}
	if res[2].Kind != core.MediaKindAudio || res[2].Failed != "" || len(res[2].Texts) != 0 {
		t.Errorf("audio = %+v", res[2])
	}
	if res[3].Failed == "" {
		t.Errorf("unknown type = %+v", res[3])
	}
	if len(c.calls) != 0 {
		t.Errorf("docs and audio must not call the engine: %+v", c.calls)
	}
}

func TestOCRGate(t *testing.T) {
	dir := t.TempDir()
	a := writeJPEGFile(t, dir, "shot.jpg", halves(400, 300))   // vector [1 0 0 0]
	b := writeJPEGFile(t, dir, "forest.jpg", halves(400, 300)) // vector [1 1 0 0]
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){
		"search.embed_images": embedHandler(t, nil, nil),
		"ocr.image":           ocrHandler(t, map[string]string{"0-a-ocr.jpg": "Total due 42.00\nThank you"}),
	}}
	w := &fakeWriter{needsOCR: func(v []float32) bool { return v[1] == 0 }}
	im, _ := newModules(w, c, nil)
	job := newJob(t, []string{a, b}, ix.BatchOptions{ReadText: true}, nil)
	if err := im.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	calls := c.named("ocr.image")
	if len(calls) != 1 || !strings.HasSuffix(calls[0].params["input"].(string), "0-a-ocr.jpg") {
		t.Fatalf("ocr calls = %+v", calls)
	}
	p := calls[0].params
	if p["output"] != "text" || p["det"] != nil || p["rec"] != nil || !strings.HasPrefix(p["outputDir"].(string), job.TempDir) ||
		filepath.Base(p["modelDir"].(string)) != "ocr" {
		t.Errorf("ocr params = %+v", p)
	}
	r := w.batches[0]
	if len(r[0].Texts) != 1 || r[0].Texts[0].Source != core.TextSourceOCR || r[0].Texts[0].Pos != -1 || r[0].Texts[0].Text != "Total due 42.00\nThank you" {
		t.Errorf("texts = %+v", r[0].Texts)
	}
	if len(r[1].Texts) != 0 {
		t.Errorf("gated-out picture got text: %+v", r[1].Texts)
	}
	// Read text off: no OCR copies and no OCR calls whatever the gate says.
	c2 := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, nil, nil)}}
	w2 := &fakeWriter{needsOCR: func([]float32) bool { return true }}
	im2, _ := newModules(w2, c2, nil)
	job2 := newJob(t, []string{a}, ix.BatchOptions{}, nil)
	if err := im2.Run(context.Background(), job2); err != nil {
		t.Fatal(err)
	}
	if len(c2.named("ocr.image")) != 0 {
		t.Error("OCR ran with ReadText off")
	}
	if _, err := os.Stat(filepath.Join(job2.TempDir, "0-a-ocr.jpg")); err == nil {
		t.Error("OCR copy written with ReadText off")
	}
}

func TestOCRFailureDoesNotFailTheBatch(t *testing.T) {
	dir := t.TempDir()
	a := writeJPEGFile(t, dir, "a.jpg", halves(400, 300))
	b := writeJPEGFile(t, dir, "b.jpg", halves(400, 300))
	n := 0
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){
		"search.embed_images": embedHandler(t, nil, nil),
		"ocr.image": func(p map[string]any) (any, error) {
			n++
			if n == 1 {
				return nil, core.Errorf(core.CodeToolFailed, "engine hiccup")
			}
			return ocrHandler(t, map[string]string{"1-a-ocr.jpg": "second"})(p)
		},
	}}
	w := &fakeWriter{needsOCR: func([]float32) bool { return true }}
	im, _ := newModules(w, c, nil)
	if err := im.Run(context.Background(), newJob(t, []string{a, b}, ix.BatchOptions{ReadText: true}, nil)); err != nil {
		t.Fatal(err)
	}
	r := w.batches[0]
	if len(r[0].Texts) != 0 || len(r[1].Texts) != 1 || r[0].Failed != "" {
		t.Errorf("results = %+v", r)
	}
}

func TestPerFileFailureIsolation(t *testing.T) {
	dir := t.TempDir()
	good := writeJPEGFile(t, dir, "good.jpg", halves(400, 300))
	corrupt := filepath.Join(dir, "corrupt.jpg")
	_ = os.WriteFile(corrupt, []byte("this is not a jpeg"), 0o644)
	missing := filepath.Join(dir, "gone.png")
	unreadable := writeJPEGFile(t, dir, "unreadable-by-engine.jpg", halves(400, 300))

	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){
		// The engine reads good (picture 0) and fails the last one (picture 1).
		"search.embed_images": embedHandler(t, nil, map[int]bool{1: true}),
	}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	if err := im.Run(context.Background(), newJob(t, []string{good, corrupt, missing, unreadable}, ix.BatchOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	if len(w.batches) != 1 {
		t.Fatalf("StoreBatch called %d times", len(w.batches))
	}
	r := w.batches[0]
	if len(r) != 4 || r[0].Failed != "" || len(r[0].Vectors) != 1 {
		t.Fatalf("results = %+v", r)
	}
	for i, name := range map[int]string{1: "corrupt", 2: "missing", 3: "engine failure"} {
		if r[i].Failed == "" || strings.Contains(r[i].Failed, "\n") || len(r[i].Vectors) != 0 {
			t.Errorf("%s: %+v", name, r[i])
		}
	}
	if got := len(c.named("search.embed_images")); got != 1 {
		t.Errorf("embed calls = %d, want one for the whole batch", got)
	}
	if paths := c.named("search.embed_images")[0].params["paths"].([]any); len(paths) != 2 {
		t.Errorf("embedded %d pictures, want 2 (the two readable files)", len(paths))
	}
}

func TestIndexJobFailures(t *testing.T) {
	dir := t.TempDir()
	good := writeJPEGFile(t, dir, "a.jpg", halves(100, 100))
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, nil, nil)}}

	// Engine missing: the job fails before touching anything.
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	err := im.Run(context.Background(), newJob(t, []string{good}, ix.BatchOptions{}, map[string]bool{sidecar.DepID: true}))
	if !core.IsCode(err, core.CodeDependencyMissing) || len(w.batches) != 0 || len(c.calls) != 0 {
		t.Errorf("engine missing: err=%v batches=%d calls=%d", err, len(w.batches), len(c.calls))
	}

	// StoreBatch fails: the job fails.
	w2 := &fakeWriter{storeErr: errors.New("disk full")}
	im2, _ := newModules(w2, c, nil)
	if err := im2.Run(context.Background(), newJob(t, []string{good}, ix.BatchOptions{}, nil)); err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Errorf("store error = %v", err)
	}

	// The engine call fails: the job fails (the scheduler retries item by item).
	c3 := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){
		"search.embed_images": func(map[string]any) (any, error) { return nil, core.Errorf(core.CodeToolFailed, "engine crashed") },
	}}
	w3 := &fakeWriter{}
	im3, _ := newModules(w3, c3, nil)
	if err := im3.Run(context.Background(), newJob(t, []string{good}, ix.BatchOptions{}, nil)); err == nil || len(w3.batches) != 0 {
		t.Errorf("engine failure: err=%v batches=%d", err, len(w3.batches))
	}

	// Cancelled before work: ctx error, nothing stored.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w4 := &fakeWriter{}
	im4, _ := newModules(w4, c, nil)
	if err := im4.Run(ctx, newJob(t, []string{good}, ix.BatchOptions{}, nil)); err == nil || len(w4.batches) != 0 {
		t.Errorf("cancelled: err=%v batches=%d", err, len(w4.batches))
	}

	// Bad batch sizes and options are validation errors.
	if err := im.Validate(nil, nil); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("Validate empty = %v", err)
	}
	many := make([]string, ix.BatchMaxFiles+1)
	for i := range many {
		many[i] = good
	}
	if err := im.Run(context.Background(), newJob(t, many, ix.BatchOptions{}, nil)); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("33 files = %v", err)
	}
}

func TestEmbedParams(t *testing.T) {
	dir := t.TempDir()
	good := writeJPEGFile(t, dir, "a.jpg", halves(100, 100))
	c := &fakeCaller{handlers: map[string]func(map[string]any) (any, error){"search.embed_images": embedHandler(t, nil, nil)}}
	w := &fakeWriter{}
	im, _ := newModules(w, c, nil)
	if err := im.Run(context.Background(), newJob(t, []string{good}, ix.BatchOptions{}, nil)); err != nil {
		t.Fatal(err)
	}
	p := c.named("search.embed_images")[0].params
	if p["modelDir"] != "modeldir" || p["threads"].(float64) < 1 {
		t.Errorf("params = %+v", p)
	}
	// Nothing registered as a job output: the index writes no files for the user.
}
