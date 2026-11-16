package videoeditor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"toolbox/core"
)

// Service is the Video Editor's typed Wails service (SPEC.md §B6.4).
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// List returns the video projects, most recently updated first.
func (s *Service) List() ([]core.ProjectInfo, error) { return s.m.docs.List(context.Background()) }

// Get returns a video project.
func (s *Service) Get(id string) (VideoProject, error) { return s.m.Get(context.Background(), id) }

// Create makes an empty project at aspect.
func (s *Service) Create(name, aspect string) (core.ProjectInfo, error) {
	if !slices.Contains(aspects, aspect) {
		return core.ProjectInfo{}, vErr("aspect", "Pick 9:16, 4:5, 1:1 or 16:9")
	}
	doc := VideoProject{Version: 1, Aspect: aspect, Clips: []Clip{}, Titles: []Title{}}
	return s.m.docs.Create(context.Background(), name, doc)
}

// Save validates and stores a project. Files don't have to exist: a project
// with a missing clip still opens and saves.
func (s *Service) Save(id, name string, doc VideoProject) (core.ProjectInfo, error) {
	doc.Version = 1
	if doc.Clips == nil {
		doc.Clips = []Clip{}
	}
	if doc.Titles == nil {
		doc.Titles = []Title{}
	}
	if err := validateShape(doc); err != nil {
		return core.ProjectInfo{}, err
	}
	return s.m.docs.Save(context.Background(), id, name, doc)
}

// Duplicate copies a project.
func (s *Service) Duplicate(id string) (core.ProjectInfo, error) {
	return s.m.docs.Duplicate(context.Background(), id)
}

// Delete removes a project and its preview.
func (s *Service) Delete(id string) error { return s.m.docs.Delete(context.Background(), id) }

// Probe describes source files for the timeline. A file that can't be read
// still gets a row, with Error set.
func (s *Service) Probe(paths []string) ([]ClipInfo, error) {
	if len(paths) > MaxClips {
		return nil, vErr("paths", fmt.Sprintf("At most %d files at a time", MaxClips))
	}
	out := make([]ClipInfo, 0, len(paths))
	if len(paths) == 0 {
		return out, nil
	}
	if s.m.cfg.Resolve == nil {
		return nil, core.ErrDependencyMissing("ffprobe", "")
	}
	ffprobe, err := s.m.cfg.Resolve("ffprobe")
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	for _, p := range paths {
		out = append(out, probeFile(ctx, ffprobe, p))
	}
	return out, nil
}

func (s *Service) submit(o Options) (core.Job, error) {
	raw, err := json.Marshal(o)
	if err != nil {
		return core.Job{}, fmt.Errorf("marshal video editor options: %w", err)
	}
	jobs, err := s.jobs.Submit(context.Background(), ModuleID, nil, string(raw))
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "The job wasn't queued")
	}
	return jobs[0], nil
}

// Plan submits a Quick vlog job; its result is {projectId}.
func (s *Service) Plan(req PlanRequest) (core.Job, error) {
	return s.submit(Options{Action: ActionPlan, Plan: &req})
}

// Render submits the project's export job.
func (s *Service) Render(id string) (core.Job, error) {
	return s.submit(Options{Action: ActionRender, ProjectID: id})
}

// Preview submits a 540p preview job.
func (s *Service) Preview(id string) (core.Job, error) {
	return s.submit(Options{Action: ActionPreview, ProjectID: id})
}

// PreviewPath is the project's latest preview file ("" if none).
func (s *Service) PreviewPath(id string) string {
	p := filepath.Join(s.m.docs.Dir(id), "preview.mp4")
	if fi, err := os.Stat(p); err != nil || !fi.Mode().IsRegular() {
		return ""
	}
	return p
}

// FreshPreviewPath is the project's preview file when it was made after the
// project was last saved ("" if there is none or it is out of date). Post
// Builder plays it for a video slide.
func (s *Service) FreshPreviewPath(id string) string {
	p := s.PreviewPath(id)
	if p == "" {
		return ""
	}
	stored, err := s.m.docs.Load(context.Background(), id)
	if err != nil {
		return ""
	}
	fi, err := os.Stat(p)
	if err != nil || fi.ModTime().UnixMilli() < stored.UpdatedAt {
		return ""
	}
	return p
}

// PlanShape and ResultShape only put types into the bindings.
func (s *Service) PlanShape() PlanResult { return PlanResult{} }
