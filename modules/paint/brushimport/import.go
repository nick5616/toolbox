package brushimport

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// Ext is the extension of Paint+'s own brush set export.
const Ext = ".paintplus-brushes"

// Supported lists the file extensions ImportFile reads.
var Supported = []string{".brushset", ".brush", ".myb", ".abr", ".bundle", Ext}

// ImportFile reads one brush file by its extension.
func ImportFile(p string) (*Result, error) {
	ext := strings.ToLower(filepath.Ext(p))
	info, err := os.Stat(p)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", filepath.Base(p), err)
	}
	if info.IsDir() {
		return nil, errors.New("that's a folder, not a brush file")
	}
	if info.Size() > 2*MaxZipTotal {
		return nil, fmt.Errorf("the file is larger than %d MB", 2*MaxZipTotal>>20)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", filepath.Base(p), err)
	}
	return Import(data, filepath.Base(p), ext)
}

// Import reads brush data of the kind named by ext (".brushset", ".myb", ...).
func Import(data []byte, fileName, ext string) (*Result, error) {
	switch strings.ToLower(ext) {
	case ".brushset", ".brush":
		return ParseProcreate(data, fileName)
	case ".myb":
		name := strings.TrimSuffix(fileName, filepath.Ext(fileName))
		p, notes, err := ParseMyb(prettyName(name), data)
		if err != nil {
			return nil, err
		}
		res := &Result{Set: Set{Name: prettyName(name), Source: SourceMyPaint, Files: map[string][]byte{}}, Fidelity: notes}
		if err := res.Set.add(p); err != nil {
			return nil, err
		}
		return res, nil
	case ".abr":
		return ParseABR(data, fileName)
	case ".bundle":
		return ParseKritaBundle(data, fileName)
	case Ext:
		return ParsePaintPlus(data, fileName)
	}
	return nil, fmt.Errorf("%s isn't a brush file Paint+ can read (use .brushset, .brush, .myb, .abr, .bundle or %s)", fileName, Ext)
}

func prettyName(s string) string {
	s = strings.TrimSpace(strings.NewReplacer("_", " ").Replace(s))
	if s == "" {
		return "Brush"
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// SetMeta is set.json inside a .paintplus-brushes zip (and on disk).
type SetMeta struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Source   string   `json:"source"`
	Imported int64    `json:"imported"`
	Order    []string `json:"order,omitempty"`
}

func validSource(s string) bool {
	switch s {
	case SourceProcreate, SourceMyPaint, SourceABR, SourceKrita, SourcePaintPlus, "user":
		return true
	}
	return false
}

// ParsePaintPlus reads Paint+'s own export: set.json, one JSON per brush,
// tips/*.png and grains/*.png (and raw/*.json).
func ParsePaintPlus(data []byte, fileName string) (*Result, error) {
	files, err := ReadZip(data)
	if err != nil {
		return nil, err
	}
	var meta SetMeta
	if b, ok := files["set.json"]; ok {
		if err := json.Unmarshal(b, &meta); err != nil {
			return nil, fmt.Errorf("set.json: %w", err)
		}
	}
	if strings.TrimSpace(meta.Name) == "" {
		meta.Name = strings.TrimSuffix(fileName, filepath.Ext(fileName))
	}
	source := SourcePaintPlus
	if validSource(meta.Source) && meta.Source != "user" {
		source = meta.Source
	}
	res := &Result{Set: Set{Name: meta.Name, Source: source, Files: map[string][]byte{}, Raw: map[string][]byte{}}}
	var n notes
	names := make([]string, 0, len(files))
	for k := range files {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, name := range names {
		dir, file := path.Split(name)
		switch {
		case dir == "" && strings.HasSuffix(name, ".json") && name != "set.json":
			var doc map[string]any
			if err := json.Unmarshal(files[name], &doc); err != nil {
				n.add("%s was skipped: %v.", name, err)
				continue
			}
			id, _ := doc["id"].(string)
			if !SlugRe.MatchString(id) {
				n.add("%s was skipped: it has no valid id.", name)
				continue
			}
			if meta.ID != "" {
				rebindRefs(doc, meta.ID)
			}
			doc["set"] = "@"
			out, err := json.Marshal(doc)
			if err != nil {
				return nil, err
			}
			bname, _ := doc["name"].(string)
			credit, _ := doc["credit"].(string)
			license, _ := doc["license"].(string)
			res.Set.Brushes = append(res.Set.Brushes, Brush{ID: id, Name: bname, Credit: credit, License: license, JSON: out})
		case (dir == "tips/" || dir == "grains/") && strings.HasSuffix(file, ".png"):
			if _, _, err := ValidatePNG(files[name]); err != nil {
				n.add("%s was skipped: %v.", name, err)
				continue
			}
			res.Set.Files[name] = files[name]
		case dir == "raw/" && strings.HasSuffix(file, ".json"):
			res.Set.Raw[strings.TrimSuffix(file, ".json")] = files[name]
		}
	}
	if len(res.Set.Brushes) == 0 {
		return nil, errors.New("no brushes found in this file")
	}
	res.Fidelity = n.list
	return res, nil
}

// rebindRefs turns "set:<oldID>/..." references into the "set:@/" placeholder.
func rebindRefs(v any, oldID string) {
	prefix := "set:" + oldID + "/"
	fix := func(s string) (string, bool) {
		if strings.HasPrefix(s, prefix) {
			return "set:@/" + strings.TrimPrefix(s, prefix), true
		}
		return s, false
	}
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			if s, ok := e.(string); ok {
				if r, changed := fix(s); changed {
					t[k] = r
				}
				continue
			}
			rebindRefs(e, oldID)
		}
	case []any:
		for i, e := range t {
			if s, ok := e.(string); ok {
				if r, changed := fix(s); changed {
					t[i] = r
				}
				continue
			}
			rebindRefs(e, oldID)
		}
	}
}
