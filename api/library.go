package api

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// Library browser (Phase 19, SPEC.md §3.2). Rules: ListDir, Rename and Trash
// refuse anything outside the library (core.IsWithin) and never follow
// symlinks or junctions; Trash never touches the support dir.

// libraryDB is the part of the output store the Library browser needs beyond
// core.OutputStore (core/store.DB implements it).
type libraryDB interface {
	QueryLibrary(ctx context.Context, q core.LibraryQuery, libraryDir string) (core.OutputPage, error)
	OutputByPath(ctx context.Context, path string) (core.Output, bool, error)
	OutputsByPaths(ctx context.Context, paths []string) ([]core.Output, error)
	OutputModulesUnder(ctx context.Context, dir string) (map[string]string, error)
}

func (s *LibraryService) db() (libraryDB, error) {
	db, ok := s.Outputs.(libraryDB)
	if !ok {
		return nil, core.Errorf(core.CodeInternal, "The library database can't be browsed")
	}
	return db, nil
}

func (s *LibraryService) libDir() string { return s.Settings.Current().LibraryDir }

// Query pages through outputs with server-side filters (supersedes Recent
// for the Library view). The cursor is opaque and only valid with the same
// sort.
func (s *LibraryService) Query(q core.LibraryQuery) (core.OutputPage, error) {
	db, err := s.db()
	if err != nil {
		return core.OutputPage{Items: []core.Output{}}, err
	}
	page, err := db.QueryLibrary(context.Background(), q, s.libDir())
	if page.Items == nil {
		page.Items = []core.Output{}
	}
	return page, err
}

// Folders returns the library folder tree (depth ≤ 6) with counts.
func (s *LibraryService) Folders() (core.LibraryFolder, error) {
	return s.folders(context.Background())
}

// ListDir lists one library folder's files and subfolders (≤ limit, max
// 5000), joined with registered outputs by path.
func (s *LibraryService) ListDir(rel string, limit int) (core.LibraryListing, error) {
	return s.listDir(context.Background(), rel, limit)
}

// Detail describes one file: by output ID, or by absolute path inside the
// library (unregistered files).
func (s *LibraryService) Detail(outputIDOrPath string) (core.OutputDetail, error) {
	return s.detail(context.Background(), outputIDOrPath)
}

// Places lists projects (every kind) and saved masks.
func (s *LibraryService) Places() (core.LibraryPlaces, error) {
	return s.places(context.Background())
}

// TrashAvailable says whether Delete can move files to the OS trash here.
func (s *LibraryService) TrashAvailable() bool { return s.Trasher != nil && s.Trasher.Available() }

// pathKey normalises a path for case-insensitive lookups.
func pathKey(p string) string { return strings.ToLower(filepath.Clean(p)) }

// isLinkPath reports whether path itself is a symlink, junction or other
// reparse point (it is not followed).
func isLinkPath(path string) bool {
	info, err := os.Lstat(path)
	if err != nil {
		return false
	}
	link, _ := linkAttrs(info)
	return link
}

// underLink reports whether path (inside lib) is, or passes through, a link
// below lib. Missing components are not links.
func underLink(lib, path string) bool {
	rel, err := filepath.Rel(filepath.Clean(lib), filepath.Clean(path))
	if err != nil || rel == "." {
		return false
	}
	cur := filepath.Clean(lib)
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		cur = filepath.Join(cur, part)
		if isLinkPath(cur) {
			return true
		}
	}
	return false
}
