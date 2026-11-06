package api

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
)

// SaveCopy asks where to save a copy of a library output (or of a file inside
// the library or app folder when outputID is "") and copies it there. The
// original is never moved or changed. Cancelling returns "".
func (s *LibraryService) SaveCopy(outputID, path string) (string, error) {
	src, err := s.saveCopySource(outputID, path)
	if err != nil {
		return "", err
	}
	dst, err := application.Get().Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		CanCreateDirectories: true,
		Title:                "Save a copy",
		Filename:             filepath.Base(src),
		ButtonText:           "Save",
	}).PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("save dialog: %w", err)
	}
	if dst == "" {
		return "", nil
	}
	if filepath.Ext(dst) == "" {
		dst += filepath.Ext(src)
	}
	if err := copyToNew(src, dst); err != nil {
		return "", err
	}
	return dst, nil
}

func (s *LibraryService) saveCopySource(outputID, path string) (string, error) {
	if outputID != "" {
		o, err := s.existing(outputID)
		if err != nil {
			return "", err
		}
		return o.Path, nil
	}
	lib := s.Settings.Current().LibraryDir
	if !core.IsWithin(path, lib) && !core.IsWithin(path, s.Paths.SupportDir) {
		return "", core.Errorf(core.CodeConflict, "Only files inside the library or app folder can be saved from here")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(path)).WithCause(err)
	}
	if info.IsDir() {
		return "", core.Errorf(core.CodeConflict, "%s is a folder; use Show in folder instead", filepath.Base(path))
	}
	return path, nil
}

// copyToNew copies src to dst through a temporary file next to dst, so a
// failed copy never leaves half a file. dst may already exist (the save
// dialog asked); dst must not be src itself.
func copyToNew(src, dst string) error {
	sa, err := filepath.Abs(src)
	if err != nil {
		return fmt.Errorf("resolving %s: %w", src, err)
	}
	da, err := filepath.Abs(dst)
	if err != nil {
		return fmt.Errorf("resolving %s: %w", dst, err)
	}
	if si, err := os.Stat(sa); err == nil {
		if di, err := os.Stat(da); err == nil && os.SameFile(si, di) {
			return core.Errorf(core.CodeConflict, "That is the file itself; pick another name or folder")
		}
	}
	in, err := os.Open(sa)
	if err != nil {
		return core.Errorf(core.CodeNotFound, "%s can't be read", filepath.Base(sa)).WithCause(err)
	}
	defer in.Close()
	return writeAtomic(da, in)
}

// writeAtomic writes r to dst through a temporary file next to it, so a
// failed write never leaves half a file. An existing dst is replaced.
func writeAtomic(dst string, r io.Reader) error {
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".toolbox-copy-*")
	if err != nil {
		return core.Errorf(core.CodeConflict, "Can't write to %s", filepath.Dir(dst)).WithCause(err)
	}
	tmpName := tmp.Name()
	_, cerr := io.Copy(tmp, r)
	if err := tmp.Close(); cerr == nil {
		cerr = err
	}
	if cerr != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("writing %s: %w", filepath.Base(dst), cerr)
	}
	if err := os.Rename(tmpName, dst); err != nil {
		_ = os.Remove(tmpName)
		return core.Errorf(core.CodeConflict, "Can't save %s", filepath.Base(dst)).WithCause(err)
	}
	return nil
}

// MaxSaveTextBytes caps SaveText.
const MaxSaveTextBytes = 64 << 20

// SaveText asks where to save text a tool produced (a transcript, OCR text,
// a chat answer, a table) and writes it there as UTF-8. filename is the
// suggested name including its extension (".txt", ".md", ".csv", ".json", …);
// the dialog starts in the library folder. Cancelling returns "".
func (s *FilesService) SaveText(filename, text string) (string, error) {
	if len(text) > MaxSaveTextBytes {
		return "", core.Errorf(core.CodeValidation, "That text is too big to save (over %d MB)", MaxSaveTextBytes>>20)
	}
	name := cleanSaveName(filename)
	dst, err := application.Get().Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		CanCreateDirectories: true,
		Title:                "Save as",
		Directory:            s.Settings.Current().LibraryDir,
		Filename:             name,
		ButtonText:           "Save",
	}).PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("save dialog: %w", err)
	}
	if dst == "" {
		return "", nil
	}
	if filepath.Ext(dst) == "" {
		dst += filepath.Ext(name)
	}
	if err := writeAtomic(dst, strings.NewReader(text)); err != nil {
		return "", err
	}
	return dst, nil
}

// cleanSaveName makes a suggested file name safe for a save dialog: no
// folders, no characters Windows refuses, never empty.
func cleanSaveName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	if name == "" || name == "_" {
		return "Untitled.txt"
	}
	return name
}
