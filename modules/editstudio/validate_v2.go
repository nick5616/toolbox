package editstudio

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// Document v2 validation (Phase 21 SPEC §B0, §B6, §E3.6).

// Track limits of document v2: up to 12 tracks, at most 8 of them video or
// adjustment tracks (the rest are audio tracks).
const (
	MaxAllTracks    = 12
	MaxVisualTracks = 8
)

// Export choices (ExportSettings).
const (
	CodecH264 = "h264"
	CodecH265 = "h265"

	QualityDraft = "draft"
	QualityGood  = "good"
	QualityBest  = "best"
)

// Output size and gain limits.
const (
	MinSizePx      = 64
	MaxStillPx     = 8192 // a still, long side
	MaxVideoLongPx = 3840 // a video, long side
	gainMinDb      = -60
	gainMaxDb      = 12
	maxGainKeys    = 64
	defaultAudioKb = 192
)

// validateGain checks a clip's Gain JSON loosely: a number (dB), or a
// {base, keys} object whose numbers are dB within −60..+12. The frontend's
// schema (viz/edit/schema.ts) is authoritative; this catches damage.
func validateGain(field, raw string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if err := jsonField(field, raw, MaxFieldBytes); err != nil {
		return err
	}
	g, ok := parseGain(raw)
	if !ok {
		return vErr(field, "This gain setting is damaged")
	}
	if len(g.keys) > maxGainKeys {
		return vErr(field, fmt.Sprintf("At most %d gain keys", maxGainKeys))
	}
	if err := inRange(field, g.base, gainMinDb, gainMaxDb); err != nil {
		return err
	}
	for _, k := range g.keys {
		if err := inRange(field, k.V, gainMinDb, gainMaxDb); err != nil {
			return err
		}
		if k.T < 0 {
			return vErr(field, "A gain key can't be before the clip starts")
		}
	}
	return nil
}

// validateSize checks an explicit output size.
func validateSize(s Size) error {
	if s.W < MinSizePx || s.H < MinSizePx || s.W > MaxStillPx || s.H > MaxStillPx {
		return vErr("size", fmt.Sprintf("A size is %d–%d pixels on each side", MinSizePx, MaxStillPx))
	}
	if s.W%2 != 0 || s.H%2 != 0 {
		return vErr("size", "A size must be an even number of pixels")
	}
	return nil
}

// validateVideoSize is the extra limit of a video export.
func validateVideoSize(w, h int) error {
	if max(w, h) > MaxVideoLongPx {
		return vErr("size", fmt.Sprintf("Videos can be at most %d pixels on the long side", MaxVideoLongPx))
	}
	return nil
}

// validateExport checks the document's ExportSettings.
func validateExport(doc EditProject) error {
	ex := doc.Export
	if ex == nil {
		return nil
	}
	if !slices.Contains(exportFPS, ex.FPS) {
		return vErr("export.fps", "Pick the project rate or 24, 25, 30 or 60 fps")
	}
	if !slices.Contains(exportCodecs, ex.Codec) {
		return vErr("export.codec", "Pick H.264 or H.265")
	}
	if !slices.Contains(exportQuals, ex.Quality) {
		return vErr("export.quality", "Pick draft, good or best")
	}
	if !slices.Contains(exportKbps, ex.AudioKbps) {
		return vErr("export.audioKbps", "Pick 128, 192 or 320 kb/s")
	}
	if ex.InMs == 0 && ex.OutMs == 0 {
		return nil
	}
	if ex.InMs < 0 || ex.OutMs <= ex.InMs {
		return vErr("export.outMs", "The range must end after it starts")
	}
	if ex.OutMs > editLen(doc) {
		return vErr("export.outMs", "The range goes past the end of the edit")
	}
	fps := doc.FPS
	if ex.FPS != 0 {
		fps = ex.FPS
	}
	if fps > 0 && float64(ex.OutMs-ex.InMs)*float64(fps)/1000 < 1 {
		return vErr("export.outMs", "The range is shorter than one frame")
	}
	return nil
}

// ---- gain JSON ----

// gainKey is one key of Clip.Gain (frontend Key; v in dB, t in clip ms).
type gainKey struct {
	T    float64   `json:"t"`
	V    float64   `json:"v"`
	Ease string    `json:"ease"`
	Bez  []float64 `json:"bez"`
}

type gainCurve struct {
	base float64 // dB
	keys []gainKey
}

// parseGain reads Clip.Gain: a bare number (dB) or {base, keys}. ok is false
// for JSON that is neither. "" is 0 dB.
func parseGain(raw string) (gainCurve, bool) {
	var g gainCurve
	if strings.TrimSpace(raw) == "" {
		return g, true
	}
	var n float64
	if json.Unmarshal([]byte(raw), &n) == nil {
		g.base = n
		return g, true
	}
	var o struct {
		Base *float64  `json:"base"`
		Keys []gainKey `json:"keys"`
	}
	if json.Unmarshal([]byte(raw), &o) != nil {
		return g, false
	}
	if o.Base != nil {
		g.base = *o.Base
	}
	g.keys = o.Keys
	return g, true
}
