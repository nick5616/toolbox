package sidecar

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func pathEntry(env []string) (string, bool) {
	for _, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			return strings.TrimPrefix(e, "PATH="), true
		}
	}
	return "", false
}

func TestEnginePathStartsWithFFmpegFolder(t *testing.T) {
	m := NewManager(core.NewPaths(t.TempDir()), nil, nil)
	if _, ok := pathEntry(m.env()); ok {
		t.Error("PATH set without a resolver")
	}
	dir := filepath.Join(t.TempDir(), "ffmpeg")
	m.SetFFmpegResolver(func() (string, error) { return filepath.Join(dir, "ffmpeg.exe"), nil })
	got, ok := pathEntry(m.env())
	if !ok || !strings.HasPrefix(got, dir+string(os.PathListSeparator)) {
		t.Fatalf("PATH %q does not start with %q", got, dir)
	}
	if !strings.HasSuffix(got, os.Getenv("PATH")) {
		t.Errorf("original PATH lost: %q", got)
	}
	// FFmpeg missing: PATH is left alone.
	m.SetFFmpegResolver(func() (string, error) { return "", errors.New("missing") })
	if _, ok := pathEntry(m.env()); ok {
		t.Error("PATH set although ffmpeg is missing")
	}
}
