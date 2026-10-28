package exif

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// tagEntry is one "Group:Tag" value of ExifTool's JSON, in file order.
type tagEntry struct {
	Group, Tag string
	Value      any // string, json.Number, bool, []any, map[string]any
}

// parseJSON parses `exiftool -j -G1` output (a one-element array) keeping
// the tag order. SourceFile is dropped.
func parseJSON(data string) ([]tagEntry, error) {
	dec := json.NewDecoder(strings.NewReader(data))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("parse exiftool output: %w", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '[' {
		return nil, fmt.Errorf("parse exiftool output: expected an array")
	}
	if !dec.More() {
		return nil, fmt.Errorf("parse exiftool output: empty result")
	}
	if tok, err = dec.Token(); err != nil {
		return nil, fmt.Errorf("parse exiftool output: %w", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("parse exiftool output: expected an object")
	}
	var out []tagEntry
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("parse exiftool output: %w", err)
		}
		key, _ := kt.(string)
		var v any
		if err := dec.Decode(&v); err != nil {
			return nil, fmt.Errorf("parse exiftool output: %w", err)
		}
		group, tag, ok := strings.Cut(key, ":")
		if !ok {
			continue // SourceFile
		}
		out = append(out, tagEntry{Group: group, Tag: tag, Value: v})
	}
	return out, nil
}

var binaryRe = regexp.MustCompile(`^\(Binary data (\d+) bytes`)

// stringify renders a JSON value for display.
func stringify(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		if m := binaryRe.FindStringSubmatch(x); m != nil {
			return "(binary, " + m[1] + " bytes)"
		}
		return x
	case json.Number:
		return x.String()
	case bool:
		if x {
			return "True"
		}
		return "False"
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = stringify(e)
		}
		return strings.Join(parts, ", ")
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = k + ": " + stringify(x[k])
		}
		return strings.Join(parts, "; ")
	}
	return fmt.Sprint(v)
}

// humanLabel splits CamelCase tag names: "DateTimeOriginal" → "Date Time
// Original", "GPSLatitude" → "GPS Latitude", "FNumber" → "F Number".
func humanLabel(tag string) string {
	r := []rune(tag)
	var b strings.Builder
	for i, c := range r {
		if i > 0 && unicode.IsUpper(c) {
			prev := r[i-1]
			nextLower := i+1 < len(r) && unicode.IsLower(r[i+1])
			if unicode.IsLower(prev) || unicode.IsDigit(prev) || (unicode.IsUpper(prev) && nextLower) {
				b.WriteByte(' ')
			}
		}
		b.WriteRune(c)
	}
	return b.String()
}

var makerGroups = map[string]bool{
	"MakerNotes": true, "Canon": true, "Nikon": true, "Sony": true, "Olympus": true, "Pentax": true,
	"Panasonic": true, "FujiFilm": true, "Samsung": true, "Apple": true, "Casio": true, "Minolta": true,
	"Ricoh": true, "Sigma": true, "Leica": true, "DJI": true, "GoPro": true, "Kodak": true, "FLIR": true,
	"HP": true, "Google": true, "Sanyo": true, "Motorola": true, "Reconyx": true, "Phase One": true,
}

// collapsedByDefault groups are noisy and start collapsed in the inspector.
func collapsedByDefault(g string) bool {
	return makerGroups[g] || strings.HasPrefix(g, "MakerNotes") || g == "ICC_Profile" ||
		g == "Photoshop" || g == "ExifTool"
}

// groupRank orders groups: File, IFD0, ExifIFD, GPS, XMP-*, IPTC,
// ICC_Profile, MakerNotes, Composite, then everything else alphabetically.
func groupRank(g string) int {
	switch {
	case g == "File":
		return 0
	case g == "IFD0":
		return 1
	case g == "ExifIFD":
		return 2
	case g == "GPS":
		return 3
	case strings.HasPrefix(g, "XMP"):
		return 4
	case g == "IPTC":
		return 5
	case g == "ICC_Profile":
		return 6
	case makerGroups[g] || strings.HasPrefix(g, "MakerNotes"):
		return 7
	case g == "Composite":
		return 8
	}
	return 9
}

// buildGroups groups tags in the order of the spec; fields keep file order.
func buildGroups(entries []tagEntry) []MetaGroup {
	byName := map[string]*MetaGroup{}
	var names []string
	for _, e := range entries {
		g := e.Group
		if g == "System" {
			g = "File"
		}
		mg, ok := byName[g]
		if !ok {
			mg = &MetaGroup{Name: g, Collapsed: collapsedByDefault(g), Fields: []MetaField{}}
			byName[g] = mg
			names = append(names, g)
		}
		mg.Fields = append(mg.Fields, MetaField{Tag: e.Group + ":" + e.Tag, Label: humanLabel(e.Tag), Value: stringify(e.Value)})
	}
	sort.SliceStable(names, func(i, j int) bool {
		ri, rj := groupRank(names[i]), groupRank(names[j])
		if ri != rj {
			return ri < rj
		}
		return names[i] < names[j]
	})
	out := make([]MetaGroup, 0, len(names))
	for _, n := range names {
		out = append(out, *byName[n])
	}
	return out
}

// lookup returns the display value of the first present "Group:Tag" key
// (an empty group matches any group).
func lookup(entries []tagEntry, keys ...string) (string, bool) {
	for _, k := range keys {
		g, t, _ := strings.Cut(k, ":")
		for _, e := range entries {
			if e.Tag == t && (g == "" || e.Group == g) {
				if s := stringify(e.Value); s != "" {
					return s, true
				}
			}
		}
	}
	return "", false
}

func lookupNum(entries []tagEntry, group, tag string) (float64, bool) {
	for _, e := range entries {
		if e.Group == group && e.Tag == tag {
			switch x := e.Value.(type) {
			case json.Number:
				f, err := x.Float64()
				return f, err == nil
			case string:
				f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
				return f, err == nil
			}
		}
	}
	return 0, false
}

func refString(entries []tagEntry, group, tag string) string {
	for _, e := range entries {
		if e.Group == group && e.Tag == tag {
			return strings.ToUpper(strings.TrimSpace(stringify(e.Value)))
		}
	}
	return ""
}

// extractLocation reads decimal coordinates from a `-n` pass: the signed
// Composite values when present, else GPS:* with their N/S/E/W refs.
func extractLocation(entries []tagEntry) *GeoPoint {
	lat, okLat := lookupNum(entries, "Composite", "GPSLatitude")
	lon, okLon := lookupNum(entries, "Composite", "GPSLongitude")
	if !okLat || !okLon {
		lat, okLat = lookupNum(entries, "GPS", "GPSLatitude")
		lon, okLon = lookupNum(entries, "GPS", "GPSLongitude")
		if !okLat || !okLon {
			return nil
		}
		if refString(entries, "GPS", "GPSLatitudeRef") == "S" {
			lat = -math.Abs(lat)
		}
		if refString(entries, "GPS", "GPSLongitudeRef") == "W" {
			lon = -math.Abs(lon)
		}
	}
	if math.IsNaN(lat) || math.IsNaN(lon) || math.Abs(lat) > 90 || math.Abs(lon) > 180 {
		return nil
	}
	p := &GeoPoint{Lat: lat, Lon: lon}
	if alt, ok := lookupNum(entries, "Composite", "GPSAltitude"); ok {
		p.Altitude, p.HasAltitude = alt, true
	} else if alt, ok := lookupNum(entries, "GPS", "GPSAltitude"); ok {
		if ref := refString(entries, "GPS", "GPSAltitudeRef"); ref == "1" || strings.HasPrefix(ref, "BELOW") {
			alt = -math.Abs(alt)
		}
		p.Altitude, p.HasAltitude = alt, true
	}
	return p
}

// buildView assembles the inspector model from the display pass (pretty)
// and the numeric pass (num, may be nil).
func buildView(path string, size int64, pretty, num []tagEntry) MetadataView {
	v := MetadataView{
		Path: path, Name: filepath.Base(path), SizeBytes: size,
		Groups: buildGroups(pretty), Fields: map[string]string{},
		Editable: isWritable(path),
	}
	v.Make, _ = lookup(pretty, "IFD0:Make", ":Make")
	v.Model, _ = lookup(pretty, "IFD0:Model", ":Model")
	v.DateTaken, _ = lookup(pretty, "ExifIFD:DateTimeOriginal", "XMP-exif:DateTimeOriginal", ":DateTimeOriginal", "ExifIFD:CreateDate", ":CreateDate")
	if num == nil {
		num = pretty
	}
	if loc := extractLocation(num); loc != nil {
		v.HasLocation, v.Location = true, loc
	}
	for field, keys := range map[string][]string{
		FieldTitle:            {"XMP-dc:Title", "IPTC:ObjectName", "PNG:Title"},
		FieldDescription:      {"XMP-dc:Description", "IFD0:ImageDescription", "PNG:Description"},
		FieldArtist:           {"XMP-dc:Creator", "IFD0:Artist", "IPTC:By-line", "PNG:Author"},
		FieldCopyright:        {"XMP-dc:Rights", "IFD0:Copyright", "IPTC:CopyrightNotice", "PNG:Copyright"},
		FieldKeywords:         {"XMP-dc:Subject", "IPTC:Keywords"},
		FieldDateTimeOriginal: {"ExifIFD:DateTimeOriginal"},
	} {
		s, _ := lookup(pretty, keys...)
		v.Fields[field] = s
	}
	return v
}

// countTags counts file-intrinsic-free tags (everything except the derived
// File/System/ExifTool/Composite groups) for before/after comparisons.
func countTags(entries []tagEntry) int {
	n := 0
	for _, e := range entries {
		switch e.Group {
		case "File", "System", "ExifTool", "Composite":
		default:
			n++
		}
	}
	return n
}

// fileSize returns a file's size (0 on error).
func fileSize(path string) int64 {
	if fi, err := os.Stat(path); err == nil {
		return fi.Size()
	}
	return 0
}

// sanitizeJSON drops anything before the first '[' (ExifTool may print
// warnings on stdout in some versions).
func sanitizeJSON(s string) string {
	if i := strings.IndexByte(s, '['); i > 0 {
		return s[i:]
	}
	return s
}
