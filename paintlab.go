package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// PaintLab (Phase 19, dev only): with TOOLBOX_PAINTLAB=1 the page at
// /?window=paintlab replays recorded strokes per brush preset and sends the
// frames back over raw messages ("plab|<name>|<base64>"), which land in
// <support>/tmp/paintlab/. Like VizLab, it never opens a socket.

const paintLabPrefix = "plab|"

var paintLabName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}$`)

type paintLabSink struct {
	dir     string
	origins map[string]bool
}

// newPaintLabSink returns nil unless TOOLBOX_PAINTLAB=1.
func newPaintLabSink(dir string, origins []string) *paintLabSink {
	if os.Getenv("TOOLBOX_PAINTLAB") != "1" {
		return nil
	}
	m := map[string]bool{}
	for _, o := range origins {
		m[o] = true
	}
	return &paintLabSink{dir: dir, origins: m}
}

// handle consumes a PaintLab message and reports whether it was one.
func (p *paintLabSink) handle(msg, origin string) bool {
	if p == nil || !strings.HasPrefix(msg, paintLabPrefix) {
		return false
	}
	if !p.origins[origin] {
		return true
	}
	rest := strings.TrimPrefix(msg, paintLabPrefix)
	name, b64, ok := strings.Cut(rest, "|")
	if !ok || !paintLabName.MatchString(name) || strings.Contains(name, "..") {
		return true
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) > 64<<20 {
		return true
	}
	if err := os.MkdirAll(p.dir, 0o755); err != nil {
		return true
	}
	_ = os.WriteFile(filepath.Join(p.dir, name), raw, 0o644)
	return true
}

// paintLabURL is the start URL for TOOLBOX_PAINTLAB=1 TOOLBOX_VIEW=paintlab,
// or "" when it isn't requested. TOOLBOX_PAINTLAB_ONLY limits it to one
// preset id and TOOLBOX_PAINTLAB_MODE selects "sheets" (default), "fps" or "all".
func paintLabURL() string {
	if os.Getenv("TOOLBOX_PAINTLAB") != "1" || os.Getenv("TOOLBOX_VIEW") != "paintlab" {
		return ""
	}
	q := "/?window=paintlab"
	if only := os.Getenv("TOOLBOX_PAINTLAB_ONLY"); only != "" {
		q += "&only=" + queryEscape(only)
	}
	if mode := os.Getenv("TOOLBOX_PAINTLAB_MODE"); mode != "" {
		q += "&mode=" + queryEscape(mode)
	}
	return q
}

func queryEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_', c == '.':
			b.WriteByte(c)
		default:
			b.WriteString("%" + strings.ToUpper(string("0123456789abcdef"[c>>4])+string("0123456789abcdef"[c&15])))
		}
	}
	return b.String()
}
