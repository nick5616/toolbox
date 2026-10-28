package clipboard

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/png" // register the PNG decoder for image.DecodeConfig
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"toolbox/core"
)

const errUnavailable = "Clipboard unavailable"

type watcher struct {
	cancel context.CancelFunc
	done   chan struct{}
	images bool
}

// control starts and stops the watcher as settings / pause state change.
func (h *History) control(ctx context.Context) {
	defer h.wg.Done()
	var w *watcher
	stop := func() {
		if w != nil {
			w.cancel()
			<-w.done
			w = nil
		}
	}
	defer func() {
		stop()
		h.setStatus(false, "")
	}()
	for {
		s := h.settings()
		h.mu.Lock()
		want := s.Enabled && !h.paused
		h.mu.Unlock()
		if w != nil && (!want || w.images != s.Images) {
			stop()
			h.setStatus(false, "")
		}
		if w == nil && want {
			wctx, cancel := context.WithCancel(ctx)
			w = &watcher{cancel: cancel, done: make(chan struct{}), images: s.Images}
			go func(w *watcher) {
				defer close(w.done)
				h.runWatcher(wctx, w.images)
			}(w)
		}
		if w == nil {
			h.setStatus(false, "")
		}
		select {
		case <-h.kick:
		case <-ctx.Done():
			return
		}
	}
}

// runWatcher watches the clipboard with error backoff until ctx is done.
func (h *History) runWatcher(ctx context.Context, images bool) {
	if err := h.ensureInit(); err != nil {
		slog.Warn("clipboard init failed", "err", err)
		h.setStatus(false, errUnavailable)
		return
	}
	backoff := h.backoffMin
	for ctx.Err() == nil {
		wctx, cancel := context.WithCancel(ctx)
		ch := h.src.Watch(wctx, images)
		h.setStatus(true, "")
		err := h.consume(wctx, ch, &backoff)
		cancel()
		if ctx.Err() != nil {
			return
		}
		slog.Warn("clipboard watch failed; retrying", "err", err, "in", backoff)
		h.setStatus(false, "Clipboard error: "+err.Error())
		t := time.NewTimer(backoff)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return
		}
		backoff = min(backoff*2, h.backoffMax)
	}
}

func (h *History) consume(ctx context.Context, ch <-chan change, backoff *time.Duration) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case c, ok := <-ch:
			if !ok {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				return errors.New("clipboard watcher stopped")
			}
			if c.Err != nil {
				return c.Err
			}
			*backoff = h.backoffMin
			h.handle(ctx, c)
		}
	}
}

func hashOf(kind core.ClipKind, content []byte) string {
	sum := sha256.New()
	sum.Write([]byte(kind))
	sum.Write([]byte{0})
	sum.Write(content)
	return hex.EncodeToString(sum.Sum(nil))
}

func makePreview(s string) string {
	p := strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(p) > previewChars {
		p = string([]rune(p)[:previewChars])
	}
	return p
}

// consumeSelf reports whether a change is the echo of an item Copy just wrote.
func (h *History) consumeSelf(hash string, kind core.ClipKind) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.self
	if s.hash == "" || h.now().After(s.until) {
		h.self = selfCopy{}
		return false
	}
	// The OS may re-encode an image, so images match on kind alone.
	if s.hash == hash || (kind == core.ClipImage && s.kind == core.ClipImage) {
		h.self = selfCopy{}
		return true
	}
	return false
}

// handle records one clipboard change. Never logs content.
func (h *History) handle(ctx context.Context, c change) {
	if c.Sensitive {
		slog.Debug("clipboard: skipped sensitive copy")
		return
	}
	now := h.now().UnixMilli()
	item := core.ClipItem{Kind: c.Kind, CreatedAt: now, LastUsedAt: now}
	switch c.Kind {
	case core.ClipText:
		if len(c.Bytes) > maxTextBytes {
			slog.Debug("clipboard: skipped oversized text", "bytes", len(c.Bytes))
			return
		}
		text := strings.TrimRightFunc(strings.ToValidUTF8(string(c.Bytes), "�"), unicode.IsSpace)
		if text == "" {
			return
		}
		item.Text, item.Preview, item.ByteSize = text, makePreview(text), int64(len(text))
		item.Hash = hashOf(core.ClipText, []byte(text))
	case core.ClipImage:
		if !h.settings().Images {
			return
		}
		if len(c.Bytes) == 0 || len(c.Bytes) > maxImageBytes {
			slog.Debug("clipboard: skipped image", "bytes", len(c.Bytes))
			return
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(c.Bytes))
		if err != nil {
			slog.Debug("clipboard: undecodable image", "err", err)
			return
		}
		item.Width, item.Height, item.ByteSize = cfg.Width, cfg.Height, int64(len(c.Bytes))
		item.Hash = hashOf(core.ClipImage, c.Bytes)
		item.Preview = fmt.Sprintf("Image %d×%d", cfg.Width, cfg.Height)
	default:
		return
	}

	if h.consumeSelf(item.Hash, item.Kind) {
		return // Copy already bumped last_used_at
	}

	if item.Kind == core.ClipImage {
		item.ID = core.NewID()
		if err := os.MkdirAll(h.cfg.Dir, 0o700); err != nil {
			slog.Warn("clipboard: create image dir", "err", err)
			return
		}
		item.ImagePath = filepath.Join(h.cfg.Dir, item.ID+".png")
		if err := os.WriteFile(item.ImagePath, c.Bytes, 0o600); err != nil {
			slog.Warn("clipboard: write image", "err", err)
			os.Remove(item.ImagePath)
			return
		}
	}
	stored, inserted, err := h.cfg.Store.UpsertClip(ctx, item)
	if err != nil {
		if item.ImagePath != "" {
			os.Remove(item.ImagePath)
		}
		if ctx.Err() == nil {
			slog.Warn("clipboard: store item", "err", err)
		}
		return
	}
	if !inserted && item.ImagePath != "" {
		os.Remove(item.ImagePath) // duplicate: keep the original file
	}
	h.cfg.Emitter.Emit(core.EventClipboardAdded, stored)
	if inserted {
		h.prune(ctx)
	}
}

// retention prunes on start, hourly and when retention settings change.
func (h *History) retention(ctx context.Context) {
	defer h.wg.Done()
	tick, stop := h.newTicker(time.Hour)
	defer stop()
	h.prune(ctx)
	for {
		select {
		case <-tick:
			h.prune(ctx)
		case <-h.pruneKick:
			h.prune(ctx)
		case <-ctx.Done():
			return
		}
	}
}

// prune applies the retention settings; pinned items are exempt.
func (h *History) prune(ctx context.Context) {
	s := h.settings()
	var olderThan int64
	if s.RetentionDays > 0 {
		olderThan = h.now().Add(-time.Duration(s.RetentionDays) * 24 * time.Hour).UnixMilli()
	}
	rm, err := h.cfg.Store.PruneClips(ctx, olderThan, s.MaxItems)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("clipboard: prune", "err", err)
		}
		return
	}
	h.afterRemove(rm)
}
