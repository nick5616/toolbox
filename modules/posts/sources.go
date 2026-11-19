package posts

import (
	"context"
	"encoding/binary"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/media"
)

// The post's source pool (SPEC.md §B13).

const (
	maxPoolEntries = 5000      // Extra / Hidden entries per post
	exifDateScan   = 128 << 10 // bytes of a JPEG read for its date
	tagExifPointer = 0x8769    // IFD0 -> Exif IFD
	tagDateOrig    = 0x9003    // DateTimeOriginal
	exifDateLayout = "2006:01:02 15:04:05"
)

// pathKey normalises a path for comparisons (case-insensitive on Windows).
func pathKey(p string) string {
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

func (m *Module) libraryDir() string {
	// Always the open workspace's library (Phase 21 §A6b): never a default
	// like ~/Toolbox, which would be Personal's library inside another workspace.
	if m.cfg.LibraryDir != nil {
		return m.cfg.LibraryDir()
	}
	return ""
}

// sourceKind returns "photo", "clip" or "" by extension.
func sourceKind(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch {
	case slices.Contains(media.ImageExtensions(), ext):
		return "photo"
	case slices.Contains(media.VideoExtensions(), ext):
		return "clip"
	}
	return ""
}

// CreateFromFolder makes a post whose source pool is folder (no slides yet).
func (s *Service) CreateFromFolder(name, format, aspect, folder string, subfolders bool) (core.ProjectInfo, error) {
	aspect, err := normalizeFormat(format, aspect)
	if err != nil {
		return core.ProjectInfo{}, err
	}
	bad := func(msg string) (core.ProjectInfo, error) {
		return core.ProjectInfo{}, core.ValidationError(msg, map[string]string{"folder": msg})
	}
	if !filepath.IsAbs(folder) {
		return bad("Choose a source folder")
	}
	folder = filepath.Clean(folder)
	fi, err := os.Stat(folder)
	if err != nil {
		return bad("That folder doesn't exist")
	}
	if !fi.IsDir() {
		return bad("That isn't a folder")
	}
	if lib := s.m.libraryDir(); lib != "" && core.IsWithin(folder, lib) {
		return bad("Choose a folder outside the Library")
	}
	doc := Post{Version: 1, Format: format, Aspect: aspect, Slides: []Slide{}, Folder: folder, Subfolders: subfolders, Extra: []string{}, Hidden: []string{}}
	return s.m.docs.Create(context.Background(), name, doc)
}

// Sources lists the post's source pool with usage (SPEC.md §B13.3).
func (s *Service) Sources(id string) ([]SourceFile, error) {
	ctx := context.Background()
	doc, err := projectdocsGet(s.m, id)
	if err != nil {
		return []SourceFile{}, err
	}
	pool, err := s.m.pool(ctx, doc, true)
	if err != nil {
		return []SourceFile{}, err
	}
	return pool, nil
}

// pool builds the source list. withDates reads JPEG EXIF dates (Sources);
// Check skips it.
func (m *Module) pool(ctx context.Context, doc Post, withDates bool) ([]SourceFile, error) {
	hidden := make(map[string]bool, len(doc.Hidden))
	for _, h := range doc.Hidden {
		hidden[pathKey(h)] = true
	}
	seen := map[string]bool{}
	out := []SourceFile{}
	add := func(sf SourceFile) {
		k := pathKey(sf.Path)
		if seen[k] || hidden[k] {
			return
		}
		seen[k] = true
		out = append(out, sf)
	}
	if doc.Folder != "" {
		root := filepath.Clean(doc.Folder)
		if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
			return []SourceFile{}, core.Errorf(core.CodeNotFound, "The source folder isn't there any more").WithHint("Choose it again")
		}
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if d.IsDir() {
				if p != root && (!doc.Subfolders || strings.HasPrefix(d.Name(), ".")) {
					return fs.SkipDir
				}
				return nil
			}
			kind := sourceKind(p)
			if kind == "" {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(root, p)
			add(newSource(p, rel, kind, info, withDates))
			return nil
		})
		if err != nil {
			return []SourceFile{}, err
		}
	}
	for _, p := range doc.Extra {
		kind := sourceKind(p)
		if kind == "" {
			continue
		}
		info, err := os.Stat(p)
		if err != nil || info.IsDir() {
			add(SourceFile{Path: p, Name: filepath.Base(p), Kind: kind, Missing: true, UsedIn: []string{}})
			continue
		}
		add(newSource(p, "", kind, info, withDates))
	}
	if withDates {
		fillDates(ctx, out)
	}
	slices.SortStableFunc(out, func(a, b SourceFile) int {
		if a.TakenAt != b.TakenAt {
			if a.TakenAt < b.TakenAt {
				return -1
			}
			return 1
		}
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	usage := m.usage(ctx, doc)
	for i := range out {
		if ids := usage[pathKey(out[i].Path)]; ids != nil {
			out[i].UsedIn = ids
		}
	}
	return out, nil
}

func newSource(p, rel, kind string, info fs.FileInfo, withDates bool) SourceFile {
	mod := info.ModTime().UnixMilli()
	sf := SourceFile{Path: p, Name: filepath.Base(p), Rel: rel, Kind: kind, SizeBytes: info.Size(), ModTime: mod, TakenAt: mod, UsedIn: []string{}}
	return sf
}

// fillDates reads the JPEGs' EXIF dates with a few workers (file opens are
// the slow part on Windows).
func fillDates(ctx context.Context, files []SourceFile) {
	idx := make(chan int)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				if t, ok := exifTakenAt(files[i].Path); ok {
					files[i].TakenAt = t
				}
			}
		}()
	}
	for i := range files {
		if files[i].Kind == "photo" && !files[i].Missing && isJPEG(files[i].Path) && ctx.Err() == nil {
			idx <- i
		}
	}
	close(idx)
	wg.Wait()
}

// usage maps a normalised source path to the IDs of the slides that use it,
// directly or through a linked composition or video project.
func (m *Module) usage(ctx context.Context, doc Post) map[string][]string {
	use := map[string][]string{}
	for _, s := range doc.Slides {
		var paths []string
		switch s.Kind {
		case "photo", "clip":
			paths = []string{s.Path}
		case "composition":
			if m.comps != nil && s.ProjectID != "" {
				if c, err := m.comps.Get(ctx, s.ProjectID); err == nil {
					if img := c.Background.Image; img != nil {
						paths = append(paths, img.Path, img.Original)
					}
					for _, l := range c.Layers {
						if l.Image != nil {
							paths = append(paths, l.Image.Ref.Path, l.Image.Ref.Original)
						}
					}
				}
			}
		case "video":
			if m.videos != nil && s.ProjectID != "" {
				if v, err := m.videos.Get(ctx, s.ProjectID); err == nil {
					for _, c := range v.Clips {
						paths = append(paths, c.Path)
					}
					if v.Music != nil {
						paths = append(paths, v.Music.Path)
					}
				}
			}
		}
		for _, p := range paths {
			if p == "" {
				continue
			}
			k := pathKey(p)
			if l := use[k]; len(l) == 0 || l[len(l)-1] != s.ID {
				use[k] = append(use[k], s.ID)
			}
		}
	}
	return use
}

// unusedSources counts the pool's present files no slide uses.
func (m *Module) unusedSources(ctx context.Context, doc Post) int {
	if doc.Folder == "" && len(doc.Extra) == 0 {
		return 0
	}
	pool, err := m.pool(ctx, doc, false)
	if err != nil {
		return 0
	}
	n := 0
	for _, sf := range pool {
		if !sf.Missing && len(sf.UsedIn) == 0 {
			n++
		}
	}
	return n
}

// exifTakenAt reads a JPEG's DateTimeOriginal (local time) from its header.
func exifTakenAt(path string) (int64, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	buf, err := io.ReadAll(io.LimitReader(f, exifDateScan))
	if err != nil {
		return 0, false
	}
	seg, ok := findExifSegment(buf)
	if !ok {
		return 0, false
	}
	t := seg[len(exifHeader):]
	var order binary.ByteOrder
	var exifOff int64
	tiffIFD0(sliceReaderAt(t), int64(len(t)), func(tag uint16, off int64, o binary.ByteOrder) bool {
		order = o
		if tag == tagExifPointer && off+12 <= int64(len(t)) {
			exifOff = int64(o.Uint32(t[off+8 : off+12]))
			return false
		}
		return true
	})
	if exifOff <= 0 || exifOff+2 > int64(len(t)) || order == nil {
		return 0, false
	}
	n := int64(order.Uint16(t[exifOff:]))
	for i := int64(0); i < n; i++ {
		e := exifOff + 2 + i*12
		if e+12 > int64(len(t)) {
			return 0, false
		}
		if order.Uint16(t[e:]) != tagDateOrig {
			continue
		}
		cnt, valOff := int64(order.Uint32(t[e+4:])), int64(order.Uint32(t[e+8:]))
		if cnt < 19 || valOff < 0 || valOff+19 > int64(len(t)) {
			return 0, false
		}
		tm, err := time.ParseInLocation(exifDateLayout, string(t[valOff:valOff+19]), time.Local)
		if err != nil {
			return 0, false
		}
		return tm.UnixMilli(), true
	}
	return 0, false
}

type sliceReaderAt []byte

func (s sliceReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(s)) {
		return 0, io.EOF
	}
	n := copy(p, s[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}
