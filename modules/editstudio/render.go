package editstudio

import (
	"context"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"time"

	"toolbox/core"
	"toolbox/core/viz"
	"toolbox/modules/videoeditor"
)

// The export job (SPEC.md §12.1). WP-ES8.

// Seams: tests replace these so the flow runs without FFmpeg, the engine or
// the webview renderer.
var (
	exportRenderFn = func(ctx context.Context, br *viz.RenderBroker, job *core.JobContext, plan viz.RenderPlan) (viz.RenderOutput, error) {
		if br == nil {
			return viz.RenderOutput{}, core.Errorf(core.CodeInternal, "The video renderer isn't available")
		}
		return br.Render(ctx, job, plan)
	}
	exportMuxFn    = muxEdit
	exportAudioFn  = encodeAudioOnly
	exportProbeFn  = videoeditor.ProbeFiles
	exportNowFn    = time.Now
	exportMixFn    = (*Module).mixAudio
	ensureStreamFn = (*Module).EnsureStream
	ensureImageFn  = (*Module).EnsureImage
	ensureInterpFn = (*Module).EnsureInterp
)

// Progress split of the export.
const (
	exportSourcesTo = 0.25
	exportRenderTo  = 0.85
	exportAudioTo   = 0.92
)

// maxProjectJSON is the largest project document the renderer takes (§12.2).
const maxProjectJSON = 4 << 20

// exportSize is the output size for an aspect at a short side (even numbers;
// matches the frontend's sizeFor).
func exportSize(aspect string, short int) (w, h int) {
	even := func(v float64) int { return int(math.Round(v/2)) * 2 }
	switch aspect {
	case "9:16":
		return short, even(float64(short) * 16 / 9)
	case "4:5":
		return short, even(float64(short) * 5 / 4)
	case "16:9":
		return even(float64(short) * 16 / 9), short
	}
	return short, short
}

// docOutputSize is the export's size in pixels: an explicit Size when the
// document has one (Color Grader and still plans), else the aspect at the
// export height.
func docOutputSize(doc EditProject) (w, h int) {
	if doc.Size != nil {
		return doc.Size.W, doc.Size.H
	}
	return exportSize(doc.Aspect, doc.ExportHeight)
}

// uprightSize is a probed video's size after rotation.
func uprightSize(i videoeditor.ClipInfo) (w, h int) {
	if r := i.Rotation % 180; r != 0 {
		return i.Height, i.Width
	}
	return i.Width, i.Height
}

// interpKeyOf is the interp stream key of a source range (§7.5, §8.1).
func interpKeyOf(path string, fromMs, toMs int64) string {
	from, to := InterpRange(fromMs, toMs)
	return fmt.Sprintf("i:%s|%d-%d", path, from, to)
}

// exportNeeds is what the export reads: the visible clips of non-muted tracks.
type exportNeeds struct {
	videos  []string // unique paths
	images  []string
	interps []interpNeed
	mattes  []string // matte IDs
}

type interpNeed struct {
	key          string
	path         string
	fromMs, toMs int64
	fromS, toS   int64
}

// collectNeeds lists the files a render reads. Clips outside 0..D (after the
// cut offset) and muted tracks need nothing.
func collectNeeds(doc EditProject) exportNeeds {
	var n exportNeeds
	d := float64(editLen(doc))
	off := float64(doc.CutOffsetFrames) * 1000 / float64(doc.FPS)
	seen := map[string]bool{}
	once := func(key string) bool {
		if seen[key] {
			return false
		}
		seen[key] = true
		return true
	}
	for _, t := range doc.Tracks {
		if t.Muted || t.Kind != "video" {
			continue
		}
		for _, c := range t.Clips {
			if float64(c.StartMs)+off >= d || float64(c.EndMs)+off <= 0 {
				continue
			}
			switch c.Kind {
			case "video":
				if once("v:" + c.Path) {
					n.videos = append(n.videos, c.Path)
				}
				if c.Slow == "interpolate" {
					// Interpolation is for slowing down: it applies when the clip's
					// speed is ever below 1. The range is the clip's own source
					// range (constant speed, or the integral of the keys), the same
					// rule the Inspector uses to ask for it.
					if lo, _ := parseSpeedCurve(c.Speed).minMax(); lo < 1 {
						from, to := clipSourceRange(c, doc.FPS)
						fs, ts := InterpRange(from, to)
						if ts > fs && ts-fs <= MaxInterpMs/1000 {
							key := interpKeyOf(c.Path, from, to)
							if once(key) {
								n.interps = append(n.interps, interpNeed{key: key, path: c.Path, fromMs: from, toMs: to, fromS: fs, toS: ts})
							}
						}
					}
				}
			case "image":
				if once("p:" + c.Path) {
					n.images = append(n.images, c.Path)
				}
			}
			if c.Matte != nil && c.Matte.ID != "" && (c.Kind == "video" || c.Kind == "image") && once("m:"+c.Matte.ID) {
				n.mattes = append(n.mattes, c.Matte.ID)
			}
		}
	}
	return n
}

// ensureExportFiles makes every file the render reads and returns the plan's
// stream and image maps (SPEC.md §12.1 step 3).
func (m *Module) ensureExportFiles(ctx context.Context, job *core.JobContext, projectID string, doc EditProject, ffprobe string, outW, outH int) (map[string]viz.EditPlanStream, map[string]string, error) {
	needs := collectNeeds(doc)
	streams := map[string]viz.EditPlanStream{}
	images := map[string]string{}

	infos := map[string]videoeditor.ClipInfo{}
	if len(needs.videos) > 0 {
		for _, info := range exportProbeFn(ctx, ffprobe, needs.videos) {
			infos[info.Path] = info
		}
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
	}

	total := float64(len(needs.videos) + len(needs.images) + len(needs.interps))
	done := 0.0
	report := func(msg string) func(float64) {
		return func(f float64) {
			if total > 0 {
				job.Progress((done+min(max(f, 0), 1))/total, msg)
			}
		}
	}
	step := func() { done++ }

	for _, p := range needs.videos {
		info, ok := infos[p]
		if !ok || info.Error != "" || info.Width <= 0 || info.Height <= 0 {
			why := "Couldn't read this file"
			if ok && info.Error != "" {
				why = info.Error
			}
			return nil, nil, core.Errorf(core.CodeNotFound, "%s: %s", baseName(p), why)
		}
		w, h := uprightSize(info)
		report("Preparing " + baseName(p))(0)
		st, err := ensureStreamFn(m, ctx, job, p, ExportShort(w, h, outW, outH), doc.FPS, report("Preparing "+baseName(p)))
		if err != nil {
			return nil, nil, err
		}
		streams["v:"+p] = viz.EditPlanStream{Stream: st.Stream, Index: st.Index}
		step()
	}
	for _, in := range needs.interps {
		report("Making slow motion for " + baseName(in.path))(0)
		_, exp, err := ensureInterpFn(m, ctx, job, in.path, in.fromMs, in.toMs, doc.FPS, report("Making slow motion for "+baseName(in.path)))
		if err != nil {
			return nil, nil, err
		}
		streams[in.key] = viz.EditPlanStream{Stream: exp.Stream, Index: exp.Index}
		step()
	}
	for _, p := range needs.images {
		report("Preparing " + baseName(p))(0)
		img, err := ensureImageFn(m, ctx, job, p, ExportImageMax)
		if err != nil {
			return nil, nil, err
		}
		images["p:"+p] = img
		step()
	}
	if len(needs.mattes) > 0 {
		states, err := m.matteStates(projectID, needs.mattes)
		if err != nil {
			return nil, nil, err
		}
		for _, s := range states {
			switch {
			case !s.Ready:
				return nil, nil, core.Errorf(core.CodeNotFound, "A cut-out isn't ready. Rebuild it or remove it")
			case s.Export != nil:
				streams["m:"+s.ID] = viz.EditPlanStream{Stream: s.Export.Stream, Index: s.Export.Index}
			case s.Image != "":
				images["m:"+s.ID] = s.Image
			default:
				return nil, nil, core.Errorf(core.CodeNotFound, "A cut-out has no files. Rebuild it or remove it")
			}
		}
	}
	job.Progress(1, "Sources ready")
	return streams, images, nil
}

// exportMove renames src to dst, copying across volumes when needed; a failed
// copy leaves nothing at dst.
func exportMove(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, in); err != nil {
		f.Close()
		os.Remove(dst)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	_ = os.Remove(src)
	return nil
}

// newRenderPlan builds the broker's plan: the song's range, or 0..D without a
// song; ref is the zero AnalysisRef when the edit has no analysis.
func newRenderPlan(doc EditProject, ref viz.AnalysisRef, w, h int, projectJSON string, streams map[string]viz.EditPlanStream, images map[string]string) viz.RenderPlan {
	startMs, endMs := int64(0), editLen(doc)
	if doc.Song != nil {
		startMs, endMs = doc.Song.StartMs, doc.Song.EndMs
	}
	return viz.RenderPlan{
		Analysis: ref, Width: w, Height: h, FPS: doc.FPS,
		StartMs: startMs, EndMs: endMs, Mode: viz.ModeOpaque, Seed: doc.Seed,
		Edit: &viz.EditPlan{ProjectJSON: projectJSON, Streams: streams, Images: images},
	}
}
