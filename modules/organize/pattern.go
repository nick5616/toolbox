package organize

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"toolbox/core"
)

// Type folder names.
const (
	TypePhotos    = "Photos"
	TypeVideos    = "Videos"
	TypeAudio     = "Audio"
	TypeDocuments = "Documents"
	TypeOther     = "Other"
	UnknownCamera = "Unknown camera"
)

var rawExts = map[string]bool{".dng": true, ".cr2": true, ".cr3": true, ".nef": true, ".arw": true, ".raf": true, ".orf": true, ".rw2": true, ".heif": true}

// isPhoto reports whether the extension is a still photo (including camera RAW and HEIC).
func isPhoto(ext string) bool {
	ext = strings.ToLower(ext)
	return rawExts[ext] || core.KindForPath("x"+ext) == core.KindImage
}

// typeOf classifies a path into one of the Type folder names.
func typeOf(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if isPhoto(ext) {
		return TypePhotos
	}
	switch core.KindForPath(path) {
	case core.KindVideo:
		return TypeVideos
	case core.KindAudio:
		return TypeAudio
	case core.KindDocument:
		return TypeDocuments
	}
	return TypeOther
}

// patternVars are the values a folder pattern can use.
type patternVars struct {
	Taken  time.Time
	Type   string
	Camera string
	Ext    string // lowercase, no dot
}

var patternToken = regexp.MustCompile(`\{([^{}]*)\}`)

var knownTokens = map[string]bool{"yyyy": true, "mm": true, "dd": true, "type": true, "camera": true, "ext": true}

// validatePattern checks a folder pattern.
func validatePattern(p string) error {
	bad := func(msg string) error {
		return core.ValidationError(msg, map[string]string{"pattern": msg})
	}
	if strings.TrimSpace(p) == "" {
		return bad("Write a folder pattern, like {yyyy}/{mm}")
	}
	for _, m := range patternToken.FindAllStringSubmatch(p, -1) {
		if !knownTokens[m[1]] {
			return bad(fmt.Sprintf("{%s} isn't something the pattern can use. Use {yyyy} {mm} {dd} {type} {camera} {ext}", m[1]))
		}
	}
	if rest := patternToken.ReplaceAllString(p, ""); strings.ContainsAny(rest, "{}") {
		return bad("Unmatched { or } in the pattern")
	}
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) || strings.Contains(p, ":") {
		return bad("The pattern is a path inside the result folder, not a full path")
	}
	segs := patternSegments(p)
	if len(segs) == 0 {
		return bad("Write a folder pattern, like {yyyy}/{mm}")
	}
	if len(segs) > maxPatternDepth {
		return bad(fmt.Sprintf("Use at most %d folder levels", maxPatternDepth))
	}
	for _, s := range segs {
		if s == "." || s == ".." {
			return bad("A pattern can't use . or ..")
		}
	}
	return nil
}

func patternSegments(p string) []string {
	var out []string
	for _, s := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// sanitizeComponent makes s safe as one folder name on every OS.
func sanitizeComponent(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteByte('_')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimRight(strings.TrimSpace(b.String()), ". ")
	if utf8.RuneCountInString(out) > 80 {
		out = string([]rune(out)[:80])
		out = strings.TrimRight(out, ". ")
	}
	if out == "" {
		return "_"
	}
	return out
}

// expandPattern turns a pattern into a relative folder path using forward
// slashes ("" for no folders). Each token value is sanitised.
func expandPattern(pattern string, v patternVars) (string, error) {
	if err := validatePattern(pattern); err != nil {
		return "", err
	}
	var parts []string
	for _, seg := range patternSegments(pattern) {
		out := patternToken.ReplaceAllStringFunc(seg, func(tok string) string {
			switch tok[1 : len(tok)-1] {
			case "yyyy":
				return fmt.Sprintf("%04d", v.Taken.Year())
			case "mm":
				return fmt.Sprintf("%02d", int(v.Taken.Month()))
			case "dd":
				return fmt.Sprintf("%02d", v.Taken.Day())
			case "type":
				return v.Type
			case "camera":
				if v.Camera == "" {
					return UnknownCamera
				}
				return v.Camera
			case "ext":
				if v.Ext == "" {
					return "none"
				}
				return v.Ext
			}
			return tok
		})
		parts = append(parts, sanitizeComponent(out))
	}
	return strings.Join(parts, "/"), nil
}

// cameraName joins make and model without repeating the make.
func cameraName(make_, model string) string {
	make_, model = strings.TrimSpace(make_), strings.TrimSpace(model)
	switch {
	case model == "":
		return make_
	case make_ == "" || strings.HasPrefix(strings.ToLower(model), strings.ToLower(make_)):
		return model
	}
	return make_ + " " + model
}
