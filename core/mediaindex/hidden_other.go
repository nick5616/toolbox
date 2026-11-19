//go:build !windows

package mediaindex

// hasHiddenAttr has nothing extra to check outside Windows (dot-files are
// handled by hiddenName).
func hasHiddenAttr(string) bool { return false }
