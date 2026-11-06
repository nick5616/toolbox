package paint

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/modules/paint/brushimport"
)

// BrushDialogs are the file dialogs brush import and export need. main.go
// sets them (modules never import Wails).
type BrushDialogs struct {
	// Open asks for brush files to import ("" list = cancelled).
	Open func() ([]string, error)
	// Save asks where to save a set export and returns "" when cancelled.
	Save func(defaultName string) (string, error)
}

// Brush storage (SPEC.md 1.3.2): <support>/paint/brushes/<set-id>/
//
//	set.json              {id, name, source, imported, order}
//	<brush-id>.json       the brush (frontend schema)
//	tips/<file>.png       tip images, referenced as "set:<set-id>/tips/<file>.png"
//	grains/<file>.png     grain images
//	raw/<brush-id>.json   settings an importer didn't map (kept for later)
//
// IDs are slugs, so nothing can escape the folder, and every write goes
// through a temporary file and a rename.

const (
	maxBrushJSON   = 512 << 10
	maxSetBrushes  = 2000
	setMetaFile    = "set.json"
	dataURLPNG     = "data:image/png;base64,"
	maxAssetBase64 = brushimport.MaxPNGBytes * 4 / 3
)

var (
	brushMu     sync.Mutex // one writer at a time over the brush folder
	assetFileRe = regexp.MustCompile(`^(tips|grains)/[a-z0-9][a-z0-9._-]{0,80}\.png$`)
)

func (m *Module) brushRoot() string { return filepath.Join(m.cfg.SupportDir, "paint", "brushes") }

func (m *Module) setDir(set string) string { return filepath.Join(m.brushRoot(), set) }

func checkSlug(what, id string) error {
	if !brushimport.SlugRe.MatchString(id) {
		return core.ValidationError(what+" isn't a valid name", map[string]string{strings.ToLower(what): id})
	}
	return nil
}

// ---- reading ----

func (m *Module) readSet(id string) (BrushSet, brushimport.SetMeta, error) {
	dir := m.setDir(id)
	meta := brushimport.SetMeta{ID: id, Name: id, Source: "user"}
	if b, err := os.ReadFile(filepath.Join(dir, setMetaFile)); err == nil {
		var onDisk brushimport.SetMeta
		if json.Unmarshal(b, &onDisk) == nil {
			if strings.TrimSpace(onDisk.Name) != "" {
				meta.Name = onDisk.Name
			}
			if onDisk.Source != "" {
				meta.Source = onDisk.Source
			}
			meta.Imported, meta.Order = onDisk.Imported, onDisk.Order
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return BrushSet{}, meta, fmt.Errorf("reading %s: %w", setMetaFile, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return BrushSet{}, meta, core.Errorf(core.CodeNotFound, "That brush set doesn't exist")
		}
		return BrushSet{}, meta, fmt.Errorf("reading brush set: %w", err)
	}
	infos := map[string]BrushInfo{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") || name == setMetaFile {
			continue
		}
		bid := strings.TrimSuffix(name, ".json")
		if !brushimport.SlugRe.MatchString(bid) {
			continue
		}
		var head struct{ Name, Credit, License string }
		if b, err := os.ReadFile(filepath.Join(dir, name)); err == nil && json.Unmarshal(b, &head) == nil {
			if head.Name == "" {
				head.Name = bid
			}
			infos[bid] = BrushInfo{ID: bid, Name: head.Name, Set: id, Credit: head.Credit, License: head.License}
		}
	}
	list := make([]BrushInfo, 0, len(infos))
	for _, bid := range meta.Order {
		if bi, ok := infos[bid]; ok {
			list = append(list, bi)
			delete(infos, bid)
		}
	}
	rest := make([]string, 0, len(infos))
	for bid := range infos {
		rest = append(rest, bid)
	}
	sort.Strings(rest)
	for _, bid := range rest {
		list = append(list, infos[bid])
	}
	return BrushSet{ID: id, Name: meta.Name, Source: meta.Source, Brushes: list, Imported: meta.Imported}, meta, nil
}

func (m *Module) brushSets() ([]BrushSet, error) {
	entries, err := os.ReadDir(m.brushRoot())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []BrushSet{}, nil
		}
		return []BrushSet{}, fmt.Errorf("listing brush sets: %w", err)
	}
	out := []BrushSet{}
	for _, e := range entries {
		if !e.IsDir() || !brushimport.SlugRe.MatchString(e.Name()) {
			continue
		}
		s, _, err := m.readSet(e.Name())
		if err != nil {
			continue // a broken folder shouldn't hide the others
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func (m *Module) brush(set, id string) (string, error) {
	if err := checkSlug("Set", set); err != nil {
		return "", err
	}
	if err := checkSlug("Brush", id); err != nil {
		return "", err
	}
	b, err := os.ReadFile(filepath.Join(m.setDir(set), id+".json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", core.Errorf(core.CodeNotFound, "That brush doesn't exist")
		}
		return "", fmt.Errorf("reading brush: %w", err)
	}
	return string(b), nil
}

// ---- writing ----

// (writeAtomic lives in files.go.)

func writeJSONAtomic(p string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(p, b)
}

// ensureSet makes the set folder and its set.json when missing and returns the
// metadata. display is the human name used for a new set.
func (m *Module) ensureSet(id, display string) (brushimport.SetMeta, error) {
	if _, meta, err := m.readSet(id); err == nil {
		return meta, nil
	} else if !core.IsCode(err, core.CodeNotFound) {
		return meta, err
	}
	name := strings.TrimSpace(display)
	if name == "" {
		name = id
	}
	meta := brushimport.SetMeta{ID: id, Name: name, Source: "user", Imported: time.Now().UnixMilli()}
	if err := writeJSONAtomic(filepath.Join(m.setDir(id), setMetaFile), meta); err != nil {
		return meta, fmt.Errorf("creating brush set: %w", err)
	}
	return meta, nil
}

// setIDFor accepts a set ID or a display name ("My brushes") and returns the
// slug ID and the name to show for a new set.
func setIDFor(set string) (id, display string, err error) {
	set = strings.TrimSpace(set)
	if set == "" {
		return "", "", core.ValidationError("Choose a brush set", map[string]string{"set": ""})
	}
	if brushimport.SlugRe.MatchString(set) {
		return set, "", nil
	}
	return brushimport.Slug(set), set, nil
}

func (m *Module) saveBrush(set, brushJSON string) (BrushInfo, error) {
	if len(brushJSON) > maxBrushJSON {
		return BrushInfo{}, core.ValidationError("That brush is too large", map[string]string{"brush": "size"})
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(brushJSON), &doc); err != nil {
		return BrushInfo{}, core.ValidationError("That isn't a brush", map[string]string{"brush": err.Error()})
	}
	name, _ := doc["name"].(string)
	if strings.TrimSpace(name) == "" {
		return BrushInfo{}, core.ValidationError("Give the brush a name", map[string]string{"name": ""})
	}
	setID, display, err := setIDFor(set)
	if err != nil {
		return BrushInfo{}, err
	}

	brushMu.Lock()
	defer brushMu.Unlock()
	meta, err := m.ensureSet(setID, display)
	if err != nil {
		return BrushInfo{}, err
	}
	id, _ := doc["id"].(string)
	if id == "" {
		base := brushimport.Slug(name)
		id = base
		for n := 2; fileExists(filepath.Join(m.setDir(setID), id+".json")); n++ {
			id = fmt.Sprintf("%s-%d", base, n)
		}
	} else if err := checkSlug("Brush", id); err != nil {
		return BrushInfo{}, err
	}
	if !contains(meta.Order, id) && len(meta.Order) >= maxSetBrushes {
		return BrushInfo{}, core.ValidationError("That set is full", map[string]string{"set": setID})
	}
	doc["id"], doc["set"] = id, setID
	if err := writeJSONAtomic(filepath.Join(m.setDir(setID), id+".json"), doc); err != nil {
		return BrushInfo{}, fmt.Errorf("saving brush: %w", err)
	}
	if !contains(meta.Order, id) {
		meta.Order = append(meta.Order, id)
		if err := writeJSONAtomic(filepath.Join(m.setDir(setID), setMetaFile), meta); err != nil {
			return BrushInfo{}, fmt.Errorf("saving brush set: %w", err)
		}
	}
	credit, _ := doc["credit"].(string)
	license, _ := doc["license"].(string)
	return BrushInfo{ID: id, Name: name, Set: setID, Credit: credit, License: license}, nil
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func contains(list []string, s string) bool {
	for _, e := range list {
		if e == s {
			return true
		}
	}
	return false
}

// saveBrushAsset stores a PNG data URL as a tip or grain of a user set and
// returns the reference to put in the brush ("set:<set>/tips/<hash>.png").
func (m *Module) saveBrushAsset(set, kind, pngDataURL string) (string, error) {
	dir := ""
	switch kind {
	case "tip":
		dir = "tips"
	case "grain":
		dir = "grains"
	default:
		return "", core.ValidationError("The image must be a tip or a grain", map[string]string{"kind": kind})
	}
	setID, display, err := setIDFor(set)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(pngDataURL, dataURLPNG) || len(pngDataURL) > maxAssetBase64+len(dataURLPNG) {
		return "", core.ValidationError("The image must be a PNG", map[string]string{"image": "format"})
	}
	data, err := base64.StdEncoding.DecodeString(pngDataURL[len(dataURLPNG):])
	if err != nil {
		return "", core.ValidationError("The image couldn't be read", map[string]string{"image": "encoding"})
	}
	if _, _, err := brushimport.ValidatePNG(data); err != nil {
		return "", core.ValidationError(capitalise(err.Error()), map[string]string{"image": "png"})
	}
	sum := sha256.Sum256(data)
	file := dir + "/" + hex.EncodeToString(sum[:8]) + ".png"

	brushMu.Lock()
	defer brushMu.Unlock()
	if _, err := m.ensureSet(setID, display); err != nil {
		return "", err
	}
	if err := writeAtomic(filepath.Join(m.setDir(setID), filepath.FromSlash(file)), data); err != nil {
		return "", fmt.Errorf("saving image: %w", err)
	}
	return "set:" + setID + "/" + file, nil
}

func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func (m *Module) deleteBrush(set, id string) error {
	if err := checkSlug("Set", set); err != nil {
		return err
	}
	brushMu.Lock()
	defer brushMu.Unlock()
	dir := m.setDir(set)
	if _, err := os.Stat(dir); err != nil {
		return core.Errorf(core.CodeNotFound, "That brush set doesn't exist")
	}
	if id == "" {
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("deleting brush set: %w", err)
		}
		return nil
	}
	if err := checkSlug("Brush", id); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(dir, id+".json")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return core.Errorf(core.CodeNotFound, "That brush doesn't exist")
		}
		return fmt.Errorf("deleting brush: %w", err)
	}
	_ = os.Remove(filepath.Join(dir, "raw", id+".json"))
	if _, meta, err := m.readSet(set); err == nil {
		meta.Order = remove(meta.Order, id)
		if err := writeJSONAtomic(filepath.Join(dir, setMetaFile), meta); err != nil {
			return fmt.Errorf("saving brush set: %w", err)
		}
	}
	m.collectAssets(set)
	return nil
}

func remove(list []string, s string) []string {
	out := list[:0:0]
	for _, e := range list {
		if e != s {
			out = append(out, e)
		}
	}
	return out
}

// collectAssets deletes tip and grain files no brush of the set refers to.
func (m *Module) collectAssets(set string) {
	dir := m.setDir(set)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var all strings.Builder
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") && e.Name() != setMetaFile {
			if b, err := os.ReadFile(filepath.Join(dir, e.Name())); err == nil {
				all.Write(b)
			}
		}
	}
	text := all.String()
	for _, sub := range []string{"tips", "grains"} {
		files, err := os.ReadDir(filepath.Join(dir, sub))
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() {
				continue
			}
			if !strings.Contains(text, "set:"+set+"/"+sub+"/"+f.Name()) {
				_ = os.Remove(filepath.Join(dir, sub, f.Name()))
			}
		}
	}
}

// brushAsset returns a tip or grain as a data URL. file is "tips/x.png" or a
// full reference "set:<set>/tips/x.png".
func (m *Module) brushAsset(set, file string) (string, error) {
	if err := checkSlug("Set", set); err != nil {
		return "", err
	}
	file = strings.TrimPrefix(file, "set:"+set+"/")
	if !assetFileRe.MatchString(file) {
		return "", core.ValidationError("That isn't a brush image", map[string]string{"file": file})
	}
	b, err := os.ReadFile(filepath.Join(m.setDir(set), filepath.FromSlash(file)))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", core.Errorf(core.CodeNotFound, "That brush image doesn't exist")
		}
		return "", fmt.Errorf("reading brush image: %w", err)
	}
	return dataURLPNG + base64.StdEncoding.EncodeToString(b), nil
}

// ---- dialogs, import, export ----

func (m *Module) pickBrushFiles() ([]string, error) {
	if m.cfg.Dialogs.Open == nil {
		return []string{}, core.Errorf(core.CodeInternal, "No file dialog is available")
	}
	paths, err := m.cfg.Dialogs.Open()
	if paths == nil {
		paths = []string{}
	}
	return paths, err
}

func (m *Module) importBrushes(ctx context.Context, paths []string) ([]BrushImportResult, error) {
	out := make([]BrushImportResult, 0, len(paths))
	for _, p := range paths {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		r := BrushImportResult{File: filepath.Base(p), Fidelity: []string{}}
		res, err := brushimport.ImportFile(p)
		if err != nil {
			r.Error = err.Error()
			out = append(out, r)
			continue
		}
		set, err := m.storeImported(res)
		if err != nil {
			r.Error = err.Error()
			out = append(out, r)
			continue
		}
		r.Set = set
		if res.Fidelity != nil {
			r.Fidelity = res.Fidelity
		}
		out = append(out, r)
	}
	return out, nil
}

// storeImported writes an imported set under a free ID, building it in a
// hidden folder first so a failure never leaves half a set.
func (m *Module) storeImported(res *brushimport.Result) (BrushSet, error) {
	brushMu.Lock()
	defer brushMu.Unlock()
	root := m.brushRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return BrushSet{}, err
	}
	base := brushimport.Slug(res.Set.Name)
	id := base
	for n := 2; fileExists(filepath.Join(root, id)); n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	if err := res.Set.Bind(id); err != nil {
		return BrushSet{}, err
	}
	tmp, err := os.MkdirTemp(root, ".import-")
	if err != nil {
		return BrushSet{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			os.RemoveAll(tmp)
		}
	}()
	meta := brushimport.SetMeta{ID: id, Name: res.Set.Name, Source: res.Set.Source, Imported: time.Now().UnixMilli()}
	for _, b := range res.Set.Brushes {
		if !brushimport.SlugRe.MatchString(b.ID) {
			return BrushSet{}, fmt.Errorf("brush %q has an unsafe ID", b.ID)
		}
		if err := writeAtomic(filepath.Join(tmp, b.ID+".json"), b.JSON); err != nil {
			return BrushSet{}, err
		}
		meta.Order = append(meta.Order, b.ID)
	}
	for name, data := range res.Set.Files {
		if !assetFileRe.MatchString(name) {
			return BrushSet{}, fmt.Errorf("image %q has an unsafe name", name)
		}
		if err := writeAtomic(filepath.Join(tmp, filepath.FromSlash(name)), data); err != nil {
			return BrushSet{}, err
		}
	}
	for bid, data := range res.Set.Raw {
		if !brushimport.SlugRe.MatchString(bid) {
			continue
		}
		if err := writeAtomic(filepath.Join(tmp, "raw", bid+".json"), data); err != nil {
			return BrushSet{}, err
		}
	}
	if err := writeJSONAtomic(filepath.Join(tmp, setMetaFile), meta); err != nil {
		return BrushSet{}, err
	}
	// Directory renames fail rather than overwrite, so a race can't merge two sets.
	if err := os.Rename(tmp, filepath.Join(root, id)); err != nil {
		return BrushSet{}, fmt.Errorf("saving brush set: %w", err)
	}
	cleanup = false
	set, _, err := m.readSet(id)
	return set, err
}

func (m *Module) exportBrushSet(set string) (string, error) {
	if err := checkSlug("Set", set); err != nil {
		return "", err
	}
	s, meta, err := m.readSet(set)
	if err != nil {
		return "", err
	}
	if m.cfg.Dialogs.Save == nil {
		return "", core.Errorf(core.CodeInternal, "No file dialog is available")
	}
	dest, err := m.cfg.Dialogs.Save(s.ID + brushimport.Ext)
	if err != nil {
		return "", err
	}
	if dest == "" {
		return "", nil
	}
	if !strings.EqualFold(filepath.Ext(dest), brushimport.Ext) {
		dest += brushimport.Ext
	}
	brushMu.Lock()
	defer brushMu.Unlock()
	if err := m.writeSetZip(set, meta, dest); err != nil {
		return "", fmt.Errorf("exporting brush set: %w", err)
	}
	return dest, nil
}

func (m *Module) writeSetZip(set string, meta brushimport.SetMeta, dest string) error {
	dir := m.setDir(set)
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(dest), ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(tmp)
		}
	}()
	zw := zip.NewWriter(f)
	put := func(name string, data []byte) error {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Unix(0, 0).UTC()})
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	metaJSON, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	if err := put(setMetaFile, metaJSON); err != nil {
		return err
	}
	walk := func(sub string, match func(name string) bool) error {
		entries, err := os.ReadDir(filepath.Join(dir, sub))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		for _, e := range entries {
			if e.IsDir() || !match(e.Name()) {
				continue
			}
			b, err := os.ReadFile(filepath.Join(dir, sub, e.Name()))
			if err != nil {
				return err
			}
			if err := put(path.Join(sub, e.Name()), b); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk("", func(n string) bool {
		return strings.HasSuffix(n, ".json") && n != setMetaFile && brushimport.SlugRe.MatchString(strings.TrimSuffix(n, ".json"))
	}); err != nil {
		return err
	}
	isPNG := func(n string) bool { return strings.HasSuffix(n, ".png") }
	for _, sub := range []string{"tips", "grains"} {
		if err := walk(sub, isPNG); err != nil {
			return err
		}
	}
	if err := walk("raw", func(n string) bool { return strings.HasSuffix(n, ".json") }); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		return err
	}
	ok = true
	return nil
}
