package pdf

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"image/jpeg"
	"os"
	"sync"

	"toolbox/core"
	"toolbox/core/pdfium"
)

const (
	thumbCacheSize = 300
	minThumbWidth  = 80
	maxThumbWidth  = 1200
	thumbJPEGQ     = 80
)

// readPDF stats and reads a PDF; fi identifies the file version for caches.
func readPDF(path string) ([]byte, os.FileInfo, error) {
	fi, err := statPDF(path)
	if err != nil {
		return nil, nil, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", path, err)
	}
	return b, fi, nil
}

// thumbnail renders page (1-based) as a JPEG data URL.
func (m *Module) thumbnail(ctx context.Context, path string, page, width int, password string) (string, error) {
	if width < minThumbWidth || width > maxThumbWidth {
		return "", core.ValidationError(fmt.Sprintf("Thumbnail width must be %d–%d px", minThumbWidth, maxThumbWidth), nil)
	}
	if page < 1 {
		return "", core.ValidationError("Page numbers start at 1", nil)
	}
	fi, err := statPDF(path)
	if err != nil {
		return "", err
	}
	pw := ""
	if password != "" { // never keep a password in a cache key in clear
		pw = fmt.Sprintf("%x", sha256.Sum256([]byte(password)))
	}
	ck := fmt.Sprintf("%s|%d|%d|%s|%d|%d", path, fi.ModTime().UnixNano(), fi.Size(), pw, page, width)
	if v, ok := m.state.thumbs.get(ck); ok {
		return v, nil
	}
	// The renderer reads the file only when no instance has this version of
	// it open (a 100-page grid reads it once per instance, not once per page).
	src := pdfium.Source{
		Key: fmt.Sprintf("%s|%d|%d", path, fi.Size(), fi.ModTime().UnixNano()),
		Load: func() ([]byte, error) {
			doc, _, err := readPDF(path)
			return doc, err
		},
	}
	img, err := m.state.r.RenderWidthFrom(ctx, src, password, page, width)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: thumbJPEGQ}); err != nil {
		return "", fmt.Errorf("encode thumbnail: %w", err)
	}
	out := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	m.state.thumbs.put(ck, out)
	return out, nil
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
