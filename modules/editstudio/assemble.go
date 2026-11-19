package editstudio

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/modules/videoeditor"
)

// "Assemble a video" (Phase 14 A2): the Video Editor as a pipeline step. The
// inputs go end to end into a new edit, or replace the clips of a saved edit
// used as a template. The edit is built in memory and exported by the same
// code as the Export button (renderDoc).

// AssembleRequest is both the step's options and the assemble job's request.
type AssembleRequest struct {
	TemplateID   string `json:"templateId"`   // a saved edit whose clips are replaced in order; "" = a new edit
	TemplateName string `json:"templateName"` // a label only
	Transition   string `json:"transition"`   // "cut" | "crossfade" (a template keeps its own transitions unless this is crossfade)
	TransitionMs int    `json:"transitionMs"` // crossfade length, 100..2000; 0 = 500
	Title        string `json:"title"`        // text over the start of the video; "" = none; takes {vars}
	TitleMs      int    `json:"titleMs"`      // 500..10000; 0 = 3000
	Music        string `json:"music"`        // a music bed's path (takes {vars}); "" = the template's, or an audio input, or none
	Aspect       string `json:"aspect"`       // new edits: "9:16" | "4:5" | "1:1" | "16:9"
	FPS          int    `json:"fps"`          // new edits: 30 | 60
	Height       int    `json:"height"`       // export short side: 720 | 1080 | 1440
	StillMs      int    `json:"stillMs"`      // how long a photo shows; 0 = 3000
	Fit          string `json:"fit"`          // new edits: "fill" | "fit" | "fit-blur"
	Name         string `json:"name"`         // output file name; takes {vars}; "" = the template's name, or the first clip's
}

// Defaults of the Assemble step.
const (
	defaultTransitionMs = 500
	defaultTitleMs      = 3000
	defaultStillMs      = 3000
	minClipMs           = 100
)

// DefaultAssembleRequest: portrait 1080p30, cuts, 3 s photos.
func DefaultAssembleRequest() AssembleRequest {
	return AssembleRequest{Transition: "cut", TransitionMs: defaultTransitionMs, TitleMs: defaultTitleMs,
		Aspect: "9:16", FPS: 30, Height: 1080, StillMs: defaultStillMs, Fit: "fill"}
}

// withDefaults fills unset fields.
func (r AssembleRequest) withDefaults() AssembleRequest {
	d := DefaultAssembleRequest()
	if r.Transition == "" {
		r.Transition = d.Transition
	}
	if r.TransitionMs == 0 {
		r.TransitionMs = d.TransitionMs
	}
	if r.TitleMs == 0 {
		r.TitleMs = d.TitleMs
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
	if r.StillMs == 0 {
		r.StillMs = d.StillMs
	}
	if r.Fit == "" {
		r.Fit = d.Fit
	}
	return r
}

// validateAssemble checks the request's shape.
func validateAssemble(r AssembleRequest) error {
	r = r.withDefaults()
	switch {
	case r.Transition != "cut" && r.Transition != "crossfade":
		return vErr("transition", "Pick cut or crossfade")
	case r.TransitionMs < 100 || r.TransitionMs > 2000:
		return vErr("transitionMs", "A crossfade lasts 0.1–2 seconds")
	case r.TitleMs < 500 || r.TitleMs > 10_000:
		return vErr("titleMs", "The title shows for 0.5–10 seconds")
	case utf8.RuneCountInString(r.Title) > MaxClipText:
		return vErr("title", fmt.Sprintf("The title is at most %d characters", MaxClipText))
	case !slices.Contains(aspects, r.Aspect):
		return vErr("aspect", "Pick 9:16, 4:5, 1:1 or 16:9")
	case !slices.Contains(fpsValues, r.FPS):
		return vErr("fps", "Pick 24, 25, 30 or 60 fps")
	case !slices.Contains(exportHeights, r.Height):
		return vErr("height", "Pick 720, 1080 or 1440")
	case r.StillMs < 500 || r.StillMs > 60_000:
		return vErr("stillMs", "A photo shows for 0.5–60 seconds")
	case r.Fit != "fill" && r.Fit != "fit" && r.Fit != "fit-blur":
		return vErr("fit", "Pick fill, fit or fit with a blurred background")
	}
	return nil
}

// MaxClipText is the longest text clip (frontend MAX_CLIP_TEXT).
const MaxClipText = 500

// assembleDoc builds the edit. infos are the clips in order (video and photo
// only, all readable); template is nil for a new edit. It returns the edit and
// notes for the job log.
func assembleDoc(r AssembleRequest, template *EditProject, infos []videoeditor.ClipInfo, music string, seed int64) (EditProject, []string, error) {
	r = r.withDefaults()
	var notes []string
	if len(infos) == 0 {
		return EditProject{}, nil, vErr("inputs", "Add some clips or photos")
	}
	var doc EditProject
	var err error
	if template != nil {
		doc, err = assembleIntoTemplate(r, *template, infos, &notes)
	} else {
		doc, err = assembleNew(r, infos, music != "", seed)
	}
	if err != nil {
		return EditProject{}, nil, err
	}

	if strings.TrimSpace(r.Title) != "" {
		if len(doc.Tracks) >= MaxTracks {
			notes = append(notes, "The title was left out: the template already has the most tracks an edit can have")
		} else {
			d := editLen(doc)
			doc.Tracks = append(doc.Tracks, Track{ID: "title", Kind: "video", Name: "Title", Clips: []Clip{
				titleClip(r.Title, min(int64(r.TitleMs), d))}})
		}
	}

	if music != "" {
		d := editLen(doc)
		song := &Song{Path: music, StartMs: 0, EndMs: d, FadeOutMs: min(1500, d/4)}
		if doc.Song != nil {
			*song = *doc.Song
			song.Path = music
			if doc.AnalysisKey != "" {
				doc.AnalysisKey = ""
				notes = append(notes, "The template's song analysis was dropped: the music bed is a different song")
			}
		}
		doc.Song = song
	}
	doc = normalize(doc)
	if err := validateShape(doc); err != nil {
		return EditProject{}, nil, err
	}
	return doc, notes, nil
}

// clipFor makes a timeline clip of a probed source.
func clipFor(id string, info videoeditor.ClipInfo, start, length int64, fit string, volume float64) Clip {
	c := Clip{ID: id, Kind: info.Kind, Path: info.Path, StartMs: start, EndMs: start + length,
		Volume: volume, Fit: fit, FitColor: "#000000", Blend: "normal", FxTarget: "clip"}
	if info.Kind != "video" {
		c.Volume = 0
	}
	return c
}

func crossfade(ms int64) string { return fmt.Sprintf(`{"kind":"crossfade","ms":%d}`, ms) }

// assembleNew lays the clips end to end on one track.
func assembleNew(r AssembleRequest, infos []videoeditor.ClipInfo, withMusic bool, seed int64) (EditProject, error) {
	if len(infos) > MaxClips {
		return EditProject{}, vErr("inputs", fmt.Sprintf("At most %d clips in an edit", MaxClips))
	}
	doc := NewProject(r.Aspect, r.FPS, seed)
	doc.ExportHeight = r.Height
	volume := 1.0
	if withMusic {
		volume = 0 // the music bed replaces the camera sound
	}
	var t int64
	clips := make([]Clip, 0, len(infos))
	for i, info := range infos {
		length := info.DurationMs
		if info.Kind == "image" {
			length = int64(r.StillMs)
		}
		if length < minClipMs {
			return EditProject{}, core.Errorf(core.CodeNotFound, "%s has no length to cut", filepath.Base(info.Path))
		}
		c := clipFor(fmt.Sprintf("c%d", i+1), info, t, length, r.Fit, volume)
		clips = append(clips, c)
		t += length
	}
	if t > MaxEditMs {
		return EditProject{}, vErr("inputs", fmt.Sprintf("These clips add up to %d minutes; an edit is at most %d", (t+59_999)/60_000, MaxEditMs/60_000))
	}
	if r.Transition == "crossfade" {
		for i := 1; i < len(clips); i++ {
			n := int64(r.TransitionMs)
			n = min(n, (clips[i].EndMs-clips[i].StartMs)/2, (clips[i-1].EndMs-clips[i-1].StartMs)/2)
			if n >= minClipMs/2 {
				clips[i].In = crossfade(n)
			}
		}
	}
	doc.Tracks[0].Clips = clips
	for _, info := range infos {
		doc.Sources = append(doc.Sources, Source{Path: info.Path, Tags: []string{}})
	}
	return doc, nil
}

// assembleIntoTemplate replaces the clips of the template's first track that
// has video or photo clips, in order. The template's timing, effects, fits and
// transitions stay; extra template clips are dropped, extra inputs are left out.
func assembleIntoTemplate(r AssembleRequest, tmpl EditProject, infos []videoeditor.ClipInfo, notes *[]string) (EditProject, error) {
	raw, err := json.Marshal(tmpl)
	if err != nil {
		return EditProject{}, fmt.Errorf("copy template: %w", err)
	}
	var doc EditProject
	if err := json.Unmarshal(raw, &doc); err != nil {
		return EditProject{}, fmt.Errorf("copy template: %w", err)
	}
	doc = normalize(doc)
	main := -1
	for i, t := range doc.Tracks {
		if t.Kind != "video" {
			continue
		}
		for _, c := range t.Clips {
			if c.Kind == "video" || c.Kind == "image" {
				main = i
				break
			}
		}
		if main >= 0 {
			break
		}
	}
	if main < 0 {
		return EditProject{}, vErr("templateId", "This template has no clips or photos to replace")
	}
	slots := doc.Tracks[main].Clips
	slices.SortStableFunc(slots, func(a, b Clip) int { return int(a.StartMs - b.StartMs) })
	kept := slots // colour, text and visual clips stay where they are
	// Index the replaceable clips (video/image) in order.
	var idx []int
	for i, c := range kept {
		if c.Kind == "video" || c.Kind == "image" {
			idx = append(idx, i)
		}
	}
	n := min(len(idx), len(infos))
	if len(infos) > len(idx) {
		*notes = append(*notes, fmt.Sprintf("The template has %d clip slots; the last %d input(s) were left out", len(idx), len(infos)-len(idx)))
	}
	drop := map[int]bool{}
	for j, at := range idx {
		if j >= n {
			drop[at] = true
			continue
		}
		c := kept[at]
		info := infos[j]
		c.Kind, c.Path, c.InMs = info.Kind, info.Path, 0
		c.Matte = nil
		if c.FxTarget != "clip" {
			c.FxTarget = "clip" // subject/background effects need the old clip's cut-out
		}
		c.Auto = false
		if c.Fit == "" {
			c.Fit = r.Fit
		}
		if r.Transition == "crossfade" && j > 0 {
			c.In = crossfade(min(int64(r.TransitionMs), (c.EndMs-c.StartMs)/2))
		}
		if info.Kind == "image" {
			c.Volume, c.Slow = 0, ""
		}
		kept[at] = c
	}
	var out []Clip
	for i, c := range kept {
		if !drop[i] {
			out = append(out, c)
		}
	}
	doc.Tracks[main].Clips = out
	if len(out) == 0 {
		return EditProject{}, vErr("templateId", "This template has no clips or photos to replace")
	}
	doc.Sources = nil
	for _, info := range infos[:n] {
		doc.Sources = append(doc.Sources, Source{Path: info.Path, Tags: []string{}})
	}
	return doc, nil
}

// titleClip is a centred title card of the given length.
func titleClip(text string, ms int64) Clip {
	style := map[string]any{"preset": "fade", "size": 12, "weight": 900, "uppercase": false, "position": "center"}
	b, _ := json.Marshal(map[string]any{"text": text, "style": style, "reveal": "all", "wordMs": 250, "lane": "beat", "every": 1})
	return Clip{ID: "title1", Kind: "text", StartMs: 0, EndMs: ms, Text: string(b), Fit: "fill", FitColor: "#000000", Blend: "normal", FxTarget: "clip"}
}

// splitInputs separates the probed inputs into picture/video clips and the
// first audio file (a music bed). Unreadable files fail the job.
func splitInputs(infos []videoeditor.ClipInfo) (clips []videoeditor.ClipInfo, audio string, err error) {
	for _, info := range infos {
		if info.Error != "" {
			return nil, "", core.Errorf(core.CodeNotFound, "%s: %s", filepath.Base(info.Path), info.Error)
		}
		switch info.Kind {
		case "video", "image":
			clips = append(clips, info)
		case "audio":
			if audio == "" {
				audio = info.Path
			}
		default:
			return nil, "", core.Errorf(core.CodeToolFailed, "%s isn't a video, photo or song", filepath.Base(info.Path))
		}
	}
	return clips, audio, nil
}

// assembleRenderFn is replaced by tests.
var assembleRenderFn = (*Module).renderDoc

// runAssemble is the assemble action.
func (m *Module) runAssemble(ctx context.Context, job *core.JobContext, req AssembleRequest) error {
	req = req.withDefaults()
	if err := validateAssemble(req); err != nil {
		return err
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
	job.SetTitle("Assembling a video")
	job.Progress(core.IndeterminateProgress, "Reading the clips…")
	infos := exportProbeFn(ctx, ffprobe, job.Inputs)
	if err := ctx.Err(); err != nil {
		return err
	}
	clips, audio, err := splitInputs(infos)
	if err != nil {
		return err
	}
	music := req.Music
	if music == "" {
		music = audio
	}

	var tmpl *EditProject
	name := req.Name
	if req.TemplateID != "" {
		stored, err := m.docs.Load(ctx, req.TemplateID)
		if err != nil {
			return err
		}
		t, err := m.Get(ctx, req.TemplateID)
		if err != nil {
			return err
		}
		tmpl = &t
		if strings.TrimSpace(name) == "" {
			name = stored.Name
		}
	}
	if strings.TrimSpace(name) == "" && len(clips) > 0 {
		name = strings.TrimSuffix(filepath.Base(clips[0].Path), filepath.Ext(clips[0].Path))
	}
	doc, notes, err := assembleDoc(req, tmpl, clips, music, randomSeed())
	if err != nil {
		return err
	}
	for _, n := range notes {
		job.Logf("%s", n)
	}
	return assembleRenderFn(m, ctx, job, req.TemplateID, name, doc)
}
