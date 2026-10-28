package api

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
	"toolbox/core/imaging"
)

// FilesService lets tools pick and inspect local input files.
type FilesService struct {
	Reg      *core.Registry
	Settings *core.SettingsService
	Paths    core.Paths
}

// File read limits (Phase 3 SPEC.md §8).
const (
	MaxReadTextBytes  = 256 << 10
	MaxImageDataBytes = 20 << 20
)

// Pick shows a native multi-select file dialog filtered to the module's
// accepted extensions. Cancelling returns an empty list.
func (s *FilesService) Pick(moduleID string) ([]string, error) {
	d, ok := s.Reg.Descriptor(moduleID)
	if !ok {
		return nil, core.Errorf(core.CodeNotFound, "Unknown module %q", moduleID)
	}
	opts := &application.OpenFileDialogOptions{
		CanChooseFiles:          true,
		AllowsMultipleSelection: true,
		Title:                   "Add files to " + d.Name,
		ButtonText:              "Add",
	}
	if exts := d.Accepts.Extensions; len(exts) > 0 {
		pats := make([]string, len(exts))
		for i, e := range exts {
			pats[i] = "*" + e
		}
		opts.Filters = []application.FileFilter{{
			DisplayName: fmt.Sprintf("%s files (%s)", d.Name, strings.Join(pats, ", ")),
			Pattern:     strings.Join(pats, ";"),
		}}
	}
	paths, err := application.Get().Dialog.OpenFileWithOptions(opts).PromptForMultipleSelection()
	if err != nil {
		if errors.Is(err, errDialogCancelled) {
			return []string{}, nil
		}
		return nil, fmt.Errorf("file dialog: %w", err)
	}
	if paths == nil {
		paths = []string{}
	}
	return paths, nil
}

// errDialogCancelled is never returned by Wails (it returns empty results
// on cancel); kept so the cancel path stays explicit.
var errDialogCancelled = errors.New("cancelled")

// Stat describes paths for input lists.
func (s *FilesService) Stat(paths []string) []core.FileInfo { return core.StatFiles(paths) }

// ReadText returns up to maxBytes (≤ 256 KB; ≤ 0 means 256 KB) of a text
// file inside the library or the app's support folder, cut at a UTF-8
// boundary.
func (s *FilesService) ReadText(path string, maxBytes int) (string, error) {
	if maxBytes <= 0 || maxBytes > MaxReadTextBytes {
		maxBytes = MaxReadTextBytes
	}
	if !filepath.IsAbs(path) || (!core.IsWithin(path, s.Settings.Current().LibraryDir) && !core.IsWithin(path, s.Paths.SupportDir)) {
		return "", core.Errorf(core.CodeConflict, "Only files inside the library or app folder can be previewed")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(path)).WithCause(err)
	}
	defer f.Close()
	buf, err := io.ReadAll(io.LimitReader(f, int64(maxBytes)))
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	// Drop a rune split by the size limit; replace any other invalid bytes.
	if n := len(buf); n == maxBytes {
		for i := 1; i < utf8.UTFMax && i <= n; i++ {
			if utf8.RuneStart(buf[n-i]) {
				if !utf8.FullRune(buf[n-i:]) {
					buf = buf[:n-i]
				}
				break
			}
		}
	}
	return strings.ToValidUTF8(string(buf), "�"), nil
}

// imageMIME maps image extensions to MIME types for data URLs.
var imageMIME = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
	".gif": "image/gif", ".bmp": "image/bmp",
}

// ImageDataURL returns a browser-displayable image file (jpg, png, webp,
// gif, bmp; ≤ 20 MB) as a data URL, for thumbnails. The user already chose
// the file; non-image files are never read.
func (s *FilesService) ImageDataURL(path string) (string, error) {
	ext := strings.ToLower(filepath.Ext(path))
	typ, ok := imageMIME[ext]
	if !ok || !filepath.IsAbs(path) {
		return "", core.Errorf(core.CodeValidation, "No preview for this file type")
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(path))
	}
	if info.Size() > MaxImageDataBytes {
		return "", core.Errorf(core.CodeValidation, "Image is too large to preview")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return "data:" + typ + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}

// ImageThumb returns an image (jpg, png, gif, webp, bmp, tif/tiff; ≤ 400 MB,
// ≤ 300 MP) as a data URL scaled so its longest side is ≤ maxDim (64..1600).
// PNG when the image has transparency, else JPEG. HEIC → validation error.
func (s *FilesService) ImageThumb(path string, maxDim int) (string, error) {
	return imaging.Default().Thumb(path, maxDim)
}

// ImageSize returns an image's pixel dimensions (header only).
func (s *FilesService) ImageSize(path string) (core.Size, error) {
	return imaging.Size(path)
}
