// Package projectdocs is the shared CRUD of creator-tool projects (SPEC.md
// Part B §B4): typed documents in core.ProjectStore plus a per-project folder
// <support>/projects/<id>/ for thumbnails, renders and previews.
package projectdocs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// MaxName is the longest project name.
const MaxName = 80

// Summarize counts a document's items and missing source files.
type Summarize func(data string) (items, missing int)

// Docs manages one kind of project.
type Docs struct {
	Store core.ProjectStore
	Root  string // <support>/projects
	Kind  core.ProjectKind
	// Summarize fills ProjectInfo.Items/Missing (nil = 0, 0).
	Summarize Summarize
}

// Dir is the project's folder (not created).
func (d *Docs) Dir(id string) string { return filepath.Join(d.Root, id) }

// ThumbPath is where the project's thumbnail lives.
func (d *Docs) ThumbPath(id string) string { return filepath.Join(d.Dir(id), "thumb.jpg") }

// CleanName collapses whitespace, caps a name at MaxName characters and
// defaults to "Untitled".
func CleanName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	if utf8.RuneCountInString(name) > MaxName {
		name = string([]rune(name)[:MaxName])
	}
	if name == "" {
		name = "Untitled"
	}
	return name
}

// Info builds a listing row.
func (d *Docs) Info(p core.StoredProject) core.ProjectInfo {
	info := core.ProjectInfo{ID: p.ID, Kind: p.Kind, Name: p.Name, UpdatedAt: p.UpdatedAt}
	if _, err := os.Stat(d.ThumbPath(p.ID)); err == nil {
		info.Thumb = d.ThumbPath(p.ID)
	}
	if d.Summarize != nil {
		info.Items, info.Missing = d.Summarize(p.Data)
	}
	return info
}

// List returns this kind's projects, most recently updated first.
func (d *Docs) List(ctx context.Context) ([]core.ProjectInfo, error) {
	ps, err := d.Store.ListProjects(ctx, d.Kind)
	if err != nil {
		return nil, err
	}
	out := make([]core.ProjectInfo, 0, len(ps))
	for _, p := range ps {
		out = append(out, d.Info(p))
	}
	return out, nil
}

// Load returns the stored project, checking its kind.
func (d *Docs) Load(ctx context.Context, id string) (core.StoredProject, error) {
	p, err := d.Store.GetProject(ctx, id)
	if err != nil {
		return core.StoredProject{}, err
	}
	if p.Kind != d.Kind {
		return core.StoredProject{}, core.Errorf(core.CodeNotFound, "Project not found")
	}
	return p, nil
}

// Get decodes a project's document into T.
func Get[T any](ctx context.Context, d *Docs, id string) (T, error) {
	var doc T
	p, err := d.Load(ctx, id)
	if err != nil {
		return doc, err
	}
	if err := json.Unmarshal([]byte(p.Data), &doc); err != nil {
		return doc, fmt.Errorf("decode project %s: %w", id, err)
	}
	return doc, nil
}

func encode(doc any) (string, error) {
	b, err := json.Marshal(doc)
	if err != nil {
		return "", fmt.Errorf("encode project: %w", err)
	}
	if len(b) > core.MaxProjectBytes {
		return "", core.ValidationError("This project is too large", nil)
	}
	return string(b), nil
}

// Create stores a new project.
func (d *Docs) Create(ctx context.Context, name string, doc any) (core.ProjectInfo, error) {
	data, err := encode(doc)
	if err != nil {
		return core.ProjectInfo{}, err
	}
	now := core.NowMillis()
	p := core.StoredProject{ID: core.NewID(), Kind: d.Kind, Name: CleanName(name), Data: data, CreatedAt: now, UpdatedAt: now}
	if err := d.Store.PutProject(ctx, p); err != nil {
		return core.ProjectInfo{}, err
	}
	return d.Info(p), nil
}

// Save replaces an existing project's name and document.
func (d *Docs) Save(ctx context.Context, id, name string, doc any) (core.ProjectInfo, error) {
	p, err := d.Load(ctx, id)
	if err != nil {
		return core.ProjectInfo{}, err
	}
	data, err := encode(doc)
	if err != nil {
		return core.ProjectInfo{}, err
	}
	p.Name, p.Data, p.UpdatedAt = CleanName(name), data, core.NowMillis()
	if err := d.Store.PutProject(ctx, p); err != nil {
		return core.ProjectInfo{}, err
	}
	return d.Info(p), nil
}

// Duplicate copies a project (and the files in its folder) as "<name> copy".
func (d *Docs) Duplicate(ctx context.Context, id string) (core.ProjectInfo, error) {
	p, err := d.Load(ctx, id)
	if err != nil {
		return core.ProjectInfo{}, err
	}
	now := core.NowMillis()
	cp := core.StoredProject{ID: core.NewID(), Kind: d.Kind, Name: CleanName(p.Name + " copy"), Data: p.Data, CreatedAt: now, UpdatedAt: now}
	if err := d.Store.PutProject(ctx, cp); err != nil {
		return core.ProjectInfo{}, err
	}
	if entries, err := os.ReadDir(d.Dir(id)); err == nil {
		if err := os.MkdirAll(d.Dir(cp.ID), 0o755); err == nil {
			for _, e := range entries {
				if e.Type().IsRegular() {
					_ = copyFile(filepath.Join(d.Dir(id), e.Name()), filepath.Join(d.Dir(cp.ID), e.Name()))
				}
			}
		}
	}
	return d.Info(cp), nil
}

// Delete removes a project and its folder.
func (d *Docs) Delete(ctx context.Context, id string) error {
	if _, err := d.Load(ctx, id); err != nil {
		return err
	}
	if err := d.Store.DeleteProject(ctx, id); err != nil {
		return err
	}
	if err := os.RemoveAll(d.Dir(id)); err != nil {
		return fmt.Errorf("remove project folder: %w", err)
	}
	return nil
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o644)
}

// MissingPaths counts non-empty paths that don't exist.
func MissingPaths(paths ...string) int {
	n := 0
	for _, p := range paths {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err != nil {
			n++
		}
	}
	return n
}
