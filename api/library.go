package api

import "toolbox/core"

// Library browser (Phase 19, SPEC.md §3.2). CONTRACT STUB (Wave 0): L1
// implements every method here (and may split helpers into api/library_*.go).
// Rules: ListDir, Rename and Trash refuse anything outside the library
// (core.IsWithin) and never follow symlinks or junctions; Trash never touches
// the support dir.

// Query pages through outputs with server-side filters (supersedes Recent
// for the Library view).
func (s *LibraryService) Query(q core.LibraryQuery) (core.OutputPage, error) {
	return core.OutputPage{Items: []core.Output{}}, core.NotImplemented("Library query")
}

// Folders returns the library folder tree (depth ≤ 6) with counts.
func (s *LibraryService) Folders() (core.LibraryFolder, error) {
	return core.LibraryFolder{Children: []core.LibraryFolder{}, ModuleIDs: []string{}}, core.NotImplemented("Library folders")
}

// ListDir lists one library folder's files and subfolders (≤ limit, max
// 5000), joined with registered outputs by path.
func (s *LibraryService) ListDir(rel string, limit int) (core.LibraryListing, error) {
	return core.LibraryListing{Entries: []core.LibraryEntry{}}, core.NotImplemented("Library folder listing")
}

// Detail describes one file: by output ID, or by absolute path inside the
// library (unregistered files).
func (s *LibraryService) Detail(outputIDOrPath string) (core.OutputDetail, error) {
	return core.OutputDetail{MadeFrom: []string{}, MadeInto: []core.Output{}, Chain: []core.Output{}}, core.NotImplemented("Library detail")
}

// Places lists projects (every kind) and saved masks.
func (s *LibraryService) Places() (core.LibraryPlaces, error) {
	return core.LibraryPlaces{Projects: []core.LibraryProject{}, SavedMasks: []core.LibrarySavedMask{}}, core.NotImplemented("Library places")
}

// Rename renames an output's file in its folder (sanitised, never
// overwriting) and moves the output row.
func (s *LibraryService) Rename(outputID, newName string) (core.Output, error) {
	return core.Output{}, core.NotImplemented("Rename")
}

// TrashAvailable says whether Delete can move files to the OS trash here.
func (s *LibraryService) TrashAvailable() bool { return s.Trasher != nil && s.Trasher.Available() }

// Trash moves library files (by output ID or by path) to the Recycle Bin /
// Trash and forgets their outputs.
func (s *LibraryService) Trash(outputIDs []string, paths []string) (core.TrashResult, error) {
	return core.TrashResult{Trashed: []string{}, Failed: map[string]string{}}, core.NotImplemented("Delete to trash")
}

// SaveCopies asks for a folder and copies every output there (non-overwriting
// names). Cancelling returns "".
func (s *LibraryService) SaveCopies(outputIDs []string) (string, error) {
	return "", core.NotImplemented("Save copies")
}
