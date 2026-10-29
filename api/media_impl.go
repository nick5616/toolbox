package api

// MD1 owns this file (SPEC.md §3.2, §3.4). Foundation stubs only.

import (
	"net/http"

	"toolbox/core"
)

func (m *MediaService) serve(w http.ResponseWriter, r *http.Request) {
	http.NotFound(w, r)
}

func notBuilt() error { return core.Errorf(core.CodeNotImplemented, "Media playback isn't built yet") }

func (s *MediaService) open(path string) (MediaSource, error) { return MediaSource{}, notBuilt() }

func (s *MediaService) keyframes(path string) ([]int64, error) { return nil, notBuilt() }

func (s *MediaService) filmstrip(path string, count, height int) (string, error) {
	return "", notBuilt()
}

func (s *MediaService) waveform(path string, buckets int) ([]float32, error) { return nil, notBuilt() }

func (s *MediaService) frame(path string, ms int64, maxDim int) (string, error) {
	return "", notBuilt()
}

func (s *MediaService) urlFor(path string) (string, error) { return "", notBuilt() }
