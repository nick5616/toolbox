package editstudio

import (
	"context"
	"encoding/json"
	"slices"

	"toolbox/core"
	"toolbox/core/media"
)

// Phase 10 (SPEC.md §5): Edit Studio is composed on top of the Video Editor.
// Both tools edit the same document (project kind "edit"). The Video Editor
// is the baseline: tracks, clips, effects, cut-outs, text and an optional
// music bed. Edit Studio adds the music layer: the song's analysis, marker
// lanes, beat sync, auto-fill, section styles, moments and word captions.

// VideoModuleID is the baseline Video Editor's module ID. (The older
// sequence editor keeps the ID "video-editor"; see modules/videoeditor.)
const VideoModuleID = "video-studio"

// VideoModule is the baseline Video Editor. It runs the same jobs as Edit
// Studio (prepare, interp, matte, render, text); jobs for projects without a
// song analysis are filed under it (SPEC.md §5.6).
type VideoModule struct{ m *Module }

// NewVideoModule wraps an Edit Studio module as the Video Editor.
func NewVideoModule(m *Module) *VideoModule { return &VideoModule{m: m} }

// Descriptor implements core.Module.
func (v *VideoModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: VideoModuleID, Name: "Video Editor", Icon: "clapperboard", Category: core.CategoryMedia,
		Tagline:      "Edit clips, photos, text and effects on a multitrack timeline",
		Description:  "Arrange clips and photos on tracks, trim, frame and speed-ramp them, add effects, masks, cut-outs, titles and music, and export a video.",
		Status:       core.StatusReady,
		Accepts:      core.Accepts{Extensions: slices.Concat(media.VideoExtensions(), media.ImageExtensions(), media.AudioExtensions())},
		Requires:     []string{"ffmpeg", "ffprobe"},
		OutputSubdir: "Edits", Order: 13, MaxConcurrent: 2,
		Parts: []string{"bg-remover", "upscaler", "audio-cleanup", "stems"},
	}
}

// Project flags (core.ProjectInfo.Flags).
const (
	FlagMusic     = "music"      // the project has a song (a music bed in the Video Editor)
	FlagMusicEdit = "music-edit" // the song is analysed: an Edit Studio project
)

// projectFlags reports FlagMusic / FlagMusicEdit for a stored document.
func projectFlags(data string) []string {
	var p struct {
		Song        *struct{} `json:"song"`
		AnalysisKey string    `json:"analysisKey"`
	}
	if json.Unmarshal([]byte(data), &p) != nil {
		return nil
	}
	var out []string
	if p.Song != nil {
		out = append(out, FlagMusic)
	}
	if p.Song != nil && p.AnalysisKey != "" {
		out = append(out, FlagMusicEdit)
	}
	return out
}

// Validate implements core.Module.
func (v *VideoModule) Validate(inputs []string, options json.RawMessage) error {
	return v.m.Validate(inputs, options)
}

// IsInteractive implements core.InteractiveJobs (clip prepare, as Edit Studio).
func (v *VideoModule) IsInteractive(o json.RawMessage) bool { return v.m.IsInteractive(o) }

// Run implements core.Module.
func (v *VideoModule) Run(ctx context.Context, job *core.JobContext) error { return v.m.Run(ctx, job) }
