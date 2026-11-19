package mediaindex

import (
	"context"
	"fmt"
	"image"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"toolbox/core"
	"toolbox/core/doctext"
)

const probeDPI = 36

func nonSpaceRunes(s string) int {
	n := 0
	for _, r := range s {
		if !unicode.IsSpace(r) {
			n++
		}
	}
	return n
}

func isPasswordError(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "password")
}

// renderFit renders a page so that its short (byShort) or long side is about
// target px: a small probe render gives the page's size, a second one
// (when the probe is too small) reaches the target; the result is then
// fitted exactly and never upscaled.
func (e *env) renderFit(ctx context.Context, doc []byte, page, target int, byShort bool) (image.Image, error) {
	img, err := e.d.PDF.Render(ctx, doc, "", page, probeDPI)
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	dim := b.Dx()
	if byShort {
		dim = min(b.Dx(), b.Dy())
	} else {
		dim = max(b.Dx(), b.Dy())
	}
	if dim < target && dim > 0 {
		dpi := min(300, max(probeDPI+1, probeDPI*target/dim))
		if img, err = e.d.PDF.Render(ctx, doc, "", page, dpi); err != nil {
			return nil, err
		}
	}
	if byShort {
		return fitShort(img, target), nil
	}
	return fitLong(img, target), nil
}

// prepPDF reads a PDF's text layer (every page, ≤ 500), renders pages 1–4 to
// embed and, when reading text, renders pages without a text layer (≤ 50) for
// OCR. pic.pos is the 0-based page index.
func (e *env) prepPDF(ctx context.Context, p *prepared, n int, path string) error {
	if e.d.PDF == nil {
		return core.Errorf(core.CodeInternal, "PDF reading isn't available")
	}
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	if fi.Size() > maxPDFBytes {
		return core.ValidationError("Too large to read (over 200 MB)", nil)
	}
	doc, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	pages, err := e.d.PDF.PageCount(ctx, doc, "")
	if err != nil {
		if isPasswordError(err) {
			return skipError("password protected")
		}
		return err
	}
	if pages < 1 {
		return core.ValidationError("This PDF has no pages", nil)
	}

	// Text layer.
	var noText []int
	total := 0
	for pg := 0; pg < min(pages, maxPDFTextPgs); pg++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		txt, err := e.d.PDF.PageText(ctx, doc, "", pg+1)
		if err != nil {
			if isPasswordError(err) {
				return skipError("password protected")
			}
			txt = ""
		}
		if nonSpaceRunes(txt) < minPageChars {
			noText = append(noText, pg)
		}
		if total >= doctext.DefaultLimit {
			continue
		}
		for _, part := range doctext.SplitText(txt) {
			p.res.Texts = append(p.res.Texts, core.MediaText{Source: core.TextSourcePDF, Pos: int64(pg), EndPos: -1, Text: part})
			total += len(part)
		}
	}

	// Pictures: pages 1–4 to embed.
	byPage := map[int]*pic{}
	for pg := 0; pg < min(pages, maxPDFPicPgs); pg++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		img, err := e.renderFit(ctx, doc, pg+1, embedShort, true)
		if err != nil {
			if isPasswordError(err) {
				return skipError("password protected")
			}
			e.job.Logf("%s: page %d: %v", path, pg+1, err)
			continue
		}
		pc := &pic{pos: int64(pg), small: pathIn(e.dir, "%d-p%d-224.jpg", n, pg)}
		if err := writeJPEG(pc.small, img); err != nil {
			return err
		}
		byPage[pg] = pc
		p.pics = append(p.pics, pc)
	}

	// Pages without text for OCR.
	if e.readText {
		for i, pg := range noText {
			if i >= maxPDFOCRPgs {
				break
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			img, err := e.renderFit(ctx, doc, pg+1, ocrLong, false)
			if err != nil {
				e.job.Logf("%s: page %d: %v", path, pg+1, err)
				continue
			}
			ocrPath := pathIn(e.dir, "%d-p%d-ocr.jpg", n, pg)
			if err := writeJPEG(ocrPath, img); err != nil {
				return err
			}
			pc := byPage[pg]
			if pc == nil {
				pc = &pic{pos: int64(pg)}
				p.pics = append(p.pics, pc)
			}
			pc.ocr, pc.force = ocrPath, true
		}
	}
	return nil
}

func pathIn(dir, format string, args ...any) string {
	return filepath.Join(dir, fmt.Sprintf(format, args...))
}

// prepDoc extracts a document's text (no pictures, no engine).
func prepDoc(p *prepared, path string) error {
	chunks, err := doctext.Extract(path, doctext.DefaultLimit)
	if err != nil {
		return err
	}
	if doctext.IsSubtitle(path) {
		p.res.Texts = mergeCues(chunks, core.TextSourceDoc)
		return nil
	}
	for _, c := range chunks {
		p.res.Texts = append(p.res.Texts, core.MediaText{Source: core.TextSourceDoc, Pos: c.Pos, EndPos: c.EndPos, Text: c.Text})
	}
	return nil
}
