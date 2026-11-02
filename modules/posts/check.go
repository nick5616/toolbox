package posts

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/media"
	"toolbox/core/sidecar"
	"toolbox/modules/composer"
	"toolbox/modules/videoeditor"
)

// Issue levels.
const (
	LevelError   = "error"
	LevelWarning = "warning"
	LevelNote    = "note"
)

var (
	hashtagRe = regexp.MustCompile(`#[\p{L}\p{N}_]+`)
	mentionRe = regexp.MustCompile(`(?:^|[^\p{L}\p{N}_.])@[A-Za-z0-9._]+`)
)

// compositions is what the post needs from the Photo Composer.
type compositions interface {
	Get(ctx context.Context, id string) (composer.Composition, error)
	RenderPath(id string) (string, error)
}

// videos is what the post needs from the Video Editor.
type videos interface {
	Get(ctx context.Context, id string) (videoeditor.VideoProject, error)
	RenderProject(ctx context.Context, job *core.JobContext, doc videoeditor.VideoProject, outPath string, o videoeditor.RenderOptions) error
}

// tool resolves a dependency to a path without a job (Check, SlideInfo).
func (m *Module) tool(id string) (string, error) {
	if m.cfg.Resolve != nil {
		return m.cfg.Resolve(id)
	}
	return exec.LookPath(id)
}

// maxClipMs is the longest video a slide of this post may have.
func maxClipMs(l Limits, format string) int64 {
	if format == "reel" {
		return l.MaxReelMs
	}
	return l.MaxClipMs
}

// orientedSize returns a photo's size after EXIF orientation (0,0 when unknown).
func orientedSize(path string) (w, h int, err error) {
	sz, err := imaging.Size(path)
	if err != nil {
		return 0, 0, err
	}
	return sz.W, sz.H, nil // imaging.Size is already upright
}

// Check validates a post against Instagram's limits (SPEC.md §B7.2). It never
// returns nil.
func (m *Module) Check(ctx context.Context, doc Post) []Issue {
	l := DefaultLimits()
	issues := []Issue{}
	add := func(level, slide, format string, args ...any) {
		issues = append(issues, Issue{Level: level, SlideID: slide, Message: fmt.Sprintf(format, args...)})
	}

	switch {
	case len(doc.Slides) == 0:
		add(LevelError, "", "Add at least one slide")
	case len(doc.Slides) > l.MaxSlides:
		add(LevelError, "", "A post has at most %d slides (this one has %d)", l.MaxSlides, len(doc.Slides))
	}
	if doc.Format == "reel" {
		if len(doc.Slides) != 1 || (doc.Slides[0].Kind != "clip" && doc.Slides[0].Kind != "video") {
			add(LevelError, "", "A reel is exactly one video")
		}
	}
	if n := utf8.RuneCountInString(doc.Caption); n > l.MaxCaptionChars {
		add(LevelError, "", "The caption is %d characters; the limit is %d", n, l.MaxCaptionChars)
	}
	if n := len(hashtagRe.FindAllString(doc.Caption, -1)); n > l.MaxHashtags {
		add(LevelError, "", "The caption has %d hashtags; the limit is %d", n, l.MaxHashtags)
	}
	if n := len(mentionRe.FindAllString(doc.Caption, -1)); n > l.MaxMentions {
		add(LevelWarning, "", "The caption has %d @mentions; Instagram allows about %d", n, l.MaxMentions)
	}
	if doc.Aspect == "3:4" {
		add(LevelNote, "", "3:4 is new; check the Instagram app supports it for you")
	}

	fw, fh := FrameSize(doc.Aspect)
	frameAspect := float64(fw) / float64(fh)
	limit := maxClipMs(l, doc.Format)
	engineErr := error(nil)
	engineChecked := false

	for _, s := range doc.Slides {
		switch s.Kind {
		case "photo":
			m.checkPhoto(s, doc, frameAspect, l, add, &engineErr, &engineChecked)
		case "clip":
			m.checkClip(ctx, s, frameAspect, limit, l, add)
		case "composition":
			m.checkComposition(ctx, s, doc, add)
		case "video":
			m.checkVideo(ctx, s, doc, limit, add)
		default:
			add(LevelError, s.ID, "Unknown slide type %q", s.Kind)
		}
	}
	return issues
}

func softWarn(add func(level, slide, format string, args ...any), id string, window float64, l Limits) {
	if int(window+0.5) < l.MinWidth {
		add(LevelWarning, id, "This slide is %d px wide after framing; it may look soft at %d", int(window+0.5), l.MinWidth)
	}
}

func (m *Module) checkPhoto(s Slide, doc Post, aspect float64, l Limits, add func(level, slide, format string, args ...any), engineErr *error, engineChecked *bool) {
	if !fileExists(s.Path) {
		add(LevelError, s.ID, "The photo is missing: %s", s.Path)
		return
	}
	if imaging.IsHEIC(s.Path) {
		if !*engineChecked {
			*engineChecked = true
			_, *engineErr = m.tool(sidecar.DepID)
		}
		if *engineErr != nil && !imaging.HEICAvailable() {
			add(LevelError, s.ID, "HEIC photos need FFmpeg (Media pack) or the AI engine (Image pack); install one in Settings")
		}
		return // size unknown without decoding
	}
	w, h, err := orientedSize(s.Path)
	if err != nil {
		add(LevelError, s.ID, "Couldn't read this photo")
		return
	}
	if s.Rotation == 90 || s.Rotation == 270 {
		w, h = h, w
	}
	_, _, cw, _ := cropWindow(float64(w), float64(h), aspect, s.Zoom, s.PanX, s.PanY)
	softWarn(add, s.ID, cw, l)
	if !doc.KeepLocation && hasGPS(s.Path) {
		add(LevelNote, s.ID, "Location will be removed")
	}
}

func (m *Module) checkClip(ctx context.Context, s Slide, aspect float64, limit int64, l Limits, add func(level, slide, format string, args ...any)) {
	if !fileExists(s.Path) {
		add(LevelError, s.ID, "The clip is missing: %s", s.Path)
		return
	}
	if d := s.OutMs - s.InMs; d > limit {
		add(LevelError, s.ID, "This clip is %d s; the limit is %d s", d/1000, limit/1000)
	}
	ffprobe, err := m.tool("ffprobe")
	if err != nil {
		add(LevelError, s.ID, "FFmpeg isn't installed")
		return
	}
	info, err := media.Probe(ctx, ffprobe, s.Path)
	if err != nil || info.Video == nil {
		add(LevelError, s.ID, "Couldn't read this clip")
		return
	}
	w, h := info.Video.Width, info.Video.Height
	if s.Rotation == 90 || s.Rotation == 270 {
		w, h = h, w
	}
	if w > 0 && h > 0 {
		_, _, cw, _ := cropWindow(float64(w), float64(h), aspect, s.Zoom, s.PanX, s.PanY)
		softWarn(add, s.ID, cw, l)
	}
}

func (m *Module) checkComposition(ctx context.Context, s Slide, doc Post, add func(level, slide, format string, args ...any)) {
	if m.comps == nil {
		add(LevelError, s.ID, "The Photo Composer isn't available")
		return
	}
	c, err := m.comps.Get(ctx, s.ProjectID)
	if err != nil {
		add(LevelError, s.ID, "This composition is missing")
		return
	}
	if p, err := m.comps.RenderPath(s.ProjectID); err != nil || !fileExists(p) {
		add(LevelError, s.ID, "This composition has no saved picture yet; open and save it")
		return
	}
	if c.Aspect != doc.Aspect {
		add(LevelWarning, s.ID, "This composition is %s; it will be framed to fit %s", c.Aspect, doc.Aspect)
	}
}

func (m *Module) checkVideo(ctx context.Context, s Slide, doc Post, limit int64, add func(level, slide, format string, args ...any)) {
	if m.videos == nil {
		add(LevelError, s.ID, "The Video Editor isn't available")
		return
	}
	v, err := m.videos.Get(ctx, s.ProjectID)
	if err != nil {
		add(LevelError, s.ID, "This video project is missing")
		return
	}
	if d := videoeditor.DurationMs(v); d > limit {
		add(LevelError, s.ID, "This video is %d s; the limit is %d s", d/1000, limit/1000)
	}
	if v.Aspect != doc.Aspect {
		add(LevelWarning, s.ID, "This video is %s; it will be framed to fit %s", v.Aspect, doc.Aspect)
	}
}

// firstError returns the first error-level issue.
func firstError(issues []Issue) (Issue, bool) {
	for _, i := range issues {
		if i.Level == LevelError {
			return i, true
		}
	}
	return Issue{}, false
}

func fileExists(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}
