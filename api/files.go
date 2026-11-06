package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	sysclip "golang.design/x/clipboard"

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

// PickWith shows a native file dialog filtered to extensions (lowercase,
// leading dot; empty = any file), e.g. a background image for Lyric Video.
// Cancelling returns an empty list.
func (s *FilesService) PickWith(title string, extensions []string, multiple bool) ([]string, error) {
	opts := &application.OpenFileDialogOptions{
		CanChooseFiles:          true,
		AllowsMultipleSelection: multiple,
		Title:                   title,
		ButtonText:              "Choose",
	}
	if len(extensions) > 0 {
		pats := make([]string, len(extensions))
		for i, e := range extensions {
			pats[i] = "*" + e
		}
		opts.Filters = []application.FileFilter{{DisplayName: strings.Join(pats, ", "), Pattern: strings.Join(pats, ";")}}
	}
	d := application.Get().Dialog.OpenFileWithOptions(opts)
	if !multiple {
		path, err := d.PromptForSingleSelection()
		if err != nil {
			return nil, fmt.Errorf("file dialog: %w", err)
		}
		if path == "" {
			return []string{}, nil
		}
		return []string{path}, nil
	}
	paths, err := d.PromptForMultipleSelection()
	if err != nil {
		return nil, fmt.Errorf("file dialog: %w", err)
	}
	if paths == nil {
		paths = []string{}
	}
	return paths, nil
}

// PickFolder shows a native folder dialog (watch folders, Copy to folder).
// Cancelling returns "".
func (s *FilesService) PickFolder(title string) (string, error) {
	path, err := application.Get().Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseDirectories: true,
		CanChooseFiles:       false,
		CanCreateDirectories: true,
		Title:                title,
		ButtonText:           "Choose",
	}).PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("folder dialog: %w", err)
	}
	return path, nil
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
	if imaging.IsHEIC(path) && filepath.IsAbs(path) { // the webview can't show HEIC: a converted preview
		return imaging.Default().Thumb(path, imaging.MaxThumbDim)
	}
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

// maxClipboardImage caps a pasted image (same limit as clipboard history).
const maxClipboardImage = 20 << 20

// clipboardReader is the read side of the OS clipboard (swapped in tests).
// It never writes.
type clipboardReader interface {
	Files(ctx context.Context) ([]string, error)
	Image(ctx context.Context) ([]byte, error)
}

type systemClipboardReader struct{}

func (systemClipboardReader) Files(ctx context.Context) ([]string, error) {
	if err := sysclip.Init(); err != nil {
		return nil, err
	}
	return sysclip.ReadFiles(ctx)
}

func (systemClipboardReader) Image(ctx context.Context) ([]byte, error) {
	if err := sysclip.Init(); err != nil {
		return nil, err
	}
	return sysclip.Read(ctx, sysclip.FmtImage)
}

var clipReader clipboardReader = systemClipboardReader{}

// ClipboardFiles returns the files copied in Explorer/Finder (existing
// absolute paths only) or, when the clipboard holds an image instead, saves it
// as a PNG in the app's tmp folder and returns that path. Anything else, or a
// platform that can't read file lists, returns an empty list. It never writes
// to the clipboard.
func (s *FilesService) ClipboardFiles() ([]string, error) {
	return s.clipboardFiles(context.Background(), clipReader)
}

func (s *FilesService) clipboardFiles(ctx context.Context, r clipboardReader) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	if paths, err := r.Files(ctx); err == nil {
		out := make([]string, 0, len(paths))
		for _, p := range paths {
			if !filepath.IsAbs(p) {
				continue
			}
			if _, err := os.Stat(p); err == nil {
				out = append(out, p)
			}
		}
		if len(out) > 0 {
			return out, nil
		}
	}

	img, err := r.Image(ctx)
	if err != nil || len(img) == 0 || len(img) > maxClipboardImage {
		// Nothing usable, or no clipboard to reach: not an error for a paste.
		return []string{}, nil
	}
	dir := filepath.Join(s.Paths.TmpDir, "paste")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create paste folder: %w", err)
	}
	pruneOld(dir, 24*time.Hour)
	var b [4]byte
	_, _ = rand.Read(b[:])
	p := filepath.Join(dir, "Pasted image "+time.Now().Format("2006-01-02 150405")+"-"+hex.EncodeToString(b[:])+".png")
	if err := os.WriteFile(p, img, 0o600); err != nil {
		return nil, fmt.Errorf("save pasted image: %w", err)
	}
	return []string{p}, nil
}

// pruneOld deletes files in dir older than age (best effort).
func pruneOld(dir string, age time.Duration) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && !e.IsDir() && time.Since(info.ModTime()) > age {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
