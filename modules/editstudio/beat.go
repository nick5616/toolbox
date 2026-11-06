package editstudio

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
	"toolbox/modules/videoeditor"
)

// "Cut to the beat" (Phase 14 A2): Edit Studio as a pipeline step. A song plus
// clips: the song is analysed here, the auto-fill recipe (TypeScript) runs in
// the main window through the render broker and returns the filled edit, and
// the edit is exported by renderDoc like the Export button does.

// BeatRequest is both the step's options and the beat job's request. The
// job's inputs are the clips; the song is Song.
type BeatRequest struct {
	RecipeID string `json:"recipeId"` // one of BeatRecipes
	Seed     int64  `json:"seed"`     // 0 = 1; the same inputs and seed give the same cut
	Order    string `json:"order"`    // "recipe" | "sequential" | "shuffleNoRepeat" | "byTag"
	Song     string `json:"song"`     // the song's path (takes {vars}); "" = the first audio input
	StartMs  int64  `json:"startMs"`  // where in the song the edit starts
	LengthMs int64  `json:"lengthMs"` // 0 = 30 s (shorter if the song ends)
	Aspect   string `json:"aspect"`   // "9:16" | "4:5" | "1:1" | "16:9"
	FPS      int    `json:"fps"`      // 30 | 60
	Height   int    `json:"height"`   // export short side: 720 | 1080 | 1440
	Name     string `json:"name"`     // output file name; takes {vars}; "" = the song's name
}

// BeatRecipes are the auto-fill recipes a step can use. (The Velocity edit
// recipe also needs the Auto-fill dialog's ramp pass, so it isn't offered.)
var BeatRecipes = []string{"downbeat", "kick", "chorus-double", "hold-verse", "drop-slam", "anime-drop"}

// Beat defaults.
const (
	defaultBeatMs = 30_000
	maxBeatSeed   = 1<<31 - 1
)

// DefaultBeatRequest: downbeat cuts, 30 s, portrait 1080p30.
func DefaultBeatRequest() BeatRequest {
	return BeatRequest{RecipeID: "downbeat", Seed: 1, Order: "recipe", LengthMs: defaultBeatMs, Aspect: "9:16", FPS: 30, Height: 1080}
}

func (r BeatRequest) withDefaults() BeatRequest {
	d := DefaultBeatRequest()
	if r.RecipeID == "" {
		r.RecipeID = d.RecipeID
	}
	if r.Seed == 0 {
		r.Seed = d.Seed
	}
	if r.Order == "" {
		r.Order = d.Order
	}
	if r.LengthMs == 0 {
		r.LengthMs = d.LengthMs
	}
	if r.Aspect == "" {
		r.Aspect = d.Aspect
	}
	if r.FPS == 0 {
		r.FPS = d.FPS
	}
	if r.Height == 0 {
		r.Height = d.Height
	}
	return r
}

func validateBeat(r BeatRequest) error {
	r = r.withDefaults()
	switch {
	case !slices.Contains(BeatRecipes, r.RecipeID):
		return vErr("recipeId", "Pick one of the cutting styles")
	case r.Seed < 1 || r.Seed > maxBeatSeed:
		return vErr("seed", "The seed is a positive number")
	case !slices.Contains([]string{"recipe", "sequential", "shuffleNoRepeat", "byTag"}, r.Order):
		return vErr("order", "Pick how clips are chosen")
	case r.StartMs < 0:
		return vErr("startMs", "The start can't be negative")
	case r.LengthMs < MinEditMs || r.LengthMs > MaxEditMs:
		return vErr("lengthMs", "The edit is 1 second to 10 minutes long")
	case !slices.Contains(aspects, r.Aspect):
		return vErr("aspect", "Pick 9:16, 4:5, 1:1 or 16:9")
	case !slices.Contains(fpsValues, r.FPS):
		return vErr("fps", "Pick 30 or 60 fps")
	case !slices.Contains(exportHeights, r.Height):
		return vErr("height", "Pick 720, 1080 or 1440")
	}
	return nil
}

// beatBase is the edit the recipe fills: the song's range, its analysis, the
// clips as sources and one empty video track.
func beatBase(r BeatRequest, song string, endMs int64, ref viz.AnalysisRef, clips []videoeditor.ClipInfo) EditProject {
	doc := NewProject(r.Aspect, r.FPS, r.Seed)
	doc.ExportHeight = r.Height
	doc.Song = &Song{Path: song, StartMs: r.StartMs, EndMs: endMs, FadeOutMs: 500}
	doc.AnalysisKey = ref.Key
	doc.Sources = make([]Source, 0, len(clips))
	for _, c := range clips {
		doc.Sources = append(doc.Sources, Source{Path: c.Path, Tags: []string{}})
	}
	return doc
}

// recipeSources describes the clips for the recipe; shots lists the cut
// points already known for a clip (nil = unknown).
func recipeSources(clips []videoeditor.ClipInfo, shots func(path string) []int64) []viz.RecipeSource {
	out := make([]viz.RecipeSource, 0, len(clips))
	for _, c := range clips {
		s := viz.RecipeSource{Path: c.Path, Kind: c.Kind, Tags: []string{}}
		if c.Kind == "video" {
			s.DurationMs = c.DurationMs
			if shots != nil {
				s.Shots = shots(c.Path)
			}
		}
		out = append(out, s)
	}
	return out
}

// Seams for tests.
var (
	beatBuildFn = func(ctx context.Context, br *viz.RenderBroker, job *core.JobContext, plan viz.RecipePlan, ref viz.AnalysisRef) (string, error) {
		if br == nil {
			return "", core.Errorf(core.CodeInternal, "The edit builder isn't available")
		}
		return br.BuildEdit(ctx, job, plan, ref)
	}
	beatRenderFn = (*Module).renderDoc
)

// Progress split of a beat job.
const (
	beatAnalyzeTo = 0.2
	beatBuildTo   = 0.25
)

// runBeat is the beat action.
func (m *Module) runBeat(ctx context.Context, job *core.JobContext, req BeatRequest) error {
	req = req.withDefaults()
	if err := validateBeat(req); err != nil {
		return err
	}
	if req.Song == "" {
		return vErr("song", "Add a song to cut to")
	}
	if len(job.Inputs) == 0 {
		return vErr("inputs", "Add some clips or photos")
	}
	if _, err := job.Tool("ffmpeg"); err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	job.SetTitle("Cutting to the beat — " + filepath.Base(req.Song))

	job.Progress(core.IndeterminateProgress, "Reading the files…")
	infos := exportProbeFn(ctx, ffprobe, append([]string{req.Song}, job.Inputs...))
	if err := ctx.Err(); err != nil {
		return err
	}
	song := infos[0]
	if song.Error != "" || song.Kind != "audio" {
		why := "isn't a song"
		if song.Error != "" {
			why = song.Error
		}
		return core.Errorf(core.CodeNotFound, "%s: %s", filepath.Base(req.Song), why)
	}
	clips, _, err := splitInputs(infos[1:])
	if err != nil {
		return err
	}
	if len(clips) == 0 {
		return vErr("inputs", "Add some clips or photos")
	}
	end := min(song.DurationMs, req.StartMs+req.LengthMs)
	if end-req.StartMs < MinEditMs {
		return vErr("startMs", "There is less than a second of song after the start")
	}

	ref, err := m.analyze(ctx, job.Scoped(0, beatAnalyzeTo), req.Song, viz.AnalyzeOptions{Stems: true, Words: viz.WordsNone})
	if err != nil {
		return err
	}
	base := beatBase(req, req.Song, end, ref, clips)
	pj, err := json.Marshal(normalize(base))
	if err != nil {
		return fmt.Errorf("encode project: %w", err)
	}
	job.Progress(beatAnalyzeTo, "Choosing the cuts…")
	built, err := beatBuildFn(ctx, m.cfg.Broker, job.Scoped(beatAnalyzeTo, beatBuildTo), viz.RecipePlan{
		ProjectJSON: string(pj), RecipeID: req.RecipeID, Seed: req.Seed, Order: req.Order,
		Sources: recipeSources(clips, m.ShotsFor),
	}, ref)
	if err != nil {
		return err
	}
	var doc EditProject
	if err := json.Unmarshal([]byte(built), &doc); err != nil {
		return core.Errorf(core.CodeInternal, "The cutting step returned an edit that couldn't be read").WithCause(err)
	}
	doc = normalize(doc)
	doc.Song, doc.AnalysisKey = base.Song, base.AnalysisKey // the recipe never changes these
	if err := validateShape(doc); err != nil {
		return err
	}
	clipCount := 0
	for _, t := range doc.Tracks {
		clipCount += len(t.Clips)
	}
	if clipCount == 0 {
		return core.Errorf(core.CodeToolFailed, "The cutting style made no cuts").
			WithHint("Try another style, or give it more clips")
	}
	name := req.Name
	if strings.TrimSpace(name) == "" {
		name = strings.TrimSuffix(filepath.Base(req.Song), filepath.Ext(req.Song))
	}
	return beatRenderFn(m, ctx, job.Scoped(beatBuildTo, 1), "", name, doc)
}
