// Package pdfium is the shared go-pdfium WebAssembly renderer: a lazily
// started pool with no filesystem mounts (documents are opened from bytes),
// a wazero compilation cache directory and an idle shutdown. Phase 5 SPEC
// §3.2. It must not import Wails or modules/**.
package pdfium

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"io"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/references"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"

	"toolbox/core"
)

const (
	renderIdle      = 5 * time.Minute
	docCacheSize    = 2
	maxRenderPixels = 120_000_000 // sanity bound for one rendered page

	msgDamaged       = "This PDF is damaged and couldn't be read"
	msgWrongPassword = "Wrong password"
	msgNeedPassword  = "This PDF needs a password"
)

// Renderer is the lazily started pool. One instance is held while the pool is
// alive and used under mu.
type Renderer struct {
	cacheDir string

	mu     sync.Mutex
	pool   pdfium.Pool
	inst   pdfium.Pdfium
	docs   []docEntry // LRU, most recent last
	idle   *time.Timer
	closed bool
}

type docEntry struct {
	key string
	doc references.FPDF_DOCUMENT
}

// New returns a renderer whose WebAssembly compilation cache lives in
// cacheDir (empty disables the cache). Nothing starts until first use.
func New(cacheDir string) *Renderer { return &Renderer{cacheDir: cacheDir} }

// startLocked brings the pool up. Caller holds mu.
func (r *Renderer) startLocked() error {
	if r.closed {
		return errors.New("renderer is closed")
	}
	if r.inst != nil {
		return nil
	}
	rc := wazero.NewRuntimeConfig().WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling)
	if r.cacheDir != "" {
		if err := os.MkdirAll(r.cacheDir, 0o755); err == nil {
			if cc, err := wazero.NewCompilationCacheWithDir(r.cacheDir); err == nil {
				rc = rc.WithCompilationCache(cc)
			}
		}
	}
	pool, err := webassembly.Init(webassembly.Config{
		MinIdle: 0, MaxIdle: 1, MaxTotal: 2,
		FSConfig:      wazero.NewFSConfig(), // no mounts: the default would expose the host root
		RuntimeConfig: rc,
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err != nil {
		return fmt.Errorf("start pdfium: %w", err)
	}
	inst, err := pool.GetInstance(time.Minute)
	if err != nil {
		_ = pool.Close()
		return fmt.Errorf("get pdfium instance: %w", err)
	}
	r.pool, r.inst = pool, inst
	return nil
}

// stopLocked closes documents and the pool. Caller holds mu.
func (r *Renderer) stopLocked() {
	if r.inst == nil {
		return
	}
	for _, d := range r.docs {
		_, _ = r.inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: d.doc})
	}
	r.docs = nil
	_ = r.inst.Close()
	_ = r.pool.Close()
	r.inst, r.pool = nil, nil
}

// Close stops the pool; the renderer can't be used afterwards.
func (r *Renderer) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	if r.idle != nil {
		r.idle.Stop()
	}
	r.stopLocked()
}

func (r *Renderer) touchLocked() {
	if r.idle != nil {
		r.idle.Stop()
	}
	r.idle = time.AfterFunc(renderIdle, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.stopLocked()
	})
}

func docKey(doc []byte, password string) string {
	h := sha256.New()
	h.Write(doc)
	h.Write([]byte{0})
	h.Write([]byte(password))
	return fmt.Sprintf("%x", h.Sum(nil))
}

// with opens (or reuses) the document and runs fn with exclusive access to
// the instance.
func (r *Renderer) with(ctx context.Context, doc []byte, password string, fn func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT) error) error {
	key := docKey(doc, password)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := r.startLocked(); err != nil {
		return err
	}
	defer r.touchLocked()

	var d references.FPDF_DOCUMENT
	found := false
	for i, e := range r.docs {
		if e.key == key {
			d, found = e.doc, true
			r.docs = append(append(r.docs[:i:i], r.docs[i+1:]...), e)
			break
		}
	}
	if !found {
		req := &requests.OpenDocument{File: &doc}
		if password != "" {
			req.Password = &password
		}
		res, err := r.inst.OpenDocument(req)
		if err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "password") {
				if password == "" {
					return core.ValidationError(msgNeedPassword, nil).WithCause(err)
				}
				return core.ValidationError(msgWrongPassword, nil).WithCause(err)
			}
			return core.ValidationError(msgDamaged, nil).WithCause(err)
		}
		d = res.Document
		r.docs = append(r.docs, docEntry{key: key, doc: d})
		for len(r.docs) > docCacheSize {
			_, _ = r.inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: r.docs[0].doc})
			r.docs = r.docs[1:]
		}
	}
	return fn(r.inst, d)
}

func pageCount(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT) (int, error) {
	pc, err := inst.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc})
	if err != nil {
		return 0, fmt.Errorf("page count: %w", err)
	}
	return pc.PageCount, nil
}

// pageSize returns the page's size in points (after rotation).
func pageSize(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT, index int) (w, h float64, err error) {
	res, err := inst.FPDF_GetPageSizeByIndexF(&requests.FPDF_GetPageSizeByIndexF{Document: doc, Index: index})
	if err != nil {
		return 0, 0, fmt.Errorf("page %d size: %w", index+1, err)
	}
	return float64(res.Size.Width), float64(res.Size.Height), nil
}

// copyImage detaches a rendered image from the WebAssembly pixel buffer,
// which is only valid until Cleanup.
func copyImage(src image.Image) image.Image {
	b := src.Bounds()
	dst := image.NewRGBA(b)
	draw.Draw(dst, b, src, b.Min, draw.Src)
	return dst
}

// PageCount returns the number of pages.
func (r *Renderer) PageCount(ctx context.Context, doc []byte, password string) (int, error) {
	var n int
	err := r.with(ctx, doc, password, func(inst pdfium.Pdfium, d references.FPDF_DOCUMENT) (err error) {
		n, err = pageCount(inst, d)
		return err
	})
	return n, err
}

// Render renders one page (1-based) at dpi.
func (r *Renderer) Render(ctx context.Context, doc []byte, password string, page int, dpi int) (image.Image, error) {
	if page < 1 {
		return nil, core.ValidationError("Page numbers start at 1", nil)
	}
	index := page - 1
	var out image.Image
	err := r.with(ctx, doc, password, func(inst pdfium.Pdfium, d references.FPDF_DOCUMENT) error {
		pc, err := pageCount(inst, d)
		if err != nil {
			return err
		}
		if index >= pc {
			return core.ValidationError(fmt.Sprintf("Page %d doesn't exist", page), nil)
		}
		w, h, err := pageSize(inst, d, index)
		if err != nil {
			return err
		}
		if px := w * h / 5184 * float64(dpi) * float64(dpi); px > maxRenderPixels {
			return core.ValidationError(fmt.Sprintf("Page %d is too large to render at %d dpi", page, dpi), nil)
		}
		res, err := inst.RenderPageInDPI(&requests.RenderPageInDPI{
			DPI:  dpi,
			Page: requests.Page{ByIndex: &requests.PageByIndex{Document: d, Index: index}},
		})
		if err != nil {
			return fmt.Errorf("render page %d: %w", page, err)
		}
		defer res.Cleanup()
		out = copyImage(res.Result.Image)
		return nil
	})
	return out, err
}

// RenderWidth renders one page (1-based) scaled to the given pixel width
// (used for thumbnails). Not part of the SPEC §3.2 minimum.
func (r *Renderer) RenderWidth(ctx context.Context, doc []byte, password string, page, width int) (image.Image, error) {
	if page < 1 {
		return nil, core.ValidationError("Page numbers start at 1", nil)
	}
	var out image.Image
	err := r.with(ctx, doc, password, func(inst pdfium.Pdfium, d references.FPDF_DOCUMENT) error {
		pc, err := pageCount(inst, d)
		if err != nil {
			return err
		}
		if page > pc {
			return core.ValidationError(fmt.Sprintf("Page %d doesn't exist (the document has %d)", page, pc), nil)
		}
		w, h, err := pageSize(inst, d, page-1)
		if err != nil {
			return err
		}
		if w <= 0 || h <= 0 {
			return core.ValidationError(msgDamaged, nil)
		}
		height := max(1, int(math.Round(float64(width)*h/w)))
		res, err := inst.RenderPageInPixels(&requests.RenderPageInPixels{
			Width: width, Height: height,
			Page: requests.Page{ByIndex: &requests.PageByIndex{Document: d, Index: page - 1}},
		})
		if err != nil {
			return fmt.Errorf("render page %d: %w", page, err)
		}
		defer res.Cleanup()
		out = copyImage(res.Result.Image)
		return nil
	})
	return out, err
}

// PageText returns the text already on the page (1-based); empty for a
// scanned page.
func (r *Renderer) PageText(ctx context.Context, doc []byte, password string, page int) (string, error) {
	if page < 1 {
		return "", core.ValidationError("Page numbers start at 1", nil)
	}
	var text string
	err := r.with(ctx, doc, password, func(inst pdfium.Pdfium, d references.FPDF_DOCUMENT) error {
		pc, err := pageCount(inst, d)
		if err != nil {
			return err
		}
		if page > pc {
			return core.ValidationError(fmt.Sprintf("Page %d doesn't exist", page), nil)
		}
		res, err := inst.GetPageText(&requests.GetPageText{
			Page: requests.Page{ByIndex: &requests.PageByIndex{Document: d, Index: page - 1}},
		})
		if err != nil {
			return fmt.Errorf("page %d text: %w", page, err)
		}
		text = res.Text
		return nil
	})
	return text, err
}
