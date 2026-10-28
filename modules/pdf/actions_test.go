package pdf

import (
	"context"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func TestMerge(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	a := writePDF(t, dir, "alpha.pdf", 6, 612, 792)
	b := writePDF(t, dir, "beta.pdf", 3, 612, 792)
	r, out, err := runJob(t, m, []string{a, b}, opts(ActionMerge))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "alpha (merged).pdf" {
		t.Fatalf("outputs = %v", r.outputs)
	}
	if got := mustInfo(t, m, r.outputs[0], "").Pages; got != 9 {
		t.Errorf("pages = %d, want 9", got)
	}
	res := r.res(t)
	if res.Pages != 9 || len(res.Outputs) != 1 || res.BytesAfter == 0 || res.BytesBefore == 0 {
		t.Errorf("result = %+v", res)
	}
	if names := listDir(t, out); len(names) != 1 {
		t.Errorf("output dir = %v", names)
	}
}

func TestSplitEvery(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 6, 612, 792)
	o := opts(ActionSplit)
	o.SplitMode, o.Every = SplitEvery, 4
	r, _, err := runJob(t, m, []string{src}, o)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range r.outputs {
		names = append(names, filepath.Base(p))
	}
	want := []string{"doc (pages 1-4).pdf", "doc (pages 5-6).pdf"}
	if strings.Join(names, "|") != strings.Join(want, "|") {
		t.Fatalf("names = %v, want %v", names, want)
	}
	if mustInfo(t, m, r.outputs[0], "").Pages != 4 || mustInfo(t, m, r.outputs[1], "").Pages != 2 {
		t.Error("page counts wrong")
	}

	o.Every = 1
	r, _, err = runJob(t, m, []string{src}, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 6 || filepath.Base(r.outputs[2]) != "doc (page 3).pdf" {
		t.Errorf("every=1 outputs = %v", r.outputs)
	}
}

func TestSplitRanges(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 6, 612, 792)
	o := opts(ActionSplit)
	o.SplitMode, o.Ranges = SplitRanges, "1-3, 5, 6-"
	r, _, err := runJob(t, m, []string{src}, o)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	var pages []int
	for _, p := range r.outputs {
		names = append(names, filepath.Base(p))
		pages = append(pages, mustInfo(t, m, p, "").Pages)
	}
	if strings.Join(names, "|") != "doc (pages 1-3).pdf|doc (page 5).pdf|doc (page 6).pdf" || pages[0] != 3 || pages[1] != 1 || pages[2] != 1 {
		t.Errorf("names = %v pages = %v", names, pages)
	}

	o.Ranges = "4-"
	r, _, err = runJob(t, m, []string{src}, o)
	if err != nil || len(r.outputs) != 1 || mustInfo(t, m, r.outputs[0], "").Pages != 3 {
		t.Errorf("open range: %v %v", r.outputs, err)
	}

	o.Ranges = "7"
	if _, _, err := runJob(t, m, []string{src}, o); !isCode(err, core.CodeValidation) {
		t.Errorf("out-of-range err = %v", err)
	}
}

func TestOrganize(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 6, 612, 792)
	o := opts(ActionOrganize)
	o.Pages = []PageEdit{{Page: 5, Rotate: 0}, {Page: 2, Rotate: 90}, {Page: 1, Rotate: 270}, {Page: 6, Rotate: 180}}
	r, _, err := runJob(t, m, []string{src}, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 1 || filepath.Base(r.outputs[0]) != "doc (edited).pdf" {
		t.Fatalf("outputs = %v", r.outputs)
	}
	in := mustInfo(t, m, r.outputs[0], "")
	if in.Pages != 4 {
		t.Fatalf("pages = %d", in.Pages)
	}
	// Page sizes are after rotation: 90 and 270 swap, 0 and 180 keep.
	want := []PageSize{{612, 792}, {792, 612}, {792, 612}, {612, 792}}
	for i, w := range want {
		if in.PageSizes[i] != w {
			t.Errorf("page %d size = %+v, want %+v", i+1, in.PageSizes[i], w)
		}
	}
	// Page order: the text of the first output page is source page 5.
	text := readAll(t, r.outputs[0])
	if i5, i2 := strings.Index(text, "doc page 5"), strings.Index(text, "doc page 2"); i5 < 0 || i2 < 0 || i5 > i2 {
		t.Errorf("page order wrong (page 5 at %d, page 2 at %d)", i5, i2)
	}

	o.Pages = []PageEdit{{Page: 9}}
	if _, _, err := runJob(t, m, []string{src}, o); !isCode(err, core.CodeValidation) {
		t.Errorf("missing page err = %v", err)
	}
}

func readAll(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestProtectUnlock(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 3, 612, 792)

	ref := m.state.sec.put("", "s3cret")
	o := opts(ActionProtect)
	o.PasswordRef = ref
	r, _, err := runJob(t, m, []string{src}, o)
	if err != nil {
		t.Fatal(err)
	}
	prot := r.outputs[0]
	if filepath.Base(prot) != "doc (protected).pdf" {
		t.Fatalf("name = %s", prot)
	}
	in := mustInfo(t, m, prot, "")
	if !in.Encrypted || !in.NeedsPassword {
		t.Errorf("info without password = %+v", in)
	}
	if _, err := m.info(context.Background(), prot, "wrong"); err == nil || core.AsAppError(err).Message != "Wrong password" || !isCode(err, core.CodeValidation) {
		t.Errorf("wrong password err = %v", err)
	}
	if in := mustInfo(t, m, prot, "s3cret"); in.Pages != 3 || !in.Encrypted || in.NeedsPassword || in.Restricted {
		t.Errorf("info with password = %+v", in)
	}

	// Unlock: wrong password fails, right one works.
	o = opts(ActionUnlock)
	o.PasswordRef = m.state.sec.put("nope", "")
	if _, _, err := runJob(t, m, []string{prot}, o); err == nil || core.AsAppError(err).Message != "Wrong password" {
		t.Errorf("unlock wrong err = %v", err)
	}
	o.PasswordRef = m.state.sec.put("s3cret", "")
	r, _, err = runJob(t, m, []string{prot}, o)
	if err != nil {
		t.Fatal(err)
	}
	un := mustInfo(t, m, r.outputs[0], "")
	if un.Encrypted || un.Pages != 3 {
		t.Errorf("unlocked info = %+v", un)
	}

	// Unlocking a plain file is an error.
	o.PasswordRef = m.state.sec.put("x", "")
	if _, _, err := runJob(t, m, []string{src}, o); !isCode(err, core.CodeValidation) {
		t.Errorf("unlock plain err = %v", err)
	}

	// Other actions need the password for encrypted inputs.
	if _, _, err := runJob(t, m, []string{prot}, opts(ActionCompress)); !isCode(err, core.CodeValidation) {
		t.Errorf("compress encrypted without password: %v", err)
	}
	o = opts(ActionSplit)
	o.Every = 1
	o.PasswordRef = m.state.sec.put("s3cret", "")
	if r, _, err := runJob(t, m, []string{prot}, o); err != nil || len(r.outputs) != 3 {
		t.Errorf("split encrypted: %v %v", r.outputs, err)
	}
}

func TestProtectAlreadyEncrypted(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 2, 612, 792)
	o := opts(ActionProtect)
	o.PasswordRef = m.state.sec.put("", "one")
	r, _, err := runJob(t, m, []string{src}, o)
	if err != nil {
		t.Fatal(err)
	}
	o.PasswordRef = m.state.sec.put("one", "two")
	r2, _, err := runJob(t, m, []string{r.outputs[0]}, o)
	if err != nil {
		t.Fatal(err)
	}
	if in := mustInfo(t, m, r2.outputs[0], "two"); in.Pages != 2 {
		t.Errorf("re-protected info = %+v", in)
	}
	if _, err := m.info(context.Background(), r2.outputs[0], "one"); err == nil {
		t.Error("old password still opens the file")
	}
}

func TestImagesToPDF(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	imgs := []string{
		gradientPNG(t, dir, "one.png", 800, 600),
		noisyJPEG(t, dir, "two.jpg", 600, 800, 80),
	}
	for _, tc := range []struct {
		size string
		w, h float64
	}{{PageA4, 595, 842}, {PageLetter, 612, 792}} {
		o := opts(ActionImagesToPDF)
		o.PageSize = tc.size
		r, _, err := runJob(t, m, imgs, o)
		if err != nil {
			t.Fatalf("%s: %v", tc.size, err)
		}
		if filepath.Base(r.outputs[0]) != "one.pdf" {
			t.Errorf("name = %s", r.outputs[0])
		}
		in := mustInfo(t, m, r.outputs[0], "")
		if in.Pages != 2 {
			t.Fatalf("%s pages = %d", tc.size, in.Pages)
		}
		for i, s := range in.PageSizes {
			if int(s.W+0.5) != int(tc.w) || int(s.H+0.5) != int(tc.h) {
				t.Errorf("%s page %d = %+v, want %vx%v", tc.size, i+1, s, tc.w, tc.h)
			}
		}
	}

	// Landscape-only inputs get a landscape page.
	o := opts(ActionImagesToPDF)
	r, _, err := runJob(t, m, imgs[:1], o)
	if err != nil {
		t.Fatal(err)
	}
	if s := mustInfo(t, m, r.outputs[0], "").PageSizes[0]; s.W < s.H {
		t.Errorf("landscape image page = %+v", s)
	}

	// Fit: page size follows the image (1 px = 72/150 pt).
	o.PageSize = PageFit
	r, _, err = runJob(t, m, imgs, o)
	if err != nil {
		t.Fatal(err)
	}
	in := mustInfo(t, m, r.outputs[0], "")
	if in.Pages != 2 || int(in.PageSizes[0].W+0.5) != 384 || int(in.PageSizes[0].H+0.5) != 288 || int(in.PageSizes[1].W+0.5) != 288 {
		t.Errorf("fit sizes = %+v", in.PageSizes)
	}

	// Margin none: the PDF still builds.
	o = opts(ActionImagesToPDF)
	o.Margin = MarginNone
	if _, _, err := runJob(t, m, imgs, o); err != nil {
		t.Errorf("margin none: %v", err)
	}
}

func TestImageFormats(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	// TIFF is encodable with x/image/tiff; WebP only decodable, so use a tiny fixture.
	tif := writeTIFF(t, dir, "scan.tif", 200, 100)
	for _, in := range []string{tif, writeWebP(t, dir)} {
		r, _, err := runJob(t, m, []string{in}, opts(ActionImagesToPDF))
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(in), err)
			continue
		}
		if mustInfo(t, m, r.outputs[0], "").Pages != 1 {
			t.Errorf("%s: wrong page count", filepath.Base(in))
		}
	}
}

func TestPDFToImages(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 4, 612, 792)
	o := opts(ActionPDFToImages)
	o.DPI = 72
	r, out, err := runJob(t, m, []string{src}, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.outputs) != 4 {
		t.Fatalf("outputs = %v", r.outputs)
	}
	res := r.res(t)
	if res.Pages != 4 || filepath.Base(res.Folder) != "doc (pages)" || filepath.Dir(res.Folder) != out {
		t.Errorf("result = %+v", res)
	}
	if filepath.Base(r.outputs[0]) != "page 001.png" {
		t.Errorf("name = %s", r.outputs[0])
	}
	assertSize(t, r.outputs[0], 612, 792)

	// 150 dpi JPG for a page range; rotated pages keep their orientation.
	o = opts(ActionPDFToImages)
	o.ImageFormat, o.PageRange, o.DPI = ImageJPG, "2-3", 150
	r, _, err = runJob(t, m, []string{src}, o)
	if err != nil || len(r.outputs) != 2 {
		t.Fatalf("jpg: %v %v", r.outputs, err)
	}
	if filepath.Base(r.outputs[0]) != "page 002.jpg" {
		t.Errorf("name = %s", r.outputs[0])
	}
	assertSize(t, r.outputs[0], 1275, 1650)

	o.PageRange = "9"
	if _, _, err := runJob(t, m, []string{src}, o); !isCode(err, core.CodeValidation) {
		t.Errorf("range err = %v", err)
	}
}

func assertSize(t *testing.T, path string, w, h int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	if abs(cfg.Width-w) > 1 || abs(cfg.Height-h) > 1 {
		t.Errorf("%s = %dx%d, want %dx%d", filepath.Base(path), cfg.Width, cfg.Height, w, h)
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func TestCancelledRunLeavesNothing(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	a := writePDF(t, dir, "a.pdf", 3, 612, 792)
	b := writePDF(t, dir, "b.pdf", 3, 612, 792)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r, out, err := runJobCtx(t, ctx, m, []string{a, b}, opts(ActionMerge))
	if err == nil || len(r.outputs) != 0 || len(listDir(t, out)) != 0 {
		t.Errorf("err = %v outputs = %v files = %v", err, r.outputs, listDir(t, out))
	}
}

func TestMissingSecretAfterRestart(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 2, 612, 792)
	o := opts(ActionUnlock)
	o.PasswordRef = "01JGONE0000000000000000000"
	_, _, err := runJob(t, m, []string{src}, o)
	if !isCode(err, core.CodeValidation) || !strings.Contains(core.AsAppError(err).Message, "isn't kept after a restart") {
		t.Errorf("err = %v", err)
	}
	if err := m.Validate([]string{src}, mustJSON(t, o)); !isCode(err, core.CodeValidation) {
		t.Errorf("Validate err = %v", err)
	}
}
