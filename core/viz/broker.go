package viz

import (
	"context"
	"encoding/base64"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"toolbox/core"
)

// RenderBroker hands render plans to the webview's RenderHost and receives
// the encoded stream back over raw messages (SPEC.md §7.2).
type RenderBroker struct {
	emitter core.Emitter
	urlFor  func(path string) (string, error)
	labDir  string // "" unless TOOLBOX_VIZLAB=1

	mu      sync.Mutex
	origins map[string]bool
	sem     chan struct{}
	active  map[string]*render // by token (RB1)
}

// render is one in-flight render (RB1 fills it in).
type render struct{}

// NewRenderBroker builds a broker. urlFor turns a file path into a /media
// URL (MediaService.URLFor). labDir enables the VizLab sink when non-empty.
func NewRenderBroker(emitter core.Emitter, urlFor func(string) (string, error), labDir string) *RenderBroker {
	return &RenderBroker{emitter: emitter, urlFor: urlFor, labDir: labDir, origins: map[string]bool{},
		sem: make(chan struct{}, 1), active: map[string]*render{}}
}

// SetAppOrigins sets the origins raw messages may come from (the app's own).
func (b *RenderBroker) SetAppOrigins(origins ...string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, o := range origins {
		b.origins[strings.TrimRight(o, "/")] = true
	}
}

// originOf reduces a source (WebView2 reports the full page URL) to scheme://host.
func originOf(s string) string {
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimRight(s, "/")
	}
	return u.Scheme + "://" + u.Host
}

func (b *RenderBroker) originOK(origin, topOrigin string) bool {
	origin, topOrigin = originOf(origin), originOf(topOrigin)
	b.mu.Lock()
	defer b.mu.Unlock()
	return origin == topOrigin && b.origins[origin]
}

// Render blocks until the renderer finishes and returns the stream it wrote
// in job.TempDir (SPEC.md §7.2). RB1's.
func (b *RenderBroker) Render(ctx context.Context, job *core.JobContext, plan RenderPlan) (RenderOutput, error) {
	return b.render(ctx, job, plan)
}

func (b *RenderBroker) render(ctx context.Context, job *core.JobContext, plan RenderPlan) (RenderOutput, error) {
	return RenderOutput{}, core.Errorf(core.CodeInternal, "not built yet")
}

// HandleRawMessage receives a raw message from the webview (main.go wires it
// to application.Options.RawMessageHandler).
func (b *RenderBroker) HandleRawMessage(msg, origin, topOrigin string) {
	switch {
	case strings.HasPrefix(msg, RawPrefix):
		if !b.originOK(origin, topOrigin) {
			slog.Debug("viz: dropped a render message from another origin")
			return
		}
		b.handleRender(msg[len(RawPrefix):])
	case strings.HasPrefix(msg, LabPrefix) && b.labDir != "":
		if !b.originOK(origin, topOrigin) {
			return
		}
		b.handleLab(msg[len(LabPrefix):])
	}
}

// handleRender is RB1's (SPEC.md §7.2 message format).
func (b *RenderBroker) handleRender(body string) {}

var labName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,120}$`)

// handleLab writes "name|base64" into labDir (VizLab, SPEC.md §11.4).
func (b *RenderBroker) handleLab(body string) {
	name, data, ok := strings.Cut(body, "|")
	if !ok || !labName.MatchString(name) || strings.HasPrefix(name, ".") {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return
	}
	if err := os.MkdirAll(b.labDir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(b.labDir, name), raw, 0o644)
}
