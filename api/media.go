package api

// CONTRACT STUB (foundation): the exported names and signatures are frozen;
// MD1 implements the bodies (SPEC.md §3.2, §3.4).

import (
	"net/http"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
	"toolbox/core/media"
)

// MediaSource is what the UI plays for a file.
type MediaSource struct {
	URL        string     `json:"url"`        // "" while a preview copy is being made
	Info       media.Info `json:"info"`       //
	Proxy      bool       `json:"proxy"`      // URL points at the preview copy
	ProxyJobID string     `json:"proxyJobId"` // set when a preview-copy job was started or is running
}

// MediaService serves local media to the webview through the /media/ route
// (no socket) and makes filmstrips, waveforms and frames.
type MediaService struct {
	Paths   core.Paths
	Jobs    *core.Jobs
	Resolve func(depID string) (string, error) // deps.Service.Resolve
	GOOS    string                             // runtime.GOOS; tests override
}

// MediaPrefix is the URL path prefix the middleware serves.
const MediaPrefix = "/media/"

// MaxMediaResponse caps one media response body (the Windows webview
// buffers whole responses).
const MaxMediaResponse = 4 << 20

// MediaMiddleware serves /media/<token>/<name> and passes every other
// request to next.
func MediaMiddleware(m *MediaService) application.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, MediaPrefix) {
				next.ServeHTTP(w, r)
				return
			}
			m.serve(w, r)
		})
	}
}

// Open returns how to play path: its own URL when the webview can play it,
// else a cached preview copy, else the ID of the preview-copy job making one.
func (s *MediaService) Open(path string) (MediaSource, error) { return s.open(path) }

// Keyframes lists the video's keyframe times in ms (timeline times:
// Info.StartMs already subtracted).
func (s *MediaService) Keyframes(path string) ([]int64, error) { return s.keyframes(path) }

// Filmstrip renders count (4–60) evenly spaced frames, height px (40–160),
// as one horizontal JPEG sprite and returns its /media URL.
func (s *MediaService) Filmstrip(path string, count, height int) (string, error) {
	return s.filmstrip(path, count, height)
}

// Waveform returns buckets (100–4000) peak values in 0..1 over the whole
// file (mono mix).
func (s *MediaService) Waveform(path string, buckets int) ([]float32, error) {
	return s.waveform(path, buckets)
}

// Frame returns a /media URL for a JPEG of the frame at ms (timeline time),
// longest side ≤ maxDim (64–4096).
func (s *MediaService) Frame(path string, ms int64, maxDim int) (string, error) {
	return s.frame(path, ms, maxDim)
}

// URLFor returns a /media URL for any existing file.
func (s *MediaService) URLFor(path string) (string, error) { return s.urlFor(path) }
