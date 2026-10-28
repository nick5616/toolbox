package pdf

import (
	"context"
	"fmt"
	"image"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestSamples runs every action over real PDFs. Opt in with
// TOOLBOX_PDF_SAMPLES=1 (TOOLBOX_PDF_SAMPLES_DIR overrides the folder).
func TestSamples(t *testing.T) {
	if os.Getenv("TOOLBOX_PDF_SAMPLES") != "1" {
		t.Skip("set TOOLBOX_PDF_SAMPLES=1 to run against the research PDFs")
	}
	dir := os.Getenv("TOOLBOX_PDF_SAMPLES_DIR")
	if dir == "" {
		dir = `C:\Users\nickb\repos\toolbox\.dev\p4-research\pdf\inputs`
	}
	in := func(name string) string {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err != nil {
			t.Skipf("missing sample %s", p)
		}
		return p
	}
	m := newTestModule(t)
	timed := func(name string, f func()) {
		s := time.Now()
		f()
		t.Logf("%-34s %8s", name, time.Since(s).Round(time.Millisecond))
	}

	for _, name := range []string{"arxiv.pdf", "irs_f1040.pdf", "irs_f1040_pub17.pdf", "scan_waq.pdf", "scan_byford.pdf", "scan_color.pdf", "scan_synth_30p.pdf"} {
		p := in(name)
		timed("info "+name, func() {
			i := mustInfo(t, m, p, "")
			t.Logf("   pages=%d bytes=%d bookmarks=%v restricted=%v title=%q", i.Pages, i.Bytes, i.HasBookmarks, i.Restricted, i.Title)
		})
	}

	// Encrypted sample.
	enc := in("encrypted_aes256_user123_owner456.pdf")
	ei := mustInfo(t, m, enc, "")
	t.Logf("encrypted: %+v", ei)
	for _, pw := range []string{"user123", "owner456"} {
		i, err := m.info(context.Background(), enc, pw)
		t.Logf("encrypted with %q: pages=%d restricted=%v err=%v", pw, i.Pages, i.Restricted, err)
	}
	if _, err := m.info(context.Background(), enc, "bad"); err == nil {
		t.Error("wrong password accepted")
	}
	o := opts(ActionUnlock)
	o.PasswordRef = m.state.sec.put("user123", "")
	timed("unlock encrypted", func() {
		r, _, err := runJob(t, m, []string{enc}, o)
		if err != nil {
			t.Errorf("unlock: %v", err)
			return
		}
		t.Logf("   -> %s %s", filepath.Base(r.outputs[0]), r.lastMessage())
	})
	o = opts(ActionCompress)
	o.PasswordRef = m.state.sec.put("user123", "")
	timed("compress encrypted (user pw: restricted)", func() {
		r, _, err := runJob(t, m, []string{enc}, o)
		t.Logf("   -> err=%v outputs=%v msg=%q", err, r.outputs, r.lastMessage())
		if err == nil {
			t.Error("restricted file edited with the user password")
		}
	})
	o.PasswordRef = m.state.sec.put("owner456", "")
	timed("compress encrypted (owner pw)", func() {
		r, _, err := runJob(t, m, []string{enc}, o)
		t.Logf("   -> err=%v outputs=%v msg=%q", err, r.outputs, r.lastMessage())
		if err != nil {
			t.Errorf("compress with owner password: %v", err)
		} else if len(r.outputs) == 1 {
			t.Logf("   output info: %+v", mustInfo(t, m, r.outputs[0], "owner456"))
		}
	})
	o = opts(ActionSplit)
	o.Every = 5
	o.PasswordRef = m.state.sec.put("owner456", "")
	timed("split encrypted (owner pw)", func() {
		r, _, err := runJob(t, m, []string{enc}, o)
		if err != nil || len(r.outputs) != 3 {
			t.Errorf("split encrypted: %v %v", r.outputs, err)
		}
	})

	// Merge (with bookmarks) and split / organize.
	arx, f1040, p17 := in("arxiv.pdf"), in("irs_f1040.pdf"), in("irs_f1040_pub17.pdf")
	timed("merge 3", func() {
		r, _, err := runJob(t, m, []string{arx, f1040, p17}, opts(ActionMerge))
		if err != nil {
			t.Errorf("merge: %v", err)
			return
		}
		res := r.res(t)
		t.Logf("   -> %d pages, %d bytes (%s)", res.Pages, res.BytesAfter, r.lastMessage())
		if got := mustInfo(t, m, r.outputs[0], "").Pages; got != res.Pages {
			t.Errorf("merged pages = %d, want %d", got, res.Pages)
		}
	})
	timed("split pub17 every 100", func() {
		o := opts(ActionSplit)
		o.Every = 100
		r, _, err := runJob(t, m, []string{p17}, o)
		t.Logf("   -> %d files err=%v msg=%q", len(r.outputs), err, r.lastMessage())
	})
	timed("split arxiv ranges 1-3,5,8-", func() {
		o := opts(ActionSplit)
		o.SplitMode, o.Ranges = SplitRanges, "1-3, 5, 8-"
		r, _, err := runJob(t, m, []string{arx}, o)
		t.Logf("   -> %d files err=%v msg=%q", len(r.outputs), err, r.lastMessage())
	})
	timed("organize pub17 (10 pages, rotated)", func() {
		o := opts(ActionOrganize)
		for i := 10; i >= 1; i-- {
			o.Pages = append(o.Pages, PageEdit{Page: i, Rotate: (i % 4) * 90})
		}
		r, _, err := runJob(t, m, []string{p17}, o)
		if err != nil {
			t.Errorf("organize: %v", err)
			return
		}
		t.Logf("   -> %v msg=%q", mustInfo(t, m, r.outputs[0], "").PageSizes[:3], r.lastMessage())
	})

	// Protect / unlock round trip.
	timed("protect + unlock arxiv", func() {
		o := opts(ActionProtect)
		o.PasswordRef = m.state.sec.put("", "pw!")
		r, _, err := runJob(t, m, []string{arx}, o)
		if err != nil {
			t.Errorf("protect: %v", err)
			return
		}
		if !mustInfo(t, m, r.outputs[0], "").NeedsPassword {
			t.Error("protected file opens without password")
		}
		o = opts(ActionUnlock)
		o.PasswordRef = m.state.sec.put("pw!", "")
		if _, _, err := runJob(t, m, []string{r.outputs[0]}, o); err != nil {
			t.Errorf("unlock: %v", err)
		}
	})

	// Compress.
	for _, name := range []string{"scan_synth_30p.pdf", "scan_color.pdf", "scan_waq.pdf", "scan_byford.pdf", "irs_f1040_pub17.pdf", "arxiv.pdf"} {
		for _, lvl := range []string{LevelBalanced, LevelSmall, LevelHigh} {
			if lvl != LevelBalanced && name != "scan_synth_30p.pdf" && name != "scan_color.pdf" {
				continue
			}
			p := in(name)
			o := opts(ActionCompress)
			o.Level = lvl
			timed(fmt.Sprintf("compress %s %s", name, lvl), func() {
				r, _, err := runJob(t, m, []string{p}, o)
				if err != nil {
					t.Errorf("compress: %v", err)
					return
				}
				res := r.res(t)
				pct := 100 - 100*float64(res.BytesAfter)/float64(res.BytesBefore)
				t.Logf("   -> %d -> %d bytes (-%.0f%%), %d images, outputs=%d, %q", res.BytesBefore, res.BytesAfter, pct, res.ImagesRecompressed, len(r.outputs), r.lastMessage())
				if len(r.outputs) == 1 {
					compareFirstPage(t, m, p, r.outputs[0])
				}
			})
		}
	}

	// PDF -> images.
	timed("pdf->png arxiv 150dpi (15 pages)", func() {
		o := opts(ActionPDFToImages)
		r, _, err := runJob(t, m, []string{arx}, o)
		t.Logf("   -> %d files err=%v", len(r.outputs), err)
	})
	timed("pdf->jpg pub17 pages 1-30 @72", func() {
		o := opts(ActionPDFToImages)
		o.ImageFormat, o.DPI, o.PageRange = ImageJPG, 72, "1-30"
		r, _, err := runJob(t, m, []string{p17}, o)
		t.Logf("   -> %d files err=%v", len(r.outputs), err)
	})
	timed("pdf->png forms f1040 @300", func() {
		o := opts(ActionPDFToImages)
		o.DPI = 300
		r, _, err := runJob(t, m, []string{f1040}, o)
		t.Logf("   -> %d files err=%v", len(r.outputs), err)
	})

	// Images -> PDF from rendered pages (also checks the fit page really draws the image).
	timed("images->pdf (fit/a4)", func() {
		o := opts(ActionPDFToImages)
		o.DPI = 72
		o.PageRange = "1-3"
		r, _, err := runJob(t, m, []string{arx}, o)
		if err != nil {
			t.Errorf("render: %v", err)
			return
		}
		for _, size := range []string{PageA4, PageFit} {
			oo := opts(ActionImagesToPDF)
			oo.PageSize = size
			rr, _, err := runJob(t, m, r.outputs, oo)
			if err != nil {
				t.Errorf("images->pdf %s: %v", size, err)
				continue
			}
			t.Logf("   %s -> %v", size, mustInfo(t, m, rr.outputs[0], "").PageSizes)
			if mean := firstPageMean(t, m, rr.outputs[0]); mean > 250 || mean < 100 {
				t.Errorf("%s: first page mean = %.1f (blank or black?)", size, mean)
			}
		}
	})
}

// firstPageMean renders page 1 small and returns its mean grey level.
func firstPageMean(t *testing.T, m *Module, path string) float64 {
	t.Helper()
	var mean float64
	err := m.state.r.renderDPI(context.Background(), path, "", 0, 36, func(img image.Image, _ int) error {
		b := img.Bounds()
		var sum, n float64
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				r, g, bl, _ := img.At(x, y).RGBA()
				sum += float64(r+g+bl) / 3 / 257
				n++
			}
		}
		mean = sum / n
		return nil
	})
	if err != nil {
		t.Errorf("render %s: %v", filepath.Base(path), err)
	}
	return mean
}

// compareFirstPage renders page 1 of both files and logs the mean RGB difference.
func compareFirstPage(t *testing.T, m *Module, a, b string) {
	t.Helper()
	var imgs [2]image.Image
	for i, p := range []string{a, b} {
		err := m.state.r.renderDPI(context.Background(), p, "", 0, 50, func(img image.Image, _ int) error {
			cp := image.NewRGBA(img.Bounds())
			for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
				for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
					cp.Set(x, y, img.At(x, y))
				}
			}
			imgs[i] = cp
			return nil
		})
		if err != nil {
			t.Errorf("render %s: %v", filepath.Base(p), err)
			return
		}
	}
	bd := imgs[0].Bounds()
	if bd != imgs[1].Bounds() {
		t.Errorf("page size changed %v -> %v", bd, imgs[1].Bounds())
		return
	}
	var sum, n float64
	var ma, mb [3]float64
	for y := bd.Min.Y; y < bd.Max.Y; y++ {
		for x := bd.Min.X; x < bd.Max.X; x++ {
			r1, g1, b1, _ := imgs[0].At(x, y).RGBA()
			r2, g2, b2, _ := imgs[1].At(x, y).RGBA()
			for k, d := range [3][2]uint32{{r1, r2}, {g1, g2}, {b1, b2}} {
				sum += abs64(float64(d[0]) - float64(d[1]))
				ma[k] += float64(d[0]) / 257
				mb[k] += float64(d[1]) / 257
			}
			n += 3
		}
	}
	px := n / 3
	t.Logf("   page1 mean abs diff = %.2f/255, mean RGB before=%.0f,%.0f,%.0f after=%.0f,%.0f,%.0f",
		sum/n/257, ma[0]/px, ma[1]/px, ma[2]/px, mb[0]/px, mb[1]/px, mb[2]/px)
}

func abs64(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
