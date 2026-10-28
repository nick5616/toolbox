package exif

import (
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Output name suffixes per action.
const (
	suffixStripLocation = " (no location)"
	suffixStripAll      = " (clean)"
	suffixEdit          = " (edited)"
)

func (a Action) suffix() string {
	switch a {
	case ActionStripLocation:
		return suffixStripLocation
	case ActionStripAll:
		return suffixStripAll
	case ActionEdit:
		return suffixEdit
	}
	return ""
}

// writableExtensions are the formats ExifTool can write metadata to.
// BMP has no metadata block; RAW formats are deliberately read-only here.
var writableExtensions = []string{".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tif", ".tiff"}

func isRaw(path string) bool {
	return slices.Contains(RawExtensions, strings.ToLower(filepath.Ext(path)))
}

func isWritable(path string) bool {
	return slices.Contains(writableExtensions, strings.ToLower(filepath.Ext(path)))
}

const maxValueLen = 2000

var dateTimeRe = regexp.MustCompile(`^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$`)

// normalizeField trims a value and normalises line endings.
func normalizeField(v string) string {
	v = strings.ReplaceAll(v, "\r\n", "\n")
	v = strings.ReplaceAll(v, "\r", "\n")
	return strings.TrimSpace(v)
}

// validateFields checks an edit's fields and returns a per-field error map.
func validateFields(fields map[string]string) map[string]string {
	bad := map[string]string{}
	known := EditableFields()
	n := 0
	for k, raw := range fields {
		if !slices.Contains(known, k) {
			bad[k] = "Unknown field"
			continue
		}
		n++
		v := normalizeField(raw)
		switch {
		case len([]rune(v)) > maxValueLen:
			bad[k] = fmt.Sprintf("Too long (max %d characters)", maxValueLen)
		case k != FieldDescription && strings.Contains(v, "\n"):
			bad[k] = "Can't contain line breaks"
		case k == FieldDateTimeOriginal && v != "" && !dateTimeRe.MatchString(v):
			bad[k] = "Use the format YYYY:MM:DD HH:MM:SS"
		}
	}
	if n == 0 && len(bad) == 0 {
		bad["fields"] = "Choose at least one field to change"
	}
	return bad
}

// htmlEscape escapes a value for ExifTool's -E option (which unescapes it
// again when writing) so a multi-line Description fits on one argument line.
func htmlEscape(v string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;", "\n", "&#10;").Replace(v)
}

// splitKeywords splits a comma-separated list, trimming and dropping empties.
func splitKeywords(v string) []string {
	var out []string
	for _, k := range strings.Split(v, ",") {
		if k = strings.TrimSpace(k); k != "" {
			out = append(out, k)
		}
	}
	return out
}

// buildArgs returns the ExifTool arguments (without the file arguments) for
// an action. The caller appends "-o <out> <in>". Never overwrites the input.
func buildArgs(o Options) []string {
	switch o.Action {
	case ActionStripLocation:
		return []string{"-gps:all=", "-xmp:geotag="}
	case ActionStripAll:
		args := []string{"-all="}
		if o.KeepOrientation {
			args = append(args, "-tagsFromFile", "@", "-Orientation", "-ICC_Profile")
		}
		return args
	case ActionEdit:
		return editArgs(o.Fields)
	}
	return nil
}

// editArgs builds the -Tag=value arguments in UI field order. Targets:
//
//	Title            XMP-dc:Title
//	Description      IFD0:ImageDescription + XMP-dc:Description
//	Artist           IFD0:Artist + XMP-dc:Creator
//	Copyright        IFD0:Copyright + XMP-dc:Rights
//	Keywords         XMP-dc:Subject + IPTC:Keywords (one assignment per keyword)
//	DateTimeOriginal ExifIFD:DateTimeOriginal
func editArgs(fields map[string]string) []string {
	vals := map[string]string{}
	multiline := false
	for k, v := range fields {
		v = normalizeField(v)
		vals[k] = v
		if strings.Contains(v, "\n") {
			multiline = true
		}
	}
	esc := func(s string) string { return s }
	var args []string
	if multiline {
		args = append(args, "-E")
		esc = htmlEscape
	}
	set := func(tag, v string) { args = append(args, "-"+tag+"="+esc(v)) }
	for _, name := range EditableFields() {
		v, ok := vals[name]
		if !ok {
			continue
		}
		switch name {
		case FieldTitle:
			set("XMP-dc:Title", v)
		case FieldDescription:
			set("IFD0:ImageDescription", v)
			set("XMP-dc:Description", v)
		case FieldArtist:
			set("IFD0:Artist", v)
			set("XMP-dc:Creator", v)
		case FieldCopyright:
			set("IFD0:Copyright", v)
			set("XMP-dc:Rights", v)
		case FieldKeywords:
			kws := splitKeywords(v)
			if len(kws) == 0 {
				set("XMP-dc:Subject", "")
				set("IPTC:Keywords", "")
				break
			}
			for _, k := range kws {
				set("XMP-dc:Subject", k)
			}
			for _, k := range kws {
				set("IPTC:Keywords", k)
			}
		case FieldDateTimeOriginal:
			set("ExifIFD:DateTimeOriginal", v)
		}
	}
	return args
}
