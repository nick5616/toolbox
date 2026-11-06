package api

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

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
	tmp, err := os.CreateTemp(filepath.Dir(da), ".toolbox-copy-*")
	if err != nil {
		return core.Errorf(core.CodeConflict, "Can't write to %s", filepath.Dir(da)).WithCause(err)
	}
	tmpName := tmp.Name()
	_, cerr := io.Copy(tmp, in)
	if err := tmp.Close(); cerr == nil {
		cerr = err
	}
	if cerr != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("copying %s: %w", filepath.Base(sa), cerr)
	}
	if err := os.Rename(tmpName, da); err != nil {
		_ = os.Remove(tmpName)
		return core.Errorf(core.CodeConflict, "Can't save %s", filepath.Base(da)).WithCause(err)
	}
	return nil
}
