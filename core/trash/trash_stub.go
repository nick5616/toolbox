package trash

// platform is the OS implementation. CONTRACT STUB (Wave 0): L1 replaces
// this file with trash_windows.go (SHFileOperationW / IFileOperation with
// undo), trash_darwin.go (NSFileManager trashItemAtURL, cgo; cgo-less builds
// report ErrUnavailable) and trash_other.go.
type platform struct{}

func (platform) Available() bool { return false }

func (platform) Trash(paths []string) []error {
	errs := make([]error, len(paths))
	for i := range errs {
		errs[i] = ErrUnavailable
	}
	return errs
}
