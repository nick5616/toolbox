package pdfium

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/klippa-app/go-pdfium/requests"

	"toolbox/core"
)

var (
	cacheOnce sync.Once
	cacheDir  string
)

func TestMain(m *testing.M) {
	code := m.Run()
	if cacheDir != "" {
		_ = os.RemoveAll(cacheDir)
	}
	os.Exit(code)
}

// newTestRenderer shares one wazero cache dir so only one test pays the
// compile cost.
func newTestRenderer(t *testing.T) *Renderer {
	t.Helper()
	cacheOnce.Do(func() { cacheDir, _ = os.MkdirTemp("", "toolbox-pdfium-cache-") })
	r := New(cacheDir)
	t.Cleanup(r.Close)
	return r
}

// makePDF builds an n-page PDF; page i carries the text "<text> page i"
// (pass an empty text for blank pages).
func makePDF(n, w, h int, text string) []byte {
	var buf bytes.Buffer
	var offsets []int
	obj := func(body string) {
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}
	buf.WriteString("%PDF-1.4\n")
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	var kids []string
	for i := range n {
		kids = append(kids, fmt.Sprintf("%d 0 R", 4+2*i))
	}
	obj(fmt.Sprintf("<< /Type /Pages /Count %d /Kids [%s] >>", n, strings.Join(kids, " ")))
	obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
	for i := range n {
		obj(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents %d 0 R /Resources << /Font << /F1 3 0 R >> >> >>", w, h, 5+2*i))
		content := ""
		if text != "" {
			content = fmt.Sprintf("BT /F1 24 Tf 72 %d Td (%s page %d) Tj ET", h-100, text, i+1)
		}
		obj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
	}
	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, o := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xref)
	return buf.Bytes()
}

func TestPageCountAndRender(t *testing.T) {
	r := newTestRenderer(t)
	ctx := context.Background()
	doc := makePDF(3, 612, 792, "hello")
	n, err := r.PageCount(ctx, doc, "")
	if err != nil || n != 3 {
		t.Fatalf("PageCount = %d, %v", n, err)
	}
	img, err := r.Render(ctx, doc, "", 2, 72)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 612 || b.Dy() != 792 {
		t.Errorf("render at 72 dpi = %dx%d, want 612x792", b.Dx(), b.Dy())
	}
	// The image must stay valid after later calls reuse the instance.
	if _, err := r.Render(ctx, doc, "", 1, 144); err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := img.At(10, 10).RGBA(); a == 0 {
		t.Error("image was released")
	}
	for _, page := range []int{0, 4} {
		if _, err := r.Render(ctx, doc, "", page, 72); !isValidation(err) {
			t.Errorf("Render(page %d) err = %v", page, err)
		}
	}
	if _, err := r.Render(ctx, doc, "", 1, 4000); !isValidation(err) {
		t.Errorf("oversized render err = %v", err)
	}
	w, err := r.RenderWidth(ctx, doc, "", 1, 200)
	if err != nil {
		t.Fatal(err)
	}
	if b := w.Bounds(); b.Dx() != 200 || b.Dy() != 259 {
		t.Errorf("RenderWidth = %dx%d, want 200x259", b.Dx(), b.Dy())
	}
}

func TestPageText(t *testing.T) {
	r := newTestRenderer(t)
	ctx := context.Background()
	doc := makePDF(2, 612, 792, "Invoice")
	for page, want := range map[int]string{1: "Invoice page 1", 2: "Invoice page 2"} {
		got, err := r.PageText(ctx, doc, "", page)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(got, want) {
			t.Errorf("PageText(%d) = %q, want it to contain %q", page, got, want)
		}
	}
	blank, err := r.PageText(ctx, makePDF(1, 612, 792, ""), "", 1)
	if err != nil || strings.TrimSpace(blank) != "" {
		t.Errorf("blank page text = %q, %v", blank, err)
	}
	if _, err := r.PageText(ctx, doc, "", 3); !isValidation(err) {
		t.Errorf("PageText(3) err = %v", err)
	}
}

func TestDamagedAndCancelled(t *testing.T) {
	r := newTestRenderer(t)
	if _, err := r.PageCount(context.Background(), []byte("not a pdf"), ""); !isValidation(err) {
		t.Errorf("damaged err = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.PageCount(ctx, makePDF(1, 612, 792, ""), ""); err == nil {
		t.Error("cancelled context: want error")
	}
}

func TestCloseIsFinal(t *testing.T) {
	r := New("")
	doc := makePDF(1, 612, 792, "x")
	if _, err := r.PageCount(context.Background(), doc, ""); err != nil {
		t.Fatal(err)
	}
	r.Close()
	if _, err := r.PageCount(context.Background(), doc, ""); err == nil {
		t.Error("use after Close: want error")
	}
}

// pdfium runs with an empty wazero FS config: a file path can't be opened
// through it, while the same document opens from bytes.
func TestPdfiumHasNoFilesystem(t *testing.T) {
	r := newTestRenderer(t)
	dir := t.TempDir()
	src := dir + string(os.PathSeparator) + "doc.pdf"
	b := makePDF(1, 612, 792, "x")
	if err := os.WriteFile(src, b, 0o644); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.startLocked(); err != nil {
		t.Fatal(err)
	}
	res, err := r.inst.OpenDocument(&requests.OpenDocument{File: &b})
	if err != nil {
		t.Fatalf("open from bytes: %v", err)
	}
	_, _ = r.inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: res.Document})
	if res, err := r.inst.OpenDocument(&requests.OpenDocument{FilePath: &src}); err == nil {
		_, _ = r.inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: res.Document})
		t.Fatal("pdfium opened a host file path: the filesystem is mounted")
	}
}

func isValidation(err error) bool {
	if err == nil {
		return false
	}
	ae := core.AsAppError(err)
	return ae != nil && ae.Code == core.CodeValidation
}
