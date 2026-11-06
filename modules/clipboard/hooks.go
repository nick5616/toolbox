package clipboard

import (
	"context"
	"log/slog"
	"strings"
	"unicode"

	"toolbox/core"
)

// OnRecorded registers fn to be called, from the recorder's goroutine, with
// every copy that was recorded in the history (Phase 14: the pipelines'
// "When I copy…" trigger). fn must not block.
//
// Privacy: the recorder drops sensitive copies, oversized ones and
// everything while recording is off or paused before it records, so fn never
// sees them. A copy a pipeline step wrote itself (CopyTextQuiet) is recorded
// but not passed on, so a pipeline can't trigger itself.
func (h *History) OnRecorded(fn func(core.ClipItem)) {
	if fn == nil {
		return
	}
	h.mu.Lock()
	h.hooks = append(h.hooks, fn)
	h.mu.Unlock()
}

// Recording reports whether the recorder is running right now.
func (h *History) Recording() bool { return h.State().Recording }

// notifyRecorded calls the hooks for a recorded copy unless a pipeline step
// wrote it.
func (h *History) notifyRecorded(it core.ClipItem) {
	if !h.State().Recording {
		return // paused or switched off meanwhile: nothing leaves the history
	}
	h.mu.Lock()
	q := h.quiet
	if q.hash != "" && h.now().After(q.until) {
		h.quiet, q = selfCopy{}, selfCopy{}
	}
	mine := q.hash != "" && q.kind == it.Kind && q.hash == it.Hash
	if mine {
		h.quiet = selfCopy{}
	}
	hooks := append([]func(core.ClipItem){}, h.hooks...)
	h.mu.Unlock()
	if mine {
		slog.Debug("clipboard: copy written by a pipeline; trigger skipped")
		return
	}
	for _, fn := range hooks {
		fn(it)
	}
}

// CopyTextQuiet copies text for a pipeline step ("Copy to clipboard"). It is
// CopyText, except the copy starts no "When I copy…" pipeline.
func (h *History) CopyTextQuiet(ctx context.Context, text string) error {
	trimmed := strings.TrimRightFunc(strings.ToValidUTF8(text, "�"), unicode.IsSpace)
	h.mu.Lock()
	h.quiet = selfCopy{hash: hashOf(core.ClipText, []byte(trimmed)), kind: core.ClipText, until: h.now().Add(selfCopyTTL)}
	h.mu.Unlock()
	if err := h.CopyText(ctx, text); err != nil {
		h.mu.Lock()
		h.quiet = selfCopy{}
		h.mu.Unlock()
		return err
	}
	return nil
}
