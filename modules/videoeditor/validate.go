package videoeditor

import (
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/media"
)

var (
	speeds     = []float64{0.5, 0.75, 1, 1.5, 2}
	aspects    = []string{"9:16", "4:5", "1:1", "16:9"}
	fits       = []string{"fill", "fit-blur", "fit-color"}
	motions    = []string{"none", "in", "out", "left", "right"}
	looks      = []string{"none", "vivid", "warm", "cool", "mono", "fade", "noir"}
	transKinds = []string{"cut", "fade", "dip", "slide"}
	titleStyle = []string{"title", "lower-third", "caption", "label"}
	titlePos   = []string{"top", "center", "bottom"}
	colorRe    = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

const (
	minTransitionMs = 200
	maxTransitionMs = 1500
)

// vErr builds a validation error for one field.
func vErr(field, msg string) *core.AppError {
	return core.ValidationError(msg, map[string]string{field: msg})
}

// normalize fills the defaults of unset fields so the rest of the code can
// rely on them. It copies the slices it changes.
func normalize(doc VideoProject) VideoProject {
	doc.Clips = slices.Clone(doc.Clips)
	for i := range doc.Clips {
		c := &doc.Clips[i]
		if c.Speed <= 0 {
			c.Speed = 1
		}
		if c.Zoom <= 0 {
			c.Zoom = 1
		}
		if c.Fit == "" {
			c.Fit = "fill"
		}
		if c.FitColor == "" {
			c.FitColor = "#000000"
		}
		if c.Motion == "" {
			c.Motion = "none"
		}
		if c.Look == "" {
			c.Look = "none"
		}
		if c.Transition.Kind == "" {
			c.Transition.Kind = "cut"
		}
	}
	doc.Titles = slices.Clone(doc.Titles)
	for i := range doc.Titles {
		t := &doc.Titles[i]
		if t.Style == "" {
			t.Style = "title"
		}
		if t.Position == "" {
			t.Position = "center"
		}
		if t.Color == "" {
			t.Color = "#ffffff"
		}
	}
	return doc
}

// validateShape checks everything about a project that doesn't need the
// files (B6.1). Save uses it alone.
func validateShape(doc VideoProject) error {
	doc = normalize(doc)
	if !slices.Contains(aspects, doc.Aspect) {
		return vErr("aspect", "Pick 9:16, 4:5, 1:1 or 16:9")
	}
	if doc.MaxSizeMB < 0 {
		return vErr("maxSizeMB", "The size limit can't be negative")
	}
	if len(doc.Clips) > MaxClips {
		return vErr("clips", fmt.Sprintf("At most %d clips", MaxClips))
	}
	for i, c := range doc.Clips {
		if err := validateClip(doc.Clips, i, c); err != nil {
			return err
		}
	}
	if DurationMs(doc) > MaxTotalMs {
		return vErr("clips", "The video can be at most 30 minutes long")
	}
	if len(doc.Titles) > MaxTitles {
		return vErr("titles", fmt.Sprintf("At most %d titles", MaxTitles))
	}
	for i, t := range doc.Titles {
		f := fmt.Sprintf("titles[%d]", i)
		switch {
		case strings.TrimSpace(t.Text) == "":
			return vErr(f+".text", "A title needs some text")
		case utf8.RuneCountInString(t.Text) > MaxTitleLen:
			return vErr(f+".text", fmt.Sprintf("A title can have at most %d characters", MaxTitleLen))
		case t.StartMs < 0 || t.DurationMs <= 0:
			return vErr(f+".durationMs", "A title needs a start and a length")
		case !slices.Contains(titleStyle, t.Style):
			return vErr(f+".style", "Unknown title style")
		case !slices.Contains(titlePos, t.Position):
			return vErr(f+".position", "Unknown title position")
		case t.Font != "" && !media.ValidFont(t.Font):
			return vErr(f+".font", "Pick one of the listed fonts")
		case !colorRe.MatchString(t.Color):
			return vErr(f+".color", "Colours look like #ffffff")
		}
	}
	if m := doc.Music; m != nil {
		switch {
		case strings.TrimSpace(m.Path) == "":
			return vErr("music.path", "Pick a song")
		case m.Volume < 0 || m.Volume > 1.5:
			return vErr("music.volume", "Music volume is 0 to 150 %")
		case m.OffsetMs < 0 || m.FadeInMs < 0 || m.FadeOutMs < 0:
			return vErr("music", "Offset and fades can't be negative")
		}
	}
	return nil
}

func validateClip(clips []Clip, i int, c Clip) error {
	f := fmt.Sprintf("clips[%d]", i)
	if strings.TrimSpace(c.Path) == "" {
		return vErr(f+".path", "A clip needs a file")
	}
	if !slices.Contains(speeds, c.Speed) {
		return vErr(f+".speed", "Speed is 0.5×, 0.75×, 1×, 1.5× or 2×")
	}
	if c.Volume < 0 || c.Volume > 2 {
		return vErr(f+".volume", "Volume is 0 to 200 %")
	}
	if !slices.Contains(fits, c.Fit) {
		return vErr(f+".fit", "Unknown framing")
	}
	if !colorRe.MatchString(c.FitColor) {
		return vErr(f+".fitColor", "Colours look like #000000")
	}
	if c.PanX < -1 || c.PanX > 1 || c.PanY < -1 || c.PanY > 1 {
		return vErr(f+".pan", "Pan is -1 to 1")
	}
	if c.Zoom < 1 || c.Zoom > 3 {
		return vErr(f+".zoom", "Zoom is 1× to 3×")
	}
	if !slices.Contains(motions, c.Motion) {
		return vErr(f+".motion", "Unknown photo motion")
	}
	if !slices.Contains(looks, c.Look) {
		return vErr(f+".look", "Unknown look")
	}
	switch c.Kind {
	case "video":
		if c.InMs < 0 || c.OutMs <= c.InMs {
			return vErr(f+".outMs", "The end must be after the start")
		}
		if clipLenMs(c) < MinClipMs {
			return vErr(f+".outMs", "A clip must last at least 0.3 s after speed")
		}
	case "image":
		if c.DurationMs < MinPhotoMs || c.DurationMs > MaxPhotoMs {
			return vErr(f+".durationMs", "A photo lasts 1 to 10 seconds")
		}
	default:
		return vErr(f+".kind", "A clip is a video or an image")
	}
	t := c.Transition
	if !slices.Contains(transKinds, t.Kind) {
		return vErr(f+".transition", "Unknown transition")
	}
	if t.Kind != "cut" && i < len(clips)-1 {
		if t.DurationMs < minTransitionMs || t.DurationMs > maxTransitionMs {
			return vErr(f+".transition", "A transition lasts 0.2 to 1.5 seconds")
		}
		if t.DurationMs > clipLenMs(c)/2 || t.DurationMs > clipLenMs(clips[i+1])/2 {
			return vErr(f+".transition", "A transition can be at most half the length of either clip")
		}
	}
	return nil
}

// missing is the error for a source file that's gone.
func missing(msg, path, field string) *core.AppError {
	e := core.Errorf(core.CodeNotFound, "%s", msg).WithHint(path)
	e.Fields = map[string]string{field: "This file doesn't exist any more"}
	return e
}

// validateDoc is validateShape plus the checks a render needs: at least one
// clip and every file present.
func validateDoc(doc VideoProject) error {
	if len(doc.Clips) == 0 {
		return vErr("clips", "Add at least one clip")
	}
	if err := validateShape(doc); err != nil {
		return err
	}
	for i, c := range doc.Clips {
		if _, err := os.Stat(c.Path); err != nil {
			return missing("A clip's file is missing", c.Path, fmt.Sprintf("clips[%d].path", i))
		}
	}
	if m := doc.Music; m != nil {
		if _, err := os.Stat(m.Path); err != nil {
			return missing("The song is missing", m.Path, "music.path")
		}
	}
	return nil
}

// validatePlan checks a Quick vlog request.
func validatePlan(r PlanRequest) error {
	if len(r.Paths) < 1 || len(r.Paths) > MaxClips {
		return vErr("paths", fmt.Sprintf("Pick 1 to %d clips or photos", MaxClips))
	}
	for _, p := range r.Paths {
		if _, err := os.Stat(p); err != nil {
			return core.Errorf(core.CodeNotFound, "A file is missing").WithHint(p)
		}
	}
	if r.MusicPath != "" {
		if _, err := os.Stat(r.MusicPath); err != nil {
			return core.Errorf(core.CodeNotFound, "The song is missing").WithHint(r.MusicPath)
		}
	}
	if r.BeatCut && r.MusicPath == "" {
		return vErr("musicPath", "Cutting on the beat needs a song")
	}
	if !slices.Contains(aspects, r.Aspect) {
		return vErr("aspect", "Pick 9:16, 4:5, 1:1 or 16:9")
	}
	if r.Order != "" && r.Order != "as-given" && r.Order != "date-taken" {
		return vErr("order", "Order is as given or by date taken")
	}
	if r.TargetMs < 0 || r.TargetMs > MaxTotalMs {
		return vErr("targetMs", "The length is 0 to 30 minutes")
	}
	if r.Transition != "" && !slices.Contains(transKinds, r.Transition) {
		return vErr("transition", "Unknown transition")
	}
	return nil
}
