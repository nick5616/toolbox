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

// maxSlots is how many instances (each its own WebAssembly module with its
// own copy of the open documents) render at once; it matches the pool's
// MaxTotal.
const maxSlots = 2

// Renderer is the lazily started pool. Up to maxSlots instances are used at
// the same time, each exclusively by one call.
type Renderer struct {
	cacheDir string

	mu     sync.Mutex
	cond   *sync.Cond // signalled when a slot frees up or the renderer closes
	pool   pdfium.Pool
	slots  []*slot
	idle   *time.Timer
	closed bool
}

// slot is one pool instance with the documents it has open (LRU, most recent
// last). busy and docs are guarded by Renderer.mu while the slot is idle and
// owned by the one caller that holds it while busy.
type slot struct {
	inst pdfium.Pdfium
	docs []docEntry
	busy bool
}

type docEntry struct {
	key string
	doc references.FPDF_DOCUMENT
}

// Source names a document without reading it: Key identifies a version of the
// bytes (a path with size and mtime, say) and Load reads them. Load is only
// called when no instance already has the document open.
type Source struct {
	Key  string
	Load func() ([]byte, error)
}

// BytesSource wraps bytes already in memory; the key is their SHA-256.
func BytesSource(doc []byte) Source {
	sum := sha256.Sum256(doc)
	return Source{Key: fmt.Sprintf("sha:%x", sum), Load: func() ([]byte, error) { return doc, nil }}
}

// New returns a renderer whose WebAssembly compilation cache lives in
// cacheDir (empty disables the cache). Nothing starts until first use.
func New(cacheDir string) *Renderer {
	r := &Renderer{cacheDir: cacheDir}
	r.cond = sync.NewCond(&r.mu)
	return r
}

// startLocked brings the pool and the first instance up. Caller holds mu.
func (r *Renderer) startLocked() error {
	if r.closed {
		return errors.New("renderer is closed")
	}
	if len(r.slots) > 0 {
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
		MinIdle: 0, MaxIdle: maxSlots, MaxTotal: maxSlots,
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
	r.pool = pool
	r.slots = []*slot{{inst: inst}}
	return nil
}

// stopLocked closes documents, instances and the pool. Caller holds mu and
// no slot is busy.
func (r *Renderer) stopLocked() {
	if len(r.slots) == 0 {
		return
	}
	for _, s := range r.slots {
		for _, d := range s.docs {
			_, _ = s.inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: d.doc})
		}
		_ = s.inst.Close()
	}
	_ = r.pool.Close()
	r.slots, r.pool = nil, nil
}

func (r *Renderer) anyBusyLocked() bool {
	for _, s := range r.slots {
		if s.busy {
			return true
		}
	}
	return false
}

// Close stops the pool once running calls finish; the renderer can't be used
// afterwards.
func (r *Renderer) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	r.cond.Broadcast()
	if r.idle != nil {
		r.idle.Stop()
	}
	for r.anyBusyLocked() {
		r.cond.Wait()
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
		if r.anyBusyLocked() {
			r.touchLocked() // still in use: look again later
			return
		}
		r.stopLocked()
	})
}

// docKey identifies a document version and password without keeping the
// password: the password is hashed into the key.
func docKey(srcKey, password string) string {
	if password == "" {
		return srcKey + "|"
	}
	pw := sha256.Sum256([]byte(password))
	return fmt.Sprintf("%s|%x", srcKey, pw[:8])
}

// acquire hands out an idle instance, preferring one that already has the
// document open, starting the second instance when the first is busy, and
// otherwise waiting.
func (r *Renderer) acquire(ctx context.Context, key string) (*slot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	stop := context.AfterFunc(ctx, func() {
		r.mu.Lock()
		r.cond.Broadcast()
		r.mu.Unlock()
	})
	defer stop()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := r.startLocked(); err != nil {
			return nil, err
		}
		var free *slot
		for _, s := range r.slots {
			if s.busy {
				continue
			}
			for _, d := range s.docs {
				if d.key == key {
					s.busy = true
					return s, nil
				}
			}
			if free == nil {
				free = s
			}
		}
		if free != nil {
			free.busy = true
			return free, nil
		}
		if len(r.slots) < maxSlots {
			s := &slot{busy: true}
			r.slots = append(r.slots, s)
			pool := r.pool
			r.mu.Unlock()
			inst, err := pool.GetInstance(time.Minute)
			r.mu.Lock()
			if err != nil {
				for i, x := range r.slots {
					if x == s {
						r.slots = append(r.slots[:i:i], r.slots[i+1:]...)
						break
					}
				}
				r.cond.Broadcast()
				return nil, fmt.Errorf("get pdfium instance: %w", err)
			}
			s.inst = inst
			return s, nil
		}
		r.cond.Wait()
	}
}

func (r *Renderer) release(s *slot) {
	r.mu.Lock()
	s.busy = false
	r.cond.Broadcast()
	r.touchLocked()
	r.mu.Unlock()
}

// with opens (or reuses) the document and runs fn with exclusive access to
// one instance. Other calls may run on the second instance meanwhile.
func (r *Renderer) with(ctx context.Context, src Source, password string, fn func(inst pdfium.Pdfium, doc references.FPDF_DOCUMENT) error) error {
	key := docKey(src.Key, password)
	s, err := r.acquire(ctx, key)
	if err != nil {
		return err
	}
	defer r.release(s)

	var d references.FPDF_DOCUMENT
	found := false
	for i, e := range s.docs {
		if e.key == key {
			d, found = e.doc, true
			s.docs = append(append(s.docs[:i:i], s.docs[i+1:]...), e)
			break
		}
	}
	if !found {
		doc, err := src.Load()
		if err != nil {
			return err
		}
		req := &requests.OpenDocument{File: &doc}
		if password != "" {
			req.Password = &password
		}
		res, err := s.inst.OpenDocument(req)
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
		s.docs = append(s.docs, docEntry{key: key, doc: d})
		for len(s.docs) > docCacheSize {
			_, _ = s.inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: s.docs[0].doc})
			s.docs = s.docs[1:]
		}
	}
	return fn(s.inst, d)
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
	err := r.with(ctx, BytesSource(doc), password, func(inst pdfium.Pdfium, d references.FPDF_DOCUMENT) (err error) {
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
	err := r.with(ctx, BytesSource(doc), password, func(inst pdfium.Pdfium, d references.FPDF_DOCUMENT) error {
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
	return r.RenderWidthFrom(ctx, BytesSource(doc), password, page, width)
}

// RenderWidthFrom is RenderWidth for a Source: a document some instance
// already has open is never read or hashed again.
func (r *Renderer) RenderWidthFrom(ctx context.Context, src Source, password string, page, width int) (image.Image, error) {
	if page < 1 {
		return nil, core.ValidationError("Page numbers start at 1", nil)
	}
	var out image.Image
	err := r.with(ctx, src, password, func(inst pdfium.Pdfium, d references.FPDF_DOCUMENT) error {
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
	err := r.with(ctx, BytesSource(doc), password, func(inst pdfium.Pdfium, d references.FPDF_DOCUMENT) error {
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
