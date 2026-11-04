package core

import (
	"regexp"
	"strings"
)

// Pop-out windows (Phase 10, SPEC.md §4). Any tool, and any part of a
// composed tool, can open in its own window. Each window is a separate JS
// context; windows talk through WindowRelay events that Go fans out to every
// window. Nothing listens on a socket.

const (
	EventWindowsChanged = "windows:changed" // WindowsChanged
	EventWindowsRelay   = "windows:relay"   // WindowRelay
	EventWindowsHandoff = "windows:handoff" // WindowHandoff (a handoff is waiting for an open window)
)

// Window limits.
const (
	MaxRelayBytes   = 8 << 20  // one relay payload
	MaxHandoffBytes = 64 << 10 // one handoff payload
	MaxPopOuts      = 12       // open pop-out windows at once
)

// PopOutRequest opens (or focuses) a pop-out window.
type PopOutRequest struct {
	// Key identifies the window: "tool:<moduleId>" or "part:<partId>" with an
	// optional "@<instance>" suffix. Opening an open key focuses it.
	Key   string `json:"key"`
	Title string `json:"title"` // window title; "" = "Toolbox"
	// Query is the page's query string without "?", e.g.
	// "window=tool&view=edit-studio". It must start with "window=tool&" or
	// "window=part&"; Go appends "&key=<Key>".
	Query  string `json:"query"`
	Width  int    `json:"width"`  // 0 = 1180; clamped to 480..4096
	Height int    `json:"height"` // 0 = 760; clamped to 360..4096
	// Handoff is optional JSON the window takes once with TakeHandoff (a
	// frontend Handoff: inputs, seeds). If the window is already open,
	// windows:handoff tells it one is waiting.
	Handoff string `json:"handoff"`
}

// WindowsChanged lists the open pop-out windows' keys (sorted).
type WindowsChanged struct {
	Open []string `json:"open"`
}

// WindowRelay is a message between windows. Go doesn't read Payload.
type WindowRelay struct {
	Channel string `json:"channel"` // e.g. "bridge:edit-studio"
	From    string `json:"from"`    // sender's window key; "main" for the main window
	To      string `json:"to"`      // "" = every window
	Payload string `json:"payload"` // JSON, ≤ MaxRelayBytes
}

// WindowHandoff says a handoff waits for the window Key.
type WindowHandoff struct {
	Key string `json:"key"`
}

var (
	windowKeyRe     = regexp.MustCompile(`^(tool|part):[a-z0-9][a-z0-9._-]{0,63}(@[a-z0-9._-]{1,40})?$`)
	relayChannelRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9:._-]{0,79}$`)
	windowQueryRe   = regexp.MustCompile(`^window=(tool|part)&[A-Za-z0-9=&%._~-]+$`)
	relayEndpointRe = regexp.MustCompile(`^(main|(tool|part):[a-z0-9][a-z0-9._-]{0,63}(@[a-z0-9._-]{1,40})?)$`)
)

// ValidWindowKey reports whether k is a pop-out window key.
func ValidWindowKey(k string) bool { return windowKeyRe.MatchString(k) }

// ValidateRelay checks a relay message's addressing and size.
func ValidateRelay(r WindowRelay) error {
	if !relayChannelRe.MatchString(r.Channel) {
		return ValidationError("Bad window channel", map[string]string{"channel": r.Channel})
	}
	if !relayEndpointRe.MatchString(r.From) {
		return ValidationError("Bad sender window", map[string]string{"from": r.From})
	}
	if r.To != "" && !relayEndpointRe.MatchString(r.To) {
		return ValidationError("Bad target window", map[string]string{"to": r.To})
	}
	if len(r.Payload) > MaxRelayBytes {
		return ValidationError("The message between windows is too large", nil)
	}
	return nil
}

// NormalizePopOut validates r and fills defaults.
func NormalizePopOut(r PopOutRequest) (PopOutRequest, error) {
	if !ValidWindowKey(r.Key) {
		return r, ValidationError("Bad window key", map[string]string{"key": r.Key})
	}
	if len(r.Query) > 1024 || !windowQueryRe.MatchString(r.Query) || strings.Contains(r.Query, "key=") {
		return r, ValidationError("Bad window address", map[string]string{"query": r.Query})
	}
	if len(r.Handoff) > MaxHandoffBytes {
		return r, ValidationError("Too much data for the new window", nil)
	}
	r.Title = strings.TrimSpace(r.Title)
	if len([]rune(r.Title)) > 120 {
		r.Title = string([]rune(r.Title)[:120])
	}
	if r.Title == "" {
		r.Title = "Toolbox"
	}
	r.Width = clampDim(r.Width, 1180, 480)
	r.Height = clampDim(r.Height, 760, 360)
	return r, nil
}

func clampDim(v, def, lo int) int {
	if v == 0 {
		return def
	}
	return max(lo, min(4096, v))
}
