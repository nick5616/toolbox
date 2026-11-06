package posts

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/media"
	"toolbox/core/projectdocs"
)

// Service is the Post Builder's typed Wails service (SPEC.md §B7.4).
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// List returns the posts, most recently updated first.
func (s *Service) List() ([]core.ProjectInfo, error) { return s.m.docs.List(context.Background()) }

// Get returns a post.
func (s *Service) Get(id string) (Post, error) {
	return projectdocsGet(s.m, id)
}

var carouselAspects = []string{"4:5", "1:1", "3:4", "1.91:1"}

// Create makes a post; paths become photo/clip slides by extension (other
// files are ignored). Reels and stories are always 9:16.
func (s *Service) Create(name, format, aspect string, paths []string) (core.ProjectInfo, error) {
	doc, err := s.m.newPost(context.Background(), format, aspect, paths)
	if err != nil {
		return core.ProjectInfo{}, err
	}
	return s.m.docs.Create(context.Background(), name, doc)
}

// newPost builds a post document from files; unusable files are ignored.
func (m *Module) newPost(ctx context.Context, format, aspect string, paths []string) (Post, error) {
	aspect, err := normalizeFormat(format, aspect)
	if err != nil {
		return Post{}, err
	}
	doc := Post{Version: 1, Format: format, Aspect: aspect, Slides: []Slide{}, Extra: []string{}, Hidden: []string{}}
	limit := maxClipMs(DefaultLimits(), format)
	infos, err := m.slideInfo(ctx, paths)
	if err != nil {
		return Post{}, err
	}
	for _, src := range infos {
		sl := Slide{ID: core.NewID(), Kind: src.Kind, Path: src.Path, Zoom: 1}
		switch src.Kind {
		case "photo":
		case "clip":
			sl.OutMs = min(src.DurationMs, limit)
		default:
			continue
		}
		doc.Slides = append(doc.Slides, sl)
	}
	return doc, nil
}

// normalizeFormat validates the format and aspect; reels and stories are 9:16.
func normalizeFormat(format, aspect string) (string, error) {
	switch format {
	case "carousel":
		if !slices.Contains(carouselAspects, aspect) {
			return "", core.ValidationError("Choose 4:5, 1:1, 3:4 or 1.91:1", map[string]string{"aspect": "invalid"})
		}
	case "reel", "story":
		aspect = "9:16"
	default:
		return "", core.ValidationError("Choose carousel, reel or story", map[string]string{"format": "invalid"})
	}
	return aspect, nil
}

// validateShape checks a post's structure (not Instagram's limits).
func validateShape(doc Post) error {
	fields := map[string]string{}
	fail := func(key, msg string) { fields[key] = msg }
	switch doc.Format {
	case "carousel":
		if !slices.Contains(carouselAspects, doc.Aspect) {
			fail("aspect", "A carousel is 4:5, 1:1, 3:4 or 1.91:1")
		}
	case "reel", "story":
		if doc.Aspect != "9:16" {
			fail("aspect", "Reels and stories are 9:16")
		}
	default:
		fail("format", "Choose carousel, reel or story")
	}
	ids := map[string]bool{}
	for i, sl := range doc.Slides {
		key := fmt.Sprintf("slides[%d]", i)
		switch sl.Kind {
		case "photo", "clip":
			if sl.Path == "" {
				fail(key, "Slide has no file")
			}
		case "composition", "video":
			if sl.ProjectID == "" {
				fail(key, "Slide has no project")
			}
		default:
			fail(key, "Unknown slide type")
		}
		if sl.ID == "" || ids[sl.ID] {
			fail(key, "Slide IDs must be unique")
		}
		ids[sl.ID] = true
		if sl.PanX < -1 || sl.PanX > 1 || sl.PanY < -1 || sl.PanY > 1 {
			fail(key, "Pan must be between -1 and 1")
		}
		if sl.Zoom < 1 || sl.Zoom > 4 {
			fail(key, "Zoom must be between 1 and 4")
		}
		if !slices.Contains([]int{0, 90, 180, 270}, sl.Rotation) {
			fail(key, "Rotation must be 0, 90, 180 or 270")
		}
		if sl.Kind == "clip" && (sl.InMs < 0 || sl.OutMs <= sl.InMs) {
			fail(key, "A clip's In must be before its Out")
		}
		if utf8.RuneCountInString(sl.AltText) > DefaultLimits().MaxAltTextChars {
			fail(key, "Alt text is too long")
		}
	}
	if doc.Folder != "" && !filepath.IsAbs(doc.Folder) {
		fail("folder", "The source folder must be an absolute path")
	}
	for _, list := range []struct {
		key  string
		vals []string
	}{{"extra", doc.Extra}, {"hidden", doc.Hidden}} {
		if len(list.vals) > maxPoolEntries {
			fail(list.key, fmt.Sprintf("At most %d entries", maxPoolEntries))
		}
		for _, p := range list.vals {
			if !filepath.IsAbs(p) {
				fail(list.key, "Source paths must be absolute")
				break
			}
		}
	}
	if len(fields) == 0 {
		return nil
	}
	keys := slices.Sorted(maps.Keys(fields))
	return core.ValidationError(fields[keys[0]], fields)
}

// Save validates the shape and stores a post (Check issues don't block saving).
func (s *Service) Save(id, name string, doc Post) (core.ProjectInfo, error) {
	if doc.Version == 0 {
		doc.Version = 1
	}
	if doc.Slides == nil {
		doc.Slides = []Slide{}
	}
	if doc.Extra == nil {
		doc.Extra = []string{}
	}
	if doc.Hidden == nil {
		doc.Hidden = []string{}
	}
	if err := validateShape(doc); err != nil {
		return core.ProjectInfo{}, err
	}
	return s.m.docs.Save(context.Background(), id, name, doc)
}

// Duplicate copies a post.
func (s *Service) Duplicate(id string) (core.ProjectInfo, error) {
	return s.m.docs.Duplicate(context.Background(), id)
}

// Delete removes a post (its exports stay in the Library).
func (s *Service) Delete(id string) error { return s.m.docs.Delete(context.Background(), id) }

// Check returns the post's issues (errors block Export).
func (s *Service) Check(doc Post) []Issue { return s.m.Check(context.Background(), doc) }

// Export submits the export job; it refuses while Check has errors.
func (s *Service) Export(id string) (core.Job, error) {
	ctx := context.Background()
	doc, err := projectdocs.Get[Post](ctx, s.m.docs, id)
	if err != nil {
		return core.Job{}, err
	}
	if bad, ok := firstError(s.m.Check(ctx, doc)); ok {
		return core.Job{}, core.ValidationError(bad.Message, nil)
	}
	raw, err := json.Marshal(Options{Action: ActionExport, ProjectID: id})
	if err != nil {
		return core.Job{}, fmt.Errorf("encode options: %w", err)
	}
	jobs, err := s.jobs.Submit(ctx, ModuleID, nil, string(raw))
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "The export didn't start")
	}
	return jobs[0], nil
}

// SlideInfo describes files before they become slides.
func (s *Service) SlideInfo(paths []string) ([]SlideSource, error) {
	return s.m.slideInfo(context.Background(), paths)
}

// slideInfo inspects each path (kind by extension, size, duration, GPS, HEIC).
func (m *Module) slideInfo(ctx context.Context, paths []string) ([]SlideSource, error) {
	out := make([]SlideSource, 0, len(paths))
	photoExt, videoExt := media.ImageExtensions(), media.VideoExtensions()
	for _, p := range paths {
		src := SlideSource{Path: p}
		ext := strings.ToLower(filepath.Ext(p))
		switch {
		case !fileExists(p):
			src.Error = "This file doesn't exist"
		case slices.Contains(photoExt, ext):
			src.Kind = "photo"
			src.HEIC = imaging.IsHEIC(p)
			if !src.HEIC {
				w, h, err := orientedSize(p)
				if err != nil {
					src.Kind, src.Error = "", "Couldn't read this photo"
					break
				}
				src.Width, src.Height = w, h
				src.HasGPS = hasGPS(p)
			}
		case slices.Contains(videoExt, ext):
			src.Kind = "clip"
			ffprobe, err := m.tool("ffprobe")
			if err != nil {
				src.Kind, src.Error = "", "FFmpeg isn't installed"
				break
			}
			info, err := media.Probe(ctx, ffprobe, p)
			if err != nil || info.Video == nil {
				src.Kind, src.Error = "", "Couldn't read this video"
				break
			}
			src.Width, src.Height, src.DurationMs = info.Video.Width, info.Video.Height, info.DurationMs
			src.HasGPS = info.Tags["location"] != ""
		default:
			src.Error = "Not a photo or video"
		}
		out = append(out, src)
	}
	return out, nil
}

// Limits returns the Instagram limits the checks use.
func (s *Service) Limits() Limits { return DefaultLimits() }

// ExportShape only puts the export result type into the bindings.
func (s *Service) ExportShape() ExportResult { return ExportResult{} }
