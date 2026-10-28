package vault

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
)

// previewMIME maps previewable extensions to MIME types.
var previewMIME = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".bmp": "image/bmp",
}

const invalidNameChars = `\/:*?"<>|`

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	bad := name == "" || name == "." || name == ".." || len(name) > 255 ||
		strings.ContainsAny(name, invalidNameChars) ||
		strings.IndexFunc(name, func(r rune) bool { return r < 0x20 }) >= 0
	if bad {
		return "", core.ValidationError("That name isn't valid",
			map[string]string{"name": `Use 1–255 characters, without \ / : * ? " < > |`})
	}
	return name, nil
}

func cleanFolder(f string) (string, error) {
	f = strings.TrimSpace(f)
	if f == "" {
		return "", nil
	}
	if _, err := cleanName(f); err != nil || len(f) > 100 {
		return "", core.ValidationError("That folder name isn't valid", map[string]string{"folder": "Invalid folder name"})
	}
	return f, nil
}

// sanitizeFileName makes a stored name safe to create on any OS.
func sanitizeFileName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(invalidNameChars, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	if name == "" {
		return "file"
	}
	return name
}

func splitExt(name string) (stem, ext string) {
	ext = filepath.Ext(name)
	if ext == name { // dotfile
		return name, ""
	}
	return strings.TrimSuffix(name, ext), ext
}

// uniqueName returns name, or "stem (n).ext", unused in folder (ignoring skipID).
func uniqueName(ix *index, folder, name, skipID string) string {
	taken := func(n string) bool {
		for _, e := range ix.Entries {
			if e.ID != skipID && e.Folder == folder && strings.EqualFold(e.Name, n) {
				return true
			}
		}
		return false
	}
	if !taken(name) {
		return name
	}
	stem, ext := splitExt(name)
	for i := 1; ; i++ {
		if c := fmt.Sprintf("%s (%d)%s", stem, i, ext); !taken(c) {
			return c
		}
	}
}

func (v *Vault) list(folder, search string) ([]Entry, error) {
	v.mu.Lock()
	if v.idx == nil {
		v.mu.Unlock()
		return []Entry{}, errLocked
	}
	out := make([]Entry, 0, len(v.idx.Entries))
	q := strings.ToLower(strings.TrimSpace(search))
	for _, e := range v.idx.Entries {
		if folder != "" && e.Folder != folder {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(e.Name), q) {
			continue
		}
		out = append(out, e.Entry)
	}
	v.mu.Unlock()
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	v.touch()
	return out, nil
}

func (v *Vault) folders() ([]string, error) {
	v.mu.Lock()
	if v.idx == nil {
		v.mu.Unlock()
		return []string{}, errLocked
	}
	seen := map[string]bool{}
	out := []string{}
	for _, e := range v.idx.Entries {
		if e.Folder != "" && !seen[e.Folder] {
			seen[e.Folder] = true
			out = append(out, e.Folder)
		}
	}
	v.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i]) < strings.ToLower(out[j]) })
	v.touch()
	return out, nil
}

func (v *Vault) rename(id, name string) error {
	name, err := cleanName(name)
	if err != nil {
		return err
	}
	return v.mutate(func(ix *index) error {
		i := ix.find(id)
		if i < 0 {
			return errNotFound()
		}
		for _, e := range ix.Entries {
			if e.ID != id && e.Folder == ix.Entries[i].Folder && strings.EqualFold(e.Name, name) {
				return core.Errorf(core.CodeConflict, "A file with that name is already in this folder")
			}
		}
		ix.Entries[i].Name = name
		return nil
	})
}

func (v *Vault) move(ids []string, folder string) error {
	folder, err := cleanFolder(folder)
	if err != nil {
		return err
	}
	return v.mutate(func(ix *index) error {
		for _, id := range ids {
			if ix.find(id) < 0 {
				return errNotFound()
			}
		}
		for _, id := range ids {
			i := ix.find(id)
			ix.Entries[i].Folder = ""
			ix.Entries[i].Name = uniqueName(ix, folder, ix.Entries[i].Name, id)
			ix.Entries[i].Folder = folder
		}
		return nil
	})
}

func (v *Vault) delete(ids []string) error {
	var blobs []string
	_, dir, _, err := v.unlockedSnapshot()
	if err != nil {
		return err
	}
	err = v.mutate(func(ix *index) error {
		drop := map[string]bool{}
		for _, id := range ids {
			i := ix.find(id)
			if i < 0 {
				return errNotFound()
			}
			drop[id] = true
			blobs = append(blobs, ix.Entries[i].Blob)
		}
		kept := ix.Entries[:0:0]
		for _, e := range ix.Entries {
			if !drop[e.ID] {
				kept = append(kept, e)
			}
		}
		ix.Entries = kept
		return nil
	})
	if err != nil {
		return err
	}
	for _, b := range blobs { // the index no longer references them
		_ = os.Remove(blobPath(dir, b))
	}
	return nil
}

func blobPath(dir, rel string) string {
	if !filepath.IsLocal(filepath.FromSlash(rel)) {
		return filepath.Join(dir, dirBlobs, "invalid")
	}
	return filepath.Join(dir, filepath.FromSlash(rel))
}

func (v *Vault) entry(id string) (indexEntry, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.idx == nil {
		return indexEntry{}, errLocked
	}
	i := v.idx.find(id)
	if i < 0 {
		return indexEntry{}, errNotFound()
	}
	return v.idx.Entries[i], nil
}

func (v *Vault) open(id string) error {
	v.touch()
	e, err := v.entry(id)
	if err != nil {
		return err
	}
	ident, dir, session, err := v.unlockedSnapshot()
	if err != nil {
		return err
	}
	if v.cfg.OpenDir == "" || v.cfg.OpenFile == nil {
		return core.Errorf(core.CodeInternal, "Opening files isn't available")
	}
	sdir := filepath.Join(v.cfg.OpenDir, session)
	if err := os.MkdirAll(sdir, 0o700); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create a temporary copy").WithCause(err)
	}
	stem, ext := splitExt(sanitizeFileName(e.Name))
	path := core.UniquePath(sdir, stem, ext)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create a temporary copy").WithCause(err)
	}
	derr := decryptBlob(context.Background(), blobPath(dir, e.Blob), ident, e.SHA256, f, nil)
	cerr := f.Close()
	if derr == nil {
		derr = cerr
	}
	if derr == nil {
		if _, _, cur, lerr := v.unlockedSnapshot(); lerr != nil || cur != session {
			derr = errLocked // locked while decrypting
		}
	}
	if derr != nil {
		_ = os.Remove(path)
		return derr
	}
	if err := v.cfg.OpenFile(path); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't open the file").WithCause(err)
	}
	return nil
}

func (v *Vault) preview(id string) (string, error) {
	v.touch()
	e, err := v.entry(id)
	if err != nil {
		return "", err
	}
	_, ext := splitExt(e.Name)
	mime, ok := previewMIME[strings.ToLower(ext)]
	if !ok {
		return "", core.ValidationError("This file can't be previewed", nil)
	}
	if e.Size > maxPreviewBytes {
		return "", core.ValidationError("This image is too large to preview", nil).
			WithHint("Open or export it instead")
	}
	ident, dir, _, err := v.unlockedSnapshot()
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := decryptBlob(context.Background(), blobPath(dir, e.Blob), ident, e.SHA256, &buf, nil); err != nil {
		return "", err
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}
