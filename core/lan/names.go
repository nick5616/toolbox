package lan

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

var errBadName = errors.New("lan: unsafe file name")

var windowsReserved = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// SanitizeComponent makes one path component safe on every OS (SPEC §4.5):
// NFC, no control characters or < > : " | ? * \, no leading/trailing spaces or
// dots, Windows reserved names get a "_", empty becomes "file". "." and ".."
// are refused with an error.
func SanitizeComponent(s string) (string, error) {
	if s == "." || s == ".." {
		return "", fmt.Errorf("%w: %q", errBadName, s)
	}
	s = norm.NFC.String(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == utf8.RuneError, unicode.IsControl(r):
		case strings.ContainsRune(`<>:"|?*\/`, r):
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), " .")
	if out == "" {
		return "file", nil
	}
	stem, rest := out, ""
	if i := strings.IndexByte(out, '.'); i >= 0 {
		stem, rest = out[:i], out[i:]
	}
	if windowsReserved[strings.ToUpper(strings.TrimRight(stem, " "))] {
		out = stem + "_" + rest
	}
	return truncateBytes(out, MaxNameBytes), nil
}

// truncateBytes cuts s to at most n bytes on a rune boundary, keeping a short extension.
func truncateBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	ext := filepath.Ext(s)
	if len(ext) > 16 {
		ext = ""
	}
	cut := n - len(ext)
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	out := strings.TrimRight(s[:cut], " .")
	if out == "" {
		out = "file"
	}
	return out + ext
}

// SanitizePath sanitises a relative path as sent by a peer ("Trip/IMG_1.jpg").
// It splits on "/" (and "\"), skips empty components, refuses "." and ".."
// and anything deeper than MaxPathDepth. The result uses "/" and is never empty.
func SanitizePath(rel string) (string, error) {
	rel = strings.ReplaceAll(rel, "\\", "/")
	var parts []string
	for _, c := range strings.Split(rel, "/") {
		if c == "" {
			continue
		}
		s, err := SanitizeComponent(c)
		if err != nil {
			return "", err
		}
		parts = append(parts, s)
	}
	if len(parts) == 0 {
		return "file", nil
	}
	if len(parts) > MaxPathDepth {
		return "", fmt.Errorf("%w: path too deep", errBadName)
	}
	return strings.Join(parts, "/"), nil
}

// SafeFolderName sanitises a device alias for use as a folder name; it never fails.
func SafeFolderName(alias string) string {
	s, err := SanitizeComponent(strings.TrimSpace(alias))
	if err != nil {
		return "device"
	}
	return s
}

// UniqueName returns name, or "name (2).ext", "name (3).ext", … so that
// dir/name doesn't exist yet. name may contain "/" subfolders.
func UniqueName(dir, name string) string {
	exists := func(n string) bool {
		_, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(n)))
		return err == nil
	}
	if !exists(name) {
		return name
	}
	slash := strings.LastIndexByte(name, '/')
	prefix, base := name[:slash+1], name[slash+1:]
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" {
		stem, ext = base, ""
	}
	for i := 2; ; i++ {
		cand := fmt.Sprintf("%s%s (%d)%s", prefix, stem, i, ext)
		if !exists(cand) {
			return cand
		}
	}
}
