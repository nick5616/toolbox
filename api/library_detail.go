package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
	"toolbox/core/imaging"
)

const maxChain = 200

func (s *LibraryService) detail(ctx context.Context, idOrPath string) (core.OutputDetail, error) {
	d := core.OutputDetail{MadeFrom: []string{}, MadeInto: []core.Output{}, Chain: []core.Output{}}
	db, err := s.db()
	if err != nil {
		return d, err
	}
	lib := s.libDir()

	var out core.Output
	if filepath.IsAbs(idOrPath) {
		p := filepath.Clean(idOrPath)
		if !core.IsWithin(p, lib) || core.IsWithin(p, s.Paths.SupportDir) || underLink(lib, p) {
			return d, core.Errorf(core.CodeValidation, "That file isn't inside the library")
		}
		o, ok, err := db.OutputByPath(ctx, p)
		if err != nil {
			return d, err
		}
		if ok {
			out = o
		} else {
			info, err := os.Stat(p)
			if err != nil {
				return d, core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(p)).WithCause(err)
			}
			out = core.Output{
				Path: p, Name: filepath.Base(p), Kind: core.KindForPath(p), SizeBytes: info.Size(),
				CreatedAt: info.ModTime().UnixMilli(), Tags: []string{},
			}
		}
	} else {
		o, err := s.Outputs.GetOutput(ctx, idOrPath)
		if err != nil {
			return d, err
		}
		out = o
	}
	d.Output = out

	if out.JobID != "" && s.JobStore != nil {
		if j, err := s.JobStore.GetJob(ctx, out.JobID); err == nil {
			d.JobTitle, d.Options = j.Title, j.OptionsJSON
		}
	}
	if s.Lineage != nil {
		if out.ID != "" {
			if from, err := s.Lineage.OutputInputs(ctx, out.ID); err == nil {
				d.MadeFrom = from
			} else {
				slog.Warn("library detail: inputs", "err", err)
			}
		}
		if into, err := s.Lineage.OutputsFromInput(ctx, out.Path); err == nil {
			d.MadeInto = into
		} else {
			slog.Warn("library detail: outputs from", "err", err)
		}
		if out.ID != "" {
			d.Chain, d.ChainAt = s.chain(ctx, db, out)
		}
	}
	d.Unknown = len(d.MadeFrom) == 0

	if out.Kind == core.KindImage && !out.Missing && !strings.EqualFold(filepath.Ext(out.Path), ".heic") {
		if sz, err := imaging.Size(out.Path); err == nil {
			d.Width, d.Height = sz.W, sz.H
		}
	}
	if d.Chain == nil {
		d.Chain = []core.Output{}
	}
	return d, nil
}

// chain follows single-input lineage of the same tool backwards and forwards
// from out (≤ maxChain files, oldest first). It returns nothing when out has
// no neighbours.
func (s *LibraryService) chain(ctx context.Context, db libraryDB, out core.Output) ([]core.Output, int) {
	seen := map[string]bool{out.ID: true}
	var back []core.Output // nearest first
	cur := out
	for len(back)+1 < maxChain {
		ins, err := s.Lineage.OutputInputs(ctx, cur.ID)
		if err != nil || len(ins) != 1 {
			break
		}
		prev, ok, err := db.OutputByPath(ctx, ins[0])
		if err != nil || !ok || prev.ModuleID != out.ModuleID || seen[prev.ID] {
			break
		}
		seen[prev.ID] = true
		back = append(back, prev)
		cur = prev
	}
	var fwd []core.Output
	cur = out
	for len(back)+len(fwd)+1 < maxChain {
		next, found := core.Output{}, false
		outs, err := s.Lineage.OutputsFromInput(ctx, cur.Path)
		if err != nil {
			break
		}
		for _, c := range outs {
			if c.ModuleID != out.ModuleID || seen[c.ID] {
				continue
			}
			if ins, err := s.Lineage.OutputInputs(ctx, c.ID); err != nil || len(ins) != 1 {
				continue
			}
			next, found = c, true
			break
		}
		if !found {
			break
		}
		seen[next.ID] = true
		fwd = append(fwd, next)
		cur = next
	}
	if len(back)+len(fwd) == 0 {
		return []core.Output{}, 0
	}
	chain := make([]core.Output, 0, len(back)+1+len(fwd))
	for i := len(back) - 1; i >= 0; i-- {
		chain = append(chain, back[i])
	}
	at := len(chain)
	chain = append(chain, out)
	chain = append(chain, fwd...)
	return chain, at
}

// moduleForProject names the tool that opens a project.
func moduleForProject(p core.StoredProject) string {
	switch p.Kind {
	case core.ProjectPost:
		return "post-builder"
	case core.ProjectComposition:
		return "photo-composer"
	case core.ProjectVideo:
		return "video-editor"
	case core.ProjectPaint:
		return "paint"
	case core.ProjectEdit:
		// Edit Studio projects have an analysed song (editstudio.FlagMusicEdit);
		// everything else opens in the Video Editor.
		var doc struct {
			Song        *struct{} `json:"song"`
			AnalysisKey string    `json:"analysisKey"`
		}
		if json.Unmarshal([]byte(p.Data), &doc) == nil && doc.Song != nil && doc.AnalysisKey != "" {
			return "edit-studio"
		}
		return "video-studio"
	}
	return ""
}

func (s *LibraryService) places(ctx context.Context) (core.LibraryPlaces, error) {
	res := core.LibraryPlaces{Projects: []core.LibraryProject{}, SavedMasks: []core.LibrarySavedMask{}}
	if s.Projects != nil {
		for _, kind := range []core.ProjectKind{core.ProjectPost, core.ProjectComposition, core.ProjectVideo, core.ProjectEdit, core.ProjectPaint} {
			list, err := s.Projects.ListProjects(ctx, kind)
			if err != nil {
				return res, err
			}
			for _, p := range list {
				dir := filepath.Join(s.Paths.SupportDir, "projects", p.ID)
				lp := core.LibraryProject{ID: p.ID, Kind: p.Kind, ModuleID: moduleForProject(p), Name: p.Name, UpdatedAt: p.UpdatedAt}
				if t := filepath.Join(dir, "thumb.jpg"); fileExists(t) {
					lp.Thumb = t
				}
				if m, _ := filepath.Glob(filepath.Join(dir, "render.*")); len(m) > 0 {
					sort.Strings(m)
					lp.Render = m[0]
				}
				res.Projects = append(res.Projects, lp)
			}
		}
		sort.SliceStable(res.Projects, func(i, j int) bool { return res.Projects[i].UpdatedAt > res.Projects[j].UpdatedAt })
	}
	if s.SavedMasks != nil {
		masks, err := s.SavedMasks()
		if err != nil {
			slog.Warn("library places: saved masks", "err", err)
		} else if masks != nil {
			res.SavedMasks = masks
		}
	}
	return res, nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.Mode().IsRegular()
}
