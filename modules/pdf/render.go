package pdf

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
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
	thumbCacheSize  = 300
	minThumbWidth   = 80
	maxThumbWidth   = 1200
	thumbJPEGQ      = 80
	maxRenderPixels = 120_000_000 // sanity bound for one rendered page
)

// renderer is the lazily started go-pdfium WebAssembly pool (no filesystem
// mounts; documents are opened from bytes). One instance is held while the
// pool is alive and used under mu.
type renderer struct {
	cacheDir string

	mu     sync.Mutex
	pool   pdfium.Pool
	inst   pdfium.Pdfium
	docs   []docEntry // LRU, most recent last
	idle   *time.Timer
	closed bool

	thumbs *lru
}

type docEntry struct {
	key string
	doc references.FPDF_DOCUMENT
}

func newRenderer(cacheDir string) *renderer {
	return &renderer{cacheDir: cacheDir, thumbs: newLRU(thumbCacheSize)}
}

// startLocked brings the pool up. Caller holds mu.
func (r *renderer) startLocked() error {
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
func (r *renderer) stopLocked() {
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

func (r *renderer) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	if r.idle != nil {
		r.idle.Stop()
	}
	r.stopLocked()
}

func (r *renderer) touchLocked() {
	if r.idle != nil {
		r.idle.Stop()
	}
	r.idle = time.AfterFunc(renderIdle, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.stopLocked()
	})
}

func docKey(path string, fi os.FileInfo, password string) string {
	h := sha256.Sum256([]byte(password))
	return fmt.Sprintf("%s|%d|%d|%x", path, fi.ModTime().UnixNano(), fi.Size(), h[:8])
}

// with opens (or reuses) the document and runs fn with exclusive access to
// the instance.
func (r *renderer) with(ctx context.Context, path, password string, fn func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT, key string) error) error {
	fi, err := statPDF(path)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := r.startLocked(); err != nil {
		return err
	}
	defer r.touchLocked()

	key := docKey(path, fi, password)
	var doc references.FPDF_DOCUMENT
	found := false
	for i, d := range r.docs {
		if d.key == key {
			doc, found = d.doc, true
			r.docs = append(append(r.docs[:i:i], r.docs[i+1:]...), d)
			break
		}
	}
	if !found {
		b, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		req := &requests.OpenDocument{File: &b}
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
		doc = res.Document
		r.docs = append(r.docs, docEntry{key: key, doc: doc})
		for len(r.docs) > docCacheSize {
			_, _ = r.inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: r.docs[0].doc})
			r.docs = r.docs[1:]
		}
	}
	return fn(r.inst, doc, key)
}

// pageSize returns the page's size in points (after rotation).
func pageSize(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT, index int) (w, h float64, err error) {
	res, err := inst.FPDF_GetPageSizeByIndexF(&requests.FPDF_GetPageSizeByIndexF{Document: doc, Index: index})
	if err != nil {
		return 0, 0, fmt.Errorf("page %d size: %w", index+1, err)
	}
	return float64(res.Size.Width), float64(res.Size.Height), nil
}

// renderDPI renders one page (0-based) at dpi and passes the image to fn
// while the instance is locked.
func (r *renderer) renderDPI(ctx context.Context, path, password string, index, dpi int, fn func(img image.Image, pages int) error) error {
	return r.with(ctx, path, password, func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT, _ string) error {
		pc, err := inst.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc})
		if err != nil {
			return fmt.Errorf("page count: %w", err)
		}
		if index < 0 || index >= pc.PageCount {
			return core.ValidationError(fmt.Sprintf("Page %d doesn't exist", index+1), nil)
		}
		w, h, err := pageSize(inst, doc, index)
		if err != nil {
			return err
		}
		if px := w * h / 5184 * float64(dpi) * float64(dpi); px > maxRenderPixels {
			return core.ValidationError(fmt.Sprintf("Page %d is too large to render at %d dpi", index+1, dpi), nil)
		}
		res, err := inst.RenderPageInDPI(&requests.RenderPageInDPI{
			DPI:  dpi,
			Page: requests.Page{ByIndex: &requests.PageByIndex{Document: doc, Index: index}},
		})
		if err != nil {
			return fmt.Errorf("render page %d: %w", index+1, err)
		}
		defer res.Cleanup()
		return fn(res.Result.Image, pc.PageCount)
	})
}

// thumbnail renders page (1-based) as a JPEG data URL.
func (m *Module) thumbnail(ctx context.Context, path string, page, width int, password string) (string, error) {
	if width < minThumbWidth || width > maxThumbWidth {
		return "", core.ValidationError(fmt.Sprintf("Thumbnail width must be %d–%d px", minThumbWidth, maxThumbWidth), nil)
	}
	if page < 1 {
		return "", core.ValidationError("Page numbers start at 1", nil)
	}
	r := m.state.r
	var out string
	err := r.with(ctx, path, password, func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT, key string) error {
		ck := fmt.Sprintf("%s|%d|%d", key, page, width)
		if v, ok := r.thumbs.get(ck); ok {
			out = v
			return nil
		}
		pc, err := inst.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc})
		if err != nil {
			return fmt.Errorf("page count: %w", err)
		}
		if page > pc.PageCount {
			return core.ValidationError(fmt.Sprintf("Page %d doesn't exist (the document has %d)", page, pc.PageCount), nil)
		}
		w, h, err := pageSize(inst, doc, page-1)
		if err != nil {
			return err
		}
		if w <= 0 || h <= 0 {
			return core.ValidationError(msgDamaged, nil)
		}
		height := max(1, int(math.Round(float64(width)*h/w)))
		res, err := inst.RenderPageInPixels(&requests.RenderPageInPixels{
			Width: width, Height: height,
			Page: requests.Page{ByIndex: &requests.PageByIndex{Document: doc, Index: page - 1}},
		})
		if err != nil {
			return fmt.Errorf("render page %d: %w", page, err)
		}
		defer res.Cleanup()
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, res.Result.Image, &jpeg.Options{Quality: thumbJPEGQ}); err != nil {
			return fmt.Errorf("encode thumbnail: %w", err)
		}
		out = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
		r.thumbs.put(ck, out)
		return nil
	})
	return out, err
}

// lru is a small string→string LRU cache.
type lru struct {
	mu  sync.Mutex
	cap int
	ll  *list.List
	m   map[string]*list.Element
}

type lruItem struct{ k, v string }

func newLRU(capacity int) *lru {
	return &lru{cap: capacity, ll: list.New(), m: map[string]*list.Element{}}
}

func (c *lru) get(k string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		c.ll.MoveToFront(e)
		return e.Value.(*lruItem).v, true
	}
	return "", false
}

func (c *lru) put(k, v string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.m[k]; ok {
		e.Value.(*lruItem).v = v
		c.ll.MoveToFront(e)
		return
	}
	c.m[k] = c.ll.PushFront(&lruItem{k, v})
	for c.ll.Len() > c.cap {
		e := c.ll.Back()
		c.ll.Remove(e)
		delete(c.m, e.Value.(*lruItem).k)
	}
}
