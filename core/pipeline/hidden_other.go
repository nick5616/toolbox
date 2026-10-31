//go:build !windows

package pipeline

func hiddenAttr(string) bool { return false }
