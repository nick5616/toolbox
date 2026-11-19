package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
)

// windowsReserved are device names Windows refuses as file names; they are
// refused on every OS so a library stays portable.
var windowsReserved = map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}

func reservedName(name string) bool {
	base := name
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	base = strings.ToUpper(strings.TrimRight(base, " "))
	if windowsReserved[base] {
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9' {
		return true
	}
	return false
}

// realExt reports whether ext looks like a file extension the user meant
// (".png", not ".cool photo").
func realExt(ext string) bool {
	if len(ext) < 2 || len(ext) > 9 {
		return false
	}
	letter := false
	for _, r := range ext[1:] {
		isLetter := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z'
		if !(isLetter || r >= '0' && r <= '9') {
			return false
		}
		letter = letter || isLetter
	}
	return letter // ".2" in "v1.2" isn't an extension
}

// sanitizeRename turns what the user typed into a file name: separators and
// characters Windows forbids become "_", the original extension is kept
// unless one was given, reserved names are refused.
func sanitizeRename(newName, oldName string) (string, error) {
	name := strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, newName)
	name = strings.Trim(name, " .")
	if name == "" || strings.Trim(name, "_") == "" {
		return "", core.Errorf(core.CodeValidation, "Type a name for the file")
	}
	if !realExt(filepath.Ext(name)) {
		name += filepath.Ext(oldName)
	}
	if reservedName(name) {
		return "", core.Errorf(core.CodeValidation, "%q is a name Windows reserves; pick another", name)
	}
	if len(name) > 200 {
		return "", core.Errorf(core.CodeValidation, "That name is too long")
	}
	return name, nil
}

// inLibrary checks p is a regular path inside the library (never the support
// dir, never through a link).
func (s *LibraryService) inLibrary(p string) error {
	lib := s.libDir()
	if !core.IsWithin(p, lib) || core.IsWithin(p, s.Paths.SupportDir) || filepath.Clean(p) == filepath.Clean(lib) {
		return core.Errorf(core.CodeValidation, "That file isn't inside the library")
	}
	if underLink(lib, p) {
		return core.Errorf(core.CodeValidation, "Links aren't followed in the library")
	}
	return nil
}

// Rename renames an output's file in its folder (sanitised, never
// overwriting) and moves the output row. It emits library:added with the
// updated output (same ID).
func (s *LibraryService) Rename(outputID, newName string) (core.Output, error) {
	ctx := context.Background()
	o, err := s.existing(outputID)
	if err != nil {
		return o, err
	}
	if err := s.inLibrary(o.Path); err != nil {
		return o, err
	}
	name, err := sanitizeRename(newName, o.Name)
	if err != nil {
		return o, err
	}
	if name == filepath.Base(o.Path) {
		return o, nil
	}
	target := filepath.Join(filepath.Dir(o.Path), name)
	if ti, err := os.Lstat(target); err == nil {
		if si, serr := os.Stat(o.Path); serr != nil || !os.SameFile(si, ti) {
			return o, core.Errorf(core.CodeConflict, "%s already exists in that folder", name).WithHint("Pick another name")
		}
		// same file (a case-only rename on a case-insensitive disk)
	}
	if err := os.Rename(o.Path, target); err != nil {
		return o, core.Errorf(core.CodeConflict, "Couldn't rename %s", o.Name).WithCause(err)
	}
	moved, err := s.Outputs.MoveOutput(ctx, o.ID, target)
	if err != nil {
		_ = os.Rename(target, o.Path)
		return o, err
	}
	if s.Search != nil {
		s.Search.Renamed(o.Path, target)
	}
	if s.Em != nil {
		s.Em.Emit(core.EventLibraryAdded, moved)
	}
	return moved, nil
}

// Trash moves library files (by output ID or by path) to the Recycle Bin /
// Trash and forgets their outputs. Per-path problems are in Failed; library:
// removed is emitted for the forgotten outputs.
func (s *LibraryService) Trash(outputIDs []string, paths []string) (core.TrashResult, error) {
	res := core.TrashResult{Trashed: []string{}, Failed: map[string]string{}}
	if !s.TrashAvailable() {
		return res, core.Errorf(core.CodeConflict, "Moving files to the Trash isn't available here").
			WithHint("Use Show in folder and delete them there")
	}
	ctx := context.Background()
	type item struct{ path, id string }
	var items []item
	seen := map[string]bool{}
	add := func(p, id string) {
		k := pathKey(p)
		if seen[k] {
			return
		}
		seen[k] = true
		items = append(items, item{p, id})
	}
	for _, id := range outputIDs {
		o, err := s.Outputs.GetOutput(ctx, id)
		if err != nil {
			res.Failed[id] = "Not in the library"
			continue
		}
		add(o.Path, o.ID)
	}
	for _, p := range paths {
		add(filepath.Clean(p), "")
	}

	var toTrash []item
	for _, it := range items {
		if !filepath.IsAbs(it.path) {
			res.Failed[it.path] = "Not a full path"
			continue
		}
		if err := s.inLibrary(it.path); err != nil {
			res.Failed[it.path] = "Not inside the library"
			continue
		}
		info, err := os.Lstat(it.path)
		switch {
		case err != nil:
			if it.id != "" { // gone already: just forget it
				toTrash = append(toTrash, it)
			} else {
				res.Failed[it.path] = "It doesn't exist"
			}
		case info.IsDir():
			res.Failed[it.path] = "Folders can't be deleted from here"
		case !info.Mode().IsRegular():
			res.Failed[it.path] = "Not a regular file"
		default:
			toTrash = append(toTrash, it)
		}
	}

	var real []string
	for _, it := range toTrash {
		if _, err := os.Lstat(it.path); err == nil {
			real = append(real, it.path)
		}
	}
	errs := s.Trasher.Trash(real)
	failed := map[string]error{}
	for i, p := range real {
		if i < len(errs) && errs[i] != nil {
			failed[pathKey(p)] = errs[i]
		}
	}
	db, _ := s.db()
	var removed []string
	for _, it := range toTrash {
		if err := failed[pathKey(it.path)]; err != nil {
			res.Failed[it.path] = err.Error()
			continue
		}
		res.Trashed = append(res.Trashed, it.path)
		id := it.id
		if id == "" && db != nil {
			if o, ok, err := db.OutputByPath(ctx, it.path); err == nil && ok {
				id = o.ID
			}
		}
		if id != "" {
			if err := s.Outputs.DeleteOutput(ctx, id); err == nil {
				removed = append(removed, id)
			}
		}
	}
	if len(removed) > 0 && s.Em != nil {
		s.Em.Emit(core.EventLibraryRemoved, core.OutputsRemoved{IDs: removed})
	}
	if s.Search != nil && len(res.Trashed) > 0 {
		s.Search.Removed(res.Trashed...)
	}
	return res, nil
}

// SaveCopies asks for a folder and copies every output there (non-overwriting
// names). Cancelling returns "". Originals are never moved or changed.
func (s *LibraryService) SaveCopies(outputIDs []string) (string, error) {
	var srcs []string
	for _, id := range outputIDs {
		o, err := s.existing(id)
		if err != nil {
			return "", err
		}
		srcs = append(srcs, o.Path)
	}
	if len(srcs) == 0 {
		return "", nil
	}
	dir, err := application.Get().Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseDirectories: true,
		CanChooseFiles:       false,
		CanCreateDirectories: true,
		Title:                "Save copies to",
		ButtonText:           "Save here",
		Directory:            s.libDir(),
	}).PromptForSingleSelection()
	if err != nil {
		return "", fmt.Errorf("folder dialog: %w", err)
	}
	if dir == "" {
		return "", nil
	}
	return dir, copyAll(srcs, dir)
}

// copyAll copies each src into dir under a name that doesn't exist yet.
func copyAll(srcs []string, dir string) error {
	var failures []string
	for _, src := range srcs {
		if err := copyToNew(src, uniqueIn(dir, filepath.Base(src))); err != nil {
			failures = append(failures, filepath.Base(src))
		}
	}
	if len(failures) > 0 {
		return core.Errorf(core.CodeConflict, "Couldn't copy %d of %d files (%s)", len(failures), len(srcs), strings.Join(failures, ", "))
	}
	return nil
}

// uniqueIn returns dir/name, or dir/name (2).ext, … for the first free name.
func uniqueIn(dir, name string) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	p := filepath.Join(dir, name)
	for i := 2; ; i++ {
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
	}
}
