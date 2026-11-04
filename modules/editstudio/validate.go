package editstudio

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/viz"
)

// Validation of documents and requests (SPEC.md §6.1, §11.2).

var (
	aspects       = []string{"9:16", "4:5", "1:1", "16:9"}
	fpsValues     = []int{30, 60}
	exportHeights = []int{720, 1080, 1440}
	fits          = []string{"fill", "fit", "fit-blur", "fit-color"}
	slows         = []string{"blend", "none", "interpolate"}
	blends        = []string{"normal", "add", "screen", "multiply", "overlay", "softlight", "hardlight", "difference", "exclusion", "lighten", "darken", "colordodge"}
	trackMattes   = []string{"", "alpha", "alpha-inverted", "luma", "luma-inverted"}
	fxTargets     = []string{"clip", "subject", "background"}
	matteModes    = []string{MattePeople, MatteSelect, MatteImage}
	textKinds     = []string{TextMarkersCSV, TextMarkersJSON, TextSRT}
	laneIDs       = []string{"beat", "downbeat", "kick", "snare", "hats", "bass", "vocals", "other", "accent",
		"section", "drop", "lift", "break", "stop", "phrase", "word", "custom"}
	colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	idRe    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	tagRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9 _-]{0,23}$`)
)

// vErr builds a validation error for one field.
func vErr(field, msg string) *core.AppError {
	return core.ValidationError(msg, map[string]string{field: msg})
}

// jsonField checks a JSON-in-string field ("" is allowed).
func jsonField(field, v string, limit int) error {
	if v == "" {
		return nil
	}
	if len(v) > limit {
		return vErr(field, fmt.Sprintf("This is too large (over %d KB)", limit>>10))
	}
	if !json.Valid([]byte(v)) {
		return vErr(field, "This setting is damaged")
	}
	return nil
}

func inRange[T int | int64 | float64](field string, v, lo, hi T) error {
	if v < lo || v > hi {
		return vErr(field, fmt.Sprintf("Must be between %v and %v", lo, hi))
	}
	return nil
}

// validateShape checks everything Save needs. Files don't have to exist.
func validateShape(doc EditProject) error {
	if !slices.Contains(aspects, doc.Aspect) {
		return vErr("aspect", "Pick 9:16, 4:5, 1:1 or 16:9")
	}
	if !slices.Contains(fpsValues, doc.FPS) {
		return vErr("fps", "Pick 30 or 60 fps")
	}
	if !slices.Contains(exportHeights, doc.ExportHeight) {
		return vErr("exportHeight", "Pick 720, 1080 or 1440")
	}
	if !colorRe.MatchString(doc.Background) {
		return vErr("background", "Pick a colour")
	}
	if err := inRange("cutOffsetFrames", doc.CutOffsetFrames, -3, 3); err != nil {
		return err
	}
	if doc.Song != nil {
		if err := validateSong(*doc.Song); err != nil {
			return err
		}
	}
	if err := validateMarkers(doc.Markers); err != nil {
		return err
	}
	if len(doc.Sources) > MaxSources {
		return vErr("sources", fmt.Sprintf("At most %d sources", MaxSources))
	}
	for i, s := range doc.Sources {
		f := fmt.Sprintf("sources[%d]", i)
		if s.Path == "" {
			return vErr(f+".path", "A source has no file")
		}
		if len(s.Tags) > 8 {
			return vErr(f+".tags", "At most 8 tags")
		}
		for _, t := range s.Tags {
			if !tagRe.MatchString(t) {
				return vErr(f+".tags", "Tags are 1–24 lower-case letters, digits, spaces, - or _")
			}
		}
	}
	if len(doc.Tracks) < 1 || len(doc.Tracks) > MaxTracks {
		return vErr("tracks", fmt.Sprintf("An edit has 1–%d tracks", MaxTracks))
	}
	trackIDs := map[string]bool{}
	clipIDs := map[string]bool{}
	clips := 0
	for ti, t := range doc.Tracks {
		f := fmt.Sprintf("tracks[%d]", ti)
		if !idRe.MatchString(t.ID) || trackIDs[t.ID] {
			return vErr(f+".id", "Each track needs its own ID")
		}
		trackIDs[t.ID] = true
		if t.Kind != "video" && t.Kind != "adjust" {
			return vErr(f+".kind", "A track is a video or an adjustment track")
		}
		if utf8.RuneCountInString(t.Name) > 40 {
			return vErr(f+".name", "Track names are at most 40 characters")
		}
		if !slices.Contains(trackMattes, t.Matte) || (t.Matte != "" && t.Kind != "video") {
			return vErr(f+".matte", "Unknown track matte")
		}
		var prevEnd int64 = -1
		for ci, c := range t.Clips {
			cf := fmt.Sprintf("%s.clips[%d]", f, ci)
			clips++
			if clips > MaxClips {
				return vErr("tracks", fmt.Sprintf("At most %d clips in an edit", MaxClips))
			}
			if !idRe.MatchString(c.ID) || clipIDs[c.ID] {
				return vErr(cf+".id", "Each clip needs its own ID")
			}
			clipIDs[c.ID] = true
			if err := validateClip(cf, t.Kind, c); err != nil {
				return err
			}
			if c.StartMs < prevEnd {
				return vErr(cf+".startMs", "Clips on a track can't overlap")
			}
			prevEnd = c.EndMs
		}
	}
	if doc.Captions != nil {
		if err := jsonField("captions.style", doc.Captions.Style, MaxFieldBytes); err != nil {
			return err
		}
		if err := jsonField("captions.lines", doc.Captions.Lines, MaxLinesBytes); err != nil {
			return err
		}
	}
	if err := jsonField("look", doc.Look, MaxFieldBytes); err != nil {
		return err
	}
	if doc.Recipe != nil {
		if err := jsonField("recipe.options", doc.Recipe.Options, MaxFieldBytes); err != nil {
			return err
		}
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		return fmt.Errorf("encode edit: %w", err)
	}
	if len(raw) > core.MaxProjectBytes {
		return vErr("tracks", "This edit is too large to save")
	}
	return nil
}

func validateSong(s Song) error {
	if s.Path == "" {
		return vErr("song.path", "Pick a song")
	}
	if s.StartMs < 0 || s.EndMs-s.StartMs < MinEditMs || s.EndMs-s.StartMs > MaxEditMs {
		return vErr("song.endMs", "An edit is 1 second to 10 minutes long")
	}
	if err := inRange("song.gainDb", s.GainDb, -24, 12); err != nil {
		return err
	}
	if err := inRange("song.fadeInMs", s.FadeInMs, 0, 10_000); err != nil {
		return err
	}
	return inRange("song.fadeOutMs", s.FadeOutMs, 0, 10_000)
}

func validateMarkers(m MarkerState) error {
	for lane, ls := range m.Lanes {
		f := "markers.lanes." + lane
		if !slices.Contains(laneIDs, lane) {
			return vErr(f, "Unknown marker lane")
		}
		if err := inRange(f+".minStrength", ls.MinStrength, 0, 1); err != nil {
			return err
		}
		if err := inRange(f+".every", ls.Every, 1, 16); err != nil {
			return err
		}
		if err := inRange(f+".nudgeMs", ls.NudgeMs, -200, 200); err != nil {
			return err
		}
	}
	if err := inRange("markers.barOffset", m.BarOffset, 0, 3); err != nil {
		return err
	}
	if len(m.Hidden) > MaxOverrides || len(m.Moved) > MaxOverrides {
		return vErr("markers", "Too many marker changes")
	}
	for id, label := range m.Labels {
		if utf8.RuneCountInString(label) > 24 || utf8.RuneCountInString(id) > 64 {
			return vErr("markers.labels", "Section names are at most 24 characters")
		}
	}
	if len(m.Custom) > MaxCustomMarkers {
		return vErr("markers.custom", fmt.Sprintf("At most %d of your own markers", MaxCustomMarkers))
	}
	ids := map[string]bool{}
	for i, c := range m.Custom {
		f := fmt.Sprintf("markers.custom[%d]", i)
		if !idRe.MatchString(c.ID) || ids[c.ID] {
			return vErr(f+".id", "Each marker needs its own ID")
		}
		ids[c.ID] = true
		if c.Ms < 0 {
			return vErr(f+".ms", "A marker can't be before the song starts")
		}
		if utf8.RuneCountInString(c.Label) > 40 {
			return vErr(f+".label", "Marker notes are at most 40 characters")
		}
	}
	return nil
}

func validateClip(f, trackKind string, c Clip) error {
	switch c.Kind {
	case "video", "image", "color", "text", "visual":
		if trackKind != "video" {
			return vErr(f+".kind", "Adjustment tracks only hold adjustment clips")
		}
	case "adjust":
		if trackKind != "adjust" {
			return vErr(f+".kind", "Adjustment clips go on adjustment tracks")
		}
	default:
		return vErr(f+".kind", "Unknown clip kind")
	}
	if (c.Kind == "video" || c.Kind == "image") && c.Path == "" {
		return vErr(f+".path", "This clip has no file")
	}
	if c.Kind == "color" && !colorRe.MatchString(c.Color) {
		return vErr(f+".color", "Pick a colour")
	}
	if c.Kind == "text" && c.Text == "" {
		return vErr(f+".text", "This text clip has no text")
	}
	if c.Kind == "visual" && c.Visual == "" {
		return vErr(f+".visual", "Pick a visual")
	}
	if c.StartMs < 0 || c.EndMs <= c.StartMs {
		return vErr(f+".endMs", "A clip must end after it starts")
	}
	if c.InMs < 0 {
		return vErr(f+".inMs", "The in point can't be negative")
	}
	if err := inRange(f+".volume", c.Volume, 0, 2); err != nil {
		return err
	}
	enums := []struct {
		field, v string
		set      []string
	}{
		{"fit", c.Fit, fits}, {"slow", c.Slow, slows}, {"blend", c.Blend, blends}, {"fxTarget", c.FxTarget, fxTargets},
	}
	for _, e := range enums {
		if e.v != "" && !slices.Contains(e.set, e.v) {
			return vErr(f+"."+e.field, "Unknown setting")
		}
	}
	if c.FitColor != "" && !colorRe.MatchString(c.FitColor) {
		return vErr(f+".fitColor", "Pick a colour")
	}
	for _, j := range []struct{ field, v string }{
		{"speed", c.Speed}, {"transform", c.Transform}, {"masks", c.Masks}, {"effects", c.Effects}, {"in", c.In}, {"text", c.Text}, {"visual", c.Visual},
	} {
		if err := jsonField(f+"."+j.field, j.v, MaxFieldBytes); err != nil {
			return err
		}
	}
	if c.Matte != nil {
		if err := validateMatteDoc(f+".matte", c.Kind, *c.Matte); err != nil {
			return err
		}
	}
	return nil
}

func validateMatteDoc(f, clipKind string, mt Matte) error {
	if !slices.Contains(matteModes, mt.Mode) {
		return vErr(f+".mode", "Unknown cut-out kind")
	}
	if (mt.Mode == MatteImage) != (clipKind == "image") {
		return vErr(f+".mode", "Photos use photo cut-outs; videos use people or subject cut-outs")
	}
	if mt.ID != "" && !idRe.MatchString(mt.ID) {
		return vErr(f+".id", "This cut-out is damaged")
	}
	if mt.FromMs < 0 || mt.ToMs < mt.FromMs {
		return vErr(f+".toMs", "This cut-out's range is invalid")
	}
	if len(mt.Clicks) > MaxClicks {
		return vErr(f+".clicks", fmt.Sprintf("At most %d clicks", MaxClicks))
	}
	for _, k := range mt.Clicks {
		if k.X < 0 || k.X > 1 || k.Y < 0 || k.Y > 1 || k.Ms < 0 {
			return vErr(f+".clicks", "A click is outside the picture")
		}
	}
	if err := inRange(f+".feather", mt.Feather, 0, 1); err != nil {
		return err
	}
	if err := inRange(f+".stroke.px", mt.Stroke.Px, 0, 40); err != nil {
		return err
	}
	if err := inRange(f+".glow.amount", mt.Glow.Amount, 0, 1); err != nil {
		return err
	}
	for _, c := range []struct{ field, v string }{{"stroke.color", mt.Stroke.Color}, {"glow.color", mt.Glow.Color}} {
		if c.v != "" && !colorRe.MatchString(c.v) {
			return vErr(f+"."+c.field, "Pick a colour")
		}
	}
	return nil
}

// validateDoc checks what an export needs besides the shape (§6.1).
func (m *Module) validateDoc(ctx context.Context, projectID string, doc EditProject) error {
	if err := validateShape(doc); err != nil {
		return err
	}
	if doc.Song == nil {
		return vErr("song", "Pick a song first")
	}
	if !fileExists(doc.Song.Path) {
		return vErr("song.path", "The song "+baseName(doc.Song.Path)+" is missing")
	}
	if doc.AnalysisKey == "" || m.cfg.Analyzer == nil {
		return vErr("analysisKey", "Analyze the song first")
	}
	if _, ok := m.cfg.Analyzer.Lookup(doc.AnalysisKey); !ok {
		return vErr("analysisKey", "The song's analysis isn't cached any more. Analyze it again")
	}
	visible := 0
	for ti, t := range doc.Tracks {
		if t.Muted {
			continue
		}
		for ci, c := range t.Clips {
			if err := ctx.Err(); err != nil {
				return err
			}
			f := fmt.Sprintf("tracks[%d].clips[%d]", ti, ci)
			if c.Path != "" && !fileExists(c.Path) {
				return vErr(f+".path", baseName(c.Path)+" is missing")
			}
			if c.Matte != nil {
				ok, err := m.matteReady(projectID, c, doc.FPS)
				if err != nil {
					return err
				}
				if !ok {
					return vErr(f+".matte", "The cut-out of "+clipName(c)+" isn't ready. Rebuild it or remove it")
				}
			}
			if t.Kind == "video" && c.StartMs < songLen(doc) {
				visible++
			}
		}
	}
	if visible == 0 {
		return vErr("tracks", "Add a clip to the edit first")
	}
	return nil
}

// songLen is D (§4).
func songLen(doc EditProject) int64 {
	if doc.Song == nil {
		return 0
	}
	return doc.Song.EndMs - doc.Song.StartMs
}

func clipName(c Clip) string {
	if c.Path != "" {
		return baseName(c.Path)
	}
	return "a clip"
}

func baseName(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

// Request validators.

func validateAnalyze(r AnalyzeRequest) error {
	if r.Song == "" {
		return vErr("song", "Pick a song to analyze")
	}
	switch r.Words {
	case "", viz.WordsNone, viz.WordsDetect:
	case viz.WordsAlign:
		if strings.TrimSpace(r.LyricsText) == "" {
			return vErr("lyricsText", "Paste the lyrics to align")
		}
		if utf8.RuneCountInString(r.LyricsText) > viz.MaxLyricsChars {
			return vErr("lyricsText", fmt.Sprintf("Lyrics are at most %d characters", viz.MaxLyricsChars))
		}
	default:
		return vErr("words", "Pick none, detect or your lyrics")
	}
	return nil
}

func validatePrepare(r PrepareRequest) error {
	if len(r.Paths) < 1 || len(r.Paths) > MaxSources {
		return vErr("paths", fmt.Sprintf("Prepare 1–%d files at a time", MaxSources))
	}
	if !slices.Contains(fpsValues, r.FPS) {
		return vErr("fps", "Pick 30 or 60 fps")
	}
	return nil
}

func validateInterp(r InterpRequest) error {
	if r.Path == "" {
		return vErr("path", "Pick a clip")
	}
	if !slices.Contains(fpsValues, r.FPS) {
		return vErr("fps", "Pick 30 or 60 fps")
	}
	if r.FromMs < 0 || r.ToMs <= r.FromMs || r.ToMs-r.FromMs > MaxInterpMs {
		return vErr("toMs", "Slow motion covers up to 30 seconds of a clip")
	}
	return nil
}

func validateMatte(r MatteRequest) error {
	if !idRe.MatchString(r.ClipID) {
		return vErr("clipId", "Pick a clip")
	}
	if !idRe.MatchString(r.MatteID) {
		return vErr("matteId", "This cut-out is damaged")
	}
	if !slices.Contains(matteModes, r.Mode) {
		return vErr("mode", "Unknown cut-out kind")
	}
	if r.Path == "" {
		return vErr("path", "This clip has no file")
	}
	if r.Mode != MatteImage {
		if r.FromMs < 0 || r.ToMs <= r.FromMs {
			return vErr("toMs", "The clip's range is empty")
		}
		if r.Mode == MatteSelect && r.ToMs-r.FromMs > MaxSelectMs {
			return vErr("toMs", "Subject select covers up to 60 seconds of a clip")
		}
	}
	if r.Mode == MatteSelect {
		if len(r.Clicks) == 0 {
			return vErr("clicks", "Click the subject first")
		}
		if len(r.Clicks) > MaxClicks {
			return vErr("clicks", fmt.Sprintf("At most %d clicks", MaxClicks))
		}
		hasPositive := false
		for _, k := range r.Clicks {
			if k.X < 0 || k.X > 1 || k.Y < 0 || k.Y > 1 || k.Ms < 0 {
				return vErr("clicks", "A click is outside the picture")
			}
			hasPositive = hasPositive || k.Positive
		}
		if !hasPositive {
			return vErr("clicks", "Click the subject at least once")
		}
	} else if r.Preview {
		return vErr("preview", "Only subject select has a preview")
	}
	return nil
}

func validateText(r TextRequest) error {
	if !slices.Contains(textKinds, r.Kind) {
		return vErr("kind", "Unknown file type")
	}
	if strings.TrimSpace(r.Name) == "" {
		return vErr("name", "Name the file")
	}
	if len(r.Markers) > MaxTextRows || len(r.Cues) > MaxTextRows {
		return vErr("markers", fmt.Sprintf("At most %d rows", MaxTextRows))
	}
	if r.Kind == TextSRT && len(r.Cues) == 0 {
		return vErr("cues", "There are no captions to save")
	}
	if r.Kind != TextSRT && len(r.Markers) == 0 {
		return vErr("markers", "There are no markers to save")
	}
	if r.Meta != "" && !json.Valid([]byte(r.Meta)) {
		return vErr("meta", "This setting is damaged")
	}
	return nil
}
