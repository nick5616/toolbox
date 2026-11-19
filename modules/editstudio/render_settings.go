package editstudio

import "toolbox/core/viz"

// Export settings resolved from EditProject.Export (Phase 21 SPEC §B6). Pure.

// exportParams is what a render does with ExportSettings: every zero value
// has been replaced by its default.
type exportParams struct {
	FPS       int    // output rate (the project's when ExportSettings.FPS is 0)
	Codec     string // CodecH264 | CodecH265
	Quality   string
	CRF       int
	Preset    string
	AudioKbps int
	InMs      int64 // range in timeline ms; Ranged false = the whole edit
	OutMs     int64
	Ranged    bool
	Custom    bool // the document has ExportSettings: the rendered stream is re-encoded to the chosen codec and quality
}

// crfFor is the x264 CRF of a quality; x265 runs 4 higher for a similar look.
func exportCRF(codec, quality string) int {
	crf := 20
	switch quality {
	case QualityDraft:
		crf = 26
	case QualityBest:
		crf = 16
	}
	if codec == CodecH265 {
		crf += 4
	}
	return crf
}

// exportPreset is the encoder preset of a quality.
func exportPreset(quality string) string {
	switch quality {
	case QualityDraft:
		return "veryfast"
	case QualityBest:
		return "medium"
	}
	return "fast"
}

// resolveExport applies the defaults: H.264, good, the project's rate,
// 192 kb/s, the whole edit.
func resolveExport(doc EditProject) exportParams {
	p := exportParams{FPS: doc.FPS, Codec: CodecH264, Quality: QualityGood, AudioKbps: defaultAudioKb}
	if ex := doc.Export; ex != nil {
		p.Custom = true
		if ex.FPS != 0 {
			p.FPS = ex.FPS
		}
		if ex.Codec != "" {
			p.Codec = ex.Codec
		}
		if ex.Quality != "" {
			p.Quality = ex.Quality
		}
		if ex.AudioKbps != 0 {
			p.AudioKbps = ex.AudioKbps
		}
		if ex.InMs != 0 || ex.OutMs != 0 {
			p.Ranged, p.InMs, p.OutMs = true, ex.InMs, ex.OutMs
		}
	}
	p.CRF = exportCRF(p.Codec, p.Quality)
	p.Preset = exportPreset(p.Quality)
	return p
}

// withH264 is the fallback when FFmpeg has no libx265.
func (p exportParams) withH264() exportParams {
	p.Codec = CodecH264
	p.CRF = exportCRF(p.Codec, p.Quality)
	return p
}

// lengthMs is the length of what gets exported.
func (p exportParams) lengthMs(editMs int64) int64 {
	if p.Ranged {
		return p.OutMs - p.InMs
	}
	return editMs
}

// applyTo moves a render plan to the export's rate and range: the plan's
// start and end are the edit's (song ms when there is a song), and the range
// is in timeline ms from the edit's start.
func (p exportParams) applyTo(plan *viz.RenderPlan) {
	plan.FPS = p.FPS
	if p.Ranged {
		base := plan.StartMs
		plan.StartMs, plan.EndMs = base+p.InMs, base+p.OutMs
	}
}
