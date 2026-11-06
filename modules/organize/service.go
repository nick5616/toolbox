package organize

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"time"

	"toolbox/core"
)

// Service is the Organizer's typed Wails service.
type Service struct {
	jobs *core.Jobs
	mod  *Module
}

// NewService builds the service. mod is used by Preview (no job, nothing copied).
func NewService(jobs *core.Jobs, mod *Module) *Service { return &Service{jobs: jobs, mod: mod} }

// Defaults returns the default options.
func (s *Service) Defaults() Options { return DefaultOptions() }

// StepShape exposes the pipeline step's options type to the bindings.
func (s *Service) StepShape() Options { return DefaultOptions() }

// Enqueue queues one organizing job for every file and folder.
func (s *Service) Enqueue(paths []string, opts Options) ([]core.Job, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal organize options: %w", err)
	}
	return s.jobs.Submit(context.Background(), ModuleID, paths, string(raw))
}

// Expand lists the files inside folders (recursively, without hidden and
// system files); plain files are returned as they are. The Organizer's input
// list shows these.
func (s *Service) Expand(paths []string) ([]string, error) {
	out, err := expandInputs(context.Background(), paths)
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []string{}
	}
	return out, nil
}

// PreviewFile is one file in a preview.
type PreviewFile struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

// PreviewFolder is a planned folder and how many files go in it.
type PreviewFolder struct {
	Path  string `json:"path"` // relative to the run folder, "/" separated; "" = the run folder itself
	Count int    `json:"count"`
}

// DuplicateGroup is a file that stays and the files that are copies of it.
type DuplicateGroup struct {
	Keep   PreviewFile   `json:"keep"`
	Others []PreviewFile `json:"others"`
	Match  string        `json:"match"` // "exact" | "similar"
}

// Preview is what a run would do.
type Preview struct {
	Total      int              `json:"total"`
	Duplicates int              `json:"duplicates"` // files that are duplicates of another
	Skipped    int              `json:"skipped"`    // duplicates that would not be copied
	Folders    []PreviewFolder  `json:"folders"`    // sorted by path
	Groups     []DuplicateGroup `json:"groups"`     // capped at MaxPreviewGroups
	MoreGroups int              `json:"moreGroups"` // groups beyond the cap
	DateSource string           `json:"dateSource"` // "exif" | "modified"
}

// MaxPreviewGroups caps the duplicate groups a preview returns.
const MaxPreviewGroups = 200

// Preview plans the run without copying anything.
func (s *Service) Preview(paths []string, opts Options) (Preview, error) {
	raw, err := json.Marshal(opts)
	if err != nil {
		return Preview{}, fmt.Errorf("marshal organize options: %w", err)
	}
	if err := s.mod.Validate(paths, raw); err != nil {
		return Preview{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	var read readMetaFunc
	src := "modified"
	if exe := s.mod.exifPath(); exe != "" {
		read, src = exiftoolReader(exe), "exif"
	}
	pl, err := newPlanner(read, nil).build(ctx, paths, opts)
	if err != nil {
		return Preview{}, err
	}
	return pl.preview(src), nil
}

func (pl *plan) previewFile(e *entry) PreviewFile {
	if e.W == 0 && e.Type == TypePhotos {
		e.W, e.H = photoPixels(e.Src)
	}
	return PreviewFile{Path: e.Src, Name: filepath.Base(e.Src), SizeBytes: e.Size, Width: e.W, Height: e.H}
}

func (pl *plan) preview(dateSource string) Preview {
	out := Preview{Total: len(pl.Entries), Folders: []PreviewFolder{}, Groups: []DuplicateGroup{}, DateSource: dateSource}
	counts := map[string]int{}
	groups := map[int][]*entry{}
	for i, e := range pl.Entries {
		if e.DupOf >= 0 {
			out.Duplicates++
			groups[pl.keeperIndex(i)] = append(groups[pl.keeperIndex(i)], e)
		}
		if e.Dest == "" {
			out.Skipped++
			continue
		}
		dir := path.Dir(e.Dest)
		if dir == "." {
			dir = ""
		}
		counts[dir]++
	}
	for p, n := range counts {
		out.Folders = append(out.Folders, PreviewFolder{Path: p, Count: n})
	}
	sort.Slice(out.Folders, func(i, j int) bool { return out.Folders[i].Path < out.Folders[j].Path })

	keys := make([]int, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	for _, k := range keys {
		if len(out.Groups) >= MaxPreviewGroups {
			out.MoreGroups++
			continue
		}
		keep := pl.Entries[k]
		g := DuplicateGroup{Keep: pl.previewFile(keep), Others: []PreviewFile{}, Match: "exact"}
		for _, o := range groups[k] {
			g.Others = append(g.Others, pl.previewFile(o))
			if o.Similar {
				g.Match = "similar"
			}
		}
		out.Groups = append(out.Groups, g)
	}
	return out
}

func (pl *plan) keeperIndex(i int) int {
	for pl.Entries[i].DupOf >= 0 {
		i = pl.Entries[i].DupOf
	}
	return i
}
