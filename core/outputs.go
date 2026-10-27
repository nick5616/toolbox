package core

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
)

// NewID returns a new time-sortable ULID string.
func NewID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String()
}

// NowMillis is the current time in Unix milliseconds.
func NowMillis() int64 { return time.Now().UnixMilli() }

var kindByExt = map[string]OutputKind{}

func init() {
	for kind, exts := range map[OutputKind][]string{
		KindAudio:    AudioExtensions,
		KindVideo:    VideoExtensions,
		KindImage:    ImageExtensions,
		KindDocument: {".pdf", ".txt", ".md", ".json", ".csv"},
	} {
		for _, e := range exts {
			kindByExt[e] = kind
		}
	}
}

// Common extension sets, shared by modules' Accepts declarations.
var (
	AudioExtensions = []string{".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".aiff", ".aif"}
	VideoExtensions = []string{".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}
	ImageExtensions = []string{".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tif", ".tiff", ".bmp"}
)

// KindForPath classifies a file by extension.
func KindForPath(path string) OutputKind {
	if k, ok := kindByExt[strings.ToLower(filepath.Ext(path))]; ok {
		return k
	}
	return KindOther
}

// NewOutput builds an Output for an existing file, with auto tags
// "module:<id>" and "kind:<kind>". The file must exist and be a regular file.
func NewOutput(path, jobID, moduleID string) (Output, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Output{}, fmt.Errorf("resolve output path %q: %w", path, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Output{}, fmt.Errorf("stat output %q: %w", abs, err)
	}
	if !info.Mode().IsRegular() {
		return Output{}, fmt.Errorf("output %q is not a regular file", abs)
	}
	kind := KindForPath(abs)
	return Output{
		ID:        NewID(),
		JobID:     jobID,
		ModuleID:  moduleID,
		Path:      abs,
		Name:      filepath.Base(abs),
		Kind:      kind,
		SizeBytes: info.Size(),
		CreatedAt: NowMillis(),
		Tags:      []string{"module:" + moduleID, "kind:" + string(kind)},
	}, nil
}
