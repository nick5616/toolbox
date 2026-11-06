//go:build !windows && (!darwin || !cgo)

package trash

// platform has no OS trash here (Linux, or macOS built without cgo).
type platform struct{}

func (platform) Available() bool { return false }

func (platform) Trash(paths []string) []error {
	errs := make([]error, len(paths))
	for i := range errs {
		errs[i] = ErrUnavailable
	}
	return errs
}
