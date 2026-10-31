package pipelines

import (
	"crypto/rand"
	"fmt"
	"strings"

	"toolbox/core"
)

// Template IDs (SPEC.md §10).
const (
	TplSocialClip    = "social-clip"
	TplPodcast       = "podcast"
	TplSampling      = "sampling"
	TplKaraoke       = "karaoke"
	TplProductPhotos = "product-photos"
	TplPaperArchive  = "paper-archive"
	TplForeignVideo  = "foreign-video"
	TplReceipts      = "receipts"
	TplLecture       = "lecture"
	TplBeforeSharing = "before-sharing"
	TplMusicVideo    = "music-video"
)

// Templates returns the built-in templates in gallery order. Wave 0: IDs and
// names only; WP-BI1 fills in blurbs, packs and steps.
func Templates() []core.PipelineTemplate {
	mk := func(id, name, icon string) core.PipelineTemplate {
		return core.PipelineTemplate{ID: id, Icon: icon, Packs: []string{},
			Pipeline: core.Pipeline{Name: name, TemplateID: id, Steps: []core.PipelineStep{}}}
	}
	return []core.PipelineTemplate{
		mk(TplSocialClip, "Clip for social", "smartphone"),
		mk(TplPodcast, "Podcast", "mic"),
		mk(TplSampling, "Sampling", "audio-waveform"),
		mk(TplKaraoke, "Karaoke", "mic-vocal"),
		mk(TplProductPhotos, "Product photos", "shopping-bag"),
		mk(TplPaperArchive, "Paper to archive", "archive"),
		mk(TplForeignVideo, "Foreign-language video", "languages"),
		mk(TplReceipts, "Receipts", "receipt"),
		mk(TplLecture, "Lecture", "graduation-cap"),
		mk(TplBeforeSharing, "Before sharing", "shield"),
		mk(TplMusicVideo, "Music video", "clapperboard"),
	}
}

// NewStepID returns 8 random characters from [a-z0-9].
func NewStepID() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	var b [8]byte
	_, _ = rand.Read(b[:])
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b[:])
}

// FromTemplate copies a template with fresh step IDs (rewriting From
// references) and a name not used by existing.
func FromTemplate(id string, existing []core.PipelineEntry) (core.Pipeline, error) {
	for _, t := range Templates() {
		if t.ID != id {
			continue
		}
		p := t.Pipeline
		ids := map[string]string{}
		steps := make([]core.PipelineStep, len(p.Steps))
		for i, s := range p.Steps {
			ids[s.ID] = NewStepID()
			s.ID = ids[s.ID]
			if nid, ok := ids[s.From]; ok {
				s.From = nid
			}
			s.Filter.Roles = append([]string{}, s.Filter.Roles...)
			steps[i] = s
		}
		p.Steps = steps
		p.ID, p.CreatedAt, p.UpdatedAt = "", 0, 0
		p.Name = freeName(p.Name, existing)
		return p, nil
	}
	return core.Pipeline{}, core.Errorf(core.CodeNotFound, "Template %q not found", id)
}

func freeName(name string, existing []core.PipelineEntry) string {
	taken := map[string]bool{}
	for _, e := range existing {
		taken[strings.ToLower(e.Pipeline.Name)] = true
	}
	if !taken[strings.ToLower(name)] {
		return name
	}
	for n := 2; ; n++ {
		c := fmt.Sprintf("%s %d", name, n)
		if !taken[strings.ToLower(c)] {
			return c
		}
	}
}
