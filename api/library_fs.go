package api

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
)

const (
	maxFolderDepth = 6
	maxListLimit   = 5000
)

// relParts validates a library-relative folder path ("" = the root) and
// returns its elements. Absolute paths, drive letters and ".." are refused.
func relParts(rel string) ([]string, error) {
	rel = strings.ReplaceAll(rel, `\`, "/")
	if strings.HasPrefix(rel, "/") || strings.Contains(rel, ":") || filepath.IsAbs(rel) {
		return nil, core.Errorf(core.CodeValidation, "That folder isn't inside the library")
	}
	var parts []string
	for _, p := range strings.Split(rel, "/") {
		switch p {
		case "", ".":
		case "..":
			return nil, core.Errorf(core.CodeValidation, "That folder isn't inside the library")
		default:
			parts = append(parts, p)
		}
	}
	return parts, nil
}

func hiddenDirName(name string) bool { return strings.HasPrefix(name, ".") }

func (s *LibraryService) folders(ctx context.Context) (core.LibraryFolder, error) {
	lib := s.libDir()
	root := core.LibraryFolder{Name: filepath.Base(lib), Path: lib, Children: []core.LibraryFolder{}, ModuleIDs: []string{}}
	if _, err := os.Stat(lib); err != nil {
		return root, nil // nothing made yet
	}
	registered := map[string]string{}
	if db, err := s.db(); err == nil {
		if m, err := db.OutputModulesUnder(ctx, lib); err == nil {
			registered = make(map[string]string, len(m))
			for p, mod := range m {
				registered[pathKey(p)] = mod
			}
		}
	}
	subdirs := map[string][]string{} // rel ("/"-separated) → module IDs whose OutputSubdir it is
	if s.Reg != nil {
		for _, d := range s.Reg.List() {
			if d.OutputSubdir != "" {
				k := strings.ToLower(strings.Join(mustParts(d.OutputSubdir), "/"))
				subdirs[k] = append(subdirs[k], d.ID)
			}
		}
	}
	walkFolder(ctx, &root, "", 0, registered, subdirs)
	return root, nil
}

func mustParts(rel string) []string {
	p, err := relParts(rel)
	if err != nil {
		return nil
	}
	return p
}

// walkFolder fills f (whose Path is set) and its children.
func walkFolder(ctx context.Context, f *core.LibraryFolder, rel string, depth int, registered map[string]string, subdirs map[string][]string) {
	f.Rel = rel
	mods := map[string]bool{}
	for _, id := range subdirs[strings.ToLower(rel)] {
		mods[id] = true
	}
	entries, err := os.ReadDir(f.Path)
	if err == nil {
		var dirs []os.DirEntry
		for _, e := range entries {
			if ctx.Err() != nil {
				return
			}
			full := filepath.Join(f.Path, e.Name())
			if e.IsDir() {
				if !hiddenDirName(e.Name()) {
					dirs = append(dirs, e)
				}
				continue
			}
			info, err := os.Lstat(full)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			if link, _ := linkAttrs(info); link {
				continue
			}
			f.Files++
			if m := info.ModTime().UnixMilli(); m > f.NewestMod {
				f.NewestMod = m
			}
			if mod, ok := registered[pathKey(full)]; ok {
				f.Registered++
				mods[mod] = true
			}
		}
		if depth < maxFolderDepth {
			for _, e := range dirs {
				full := filepath.Join(f.Path, e.Name())
				info, err := os.Lstat(full)
				if err != nil {
					continue
				}
				if link, hidden := linkAttrs(info); link || hidden {
					continue
				}
				childRel := e.Name()
				if rel != "" {
					childRel = rel + "/" + e.Name()
				}
				c := core.LibraryFolder{Name: e.Name(), Path: full, Children: []core.LibraryFolder{}, ModuleIDs: []string{}}
				walkFolder(ctx, &c, childRel, depth+1, registered, subdirs)
				f.Children = append(f.Children, c)
			}
		}
	}
	for id := range mods {
		f.ModuleIDs = append(f.ModuleIDs, id)
	}
	sort.Strings(f.ModuleIDs)
}

// resolveFolder maps a library-relative folder to its absolute path,
// refusing anything outside the library and anything reached through a link.
func (s *LibraryService) resolveFolder(rel string) (string, error) {
	parts, err := relParts(rel)
	if err != nil {
		return "", err
	}
	lib := s.libDir()
	full := filepath.Join(append([]string{lib}, parts...)...)
	if !core.IsWithin(full, lib) {
		return "", core.Errorf(core.CodeValidation, "That folder isn't inside the library")
	}
	if underLink(lib, full) {
		return "", core.Errorf(core.CodeValidation, "Links aren't followed in the library")
	}
	return full, nil
}

func (s *LibraryService) listDir(ctx context.Context, rel string, limit int) (core.LibraryListing, error) {
	res := core.LibraryListing{Entries: []core.LibraryEntry{}}
	dir, err := s.resolveFolder(rel)
	if err != nil {
		return res, err
	}
	if limit <= 0 || limit > maxListLimit {
		limit = maxListLimit
	}
	des, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return res, core.Errorf(core.CodeNotFound, "That folder doesn't exist").WithCause(err)
		}
		return res, core.Errorf(core.CodeConflict, "Can't read that folder").WithCause(err)
	}
	parts, _ := relParts(rel)
	relBase := strings.Join(parts, "/")
	var dirs, files []core.LibraryEntry
	for _, e := range des {
		full := filepath.Join(dir, e.Name())
		info, err := os.Lstat(full)
		if err != nil {
			continue
		}
		if link, _ := linkAttrs(info); link {
			continue
		}
		er := e.Name()
		if relBase != "" {
			er = relBase + "/" + e.Name()
		}
		ent := core.LibraryEntry{
			Name: e.Name(), Path: full, Rel: er, IsDir: info.IsDir(),
			ModTime: info.ModTime().UnixMilli(), Kind: core.KindOther,
		}
		switch {
		case info.IsDir():
			dirs = append(dirs, ent)
		case info.Mode().IsRegular():
			ent.SizeBytes = info.Size()
			ent.Kind = core.KindForPath(full)
			files = append(files, ent)
		}
	}
	all := append(dirs, files...)
	if len(all) > limit {
		all, res.Truncated = all[:limit], true
	}
	var paths []string
	for _, e := range all {
		if !e.IsDir {
			paths = append(paths, e.Path)
		}
	}
	if db, err := s.db(); err == nil && len(paths) > 0 {
		outs, err := db.OutputsByPaths(ctx, paths)
		if err != nil {
			return res, err
		}
		byPath := make(map[string]core.Output, len(outs))
		for _, o := range outs {
			byPath[pathKey(o.Path)] = o
		}
		for i := range all {
			if o, ok := byPath[pathKey(all[i].Path)]; ok {
				o := o
				all[i].Output = &o
			}
		}
	}
	res.Entries = all
	return res, nil
}
