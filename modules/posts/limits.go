package posts

import (
	"context"

	"toolbox/core/projectdocs"
)

// Limits are Instagram's limits as of 2026-11-01 (SPEC.md §B0.1). All checks
// read them from here.
type Limits struct {
	MaxSlides       int   `json:"maxSlides"` // carousel and story
	MaxClipMs       int64 `json:"maxClipMs"` // carousel/story video per slide
	MaxReelMs       int64 `json:"maxReelMs"` // reel
	MaxCaptionChars int   `json:"maxCaptionChars"`
	MaxHashtags     int   `json:"maxHashtags"`
	MaxMentions     int   `json:"maxMentions"`
	MinWidth        int   `json:"minWidth"`
	FrameWidth      int   `json:"frameWidth"`
	MaxAltTextChars int   `json:"maxAltTextChars"`
}

// DefaultLimits are the current limits.
func DefaultLimits() Limits {
	return Limits{
		MaxSlides: 20, MaxClipMs: 60_000, MaxReelMs: 180_000, MaxCaptionChars: 2200,
		MaxHashtags: 30, MaxMentions: 20, MinWidth: 1080, FrameWidth: 1080, MaxAltTextChars: 1000,
	}
}

// FrameSize is the output frame of an aspect at 1080 wide.
func FrameSize(aspect string) (w, h int) {
	switch aspect {
	case "1:1":
		return 1080, 1080
	case "3:4":
		return 1080, 1440
	case "1.91:1":
		return 1080, 566
	case "9:16":
		return 1080, 1920
	default: // "4:5"
		return 1080, 1350
	}
}

func projectdocsGet(m *Module, id string) (Post, error) {
	return projectdocs.Get[Post](context.Background(), m.docs, id)
}
