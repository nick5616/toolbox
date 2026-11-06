//go:build !windows

package organize

import "io/fs"

// systemEntry has nothing extra to check outside Windows (dot-files are
// handled by skipName).
func systemEntry(string, fs.DirEntry) bool { return false }
