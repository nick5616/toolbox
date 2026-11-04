package editstudio

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/viz"
	"toolbox/modules/videoeditor"
)

// Service is Edit Studio's typed Wails service (SPEC.md §11.3).
type Service struct {
	jobs *core.Jobs
	m    *Module
}

// NewService builds the service.
func NewService(jobs *core.Jobs, m *Module) *Service { return &Service{jobs: jobs, m: m} }

// LaneDefaults are the marker lane defaults of a new project (SPEC.md §5.2).
func LaneDefaults() map[string]LaneSettings {
	d := func(visible bool, min float64) LaneSettings {
		return LaneSettings{Visible: visible, MinStrength: min, Every: 1}
	}
	return map[string]LaneSettings{
		"beat": d(true, 0), "downbeat": d(true, 0),
		"kick": d(true, 0.25), "snare": d(true, 0.25), "hats": d(false, 0.25),
		"bass": d(false, 0.3), "vocals": d(false, 0.3), "other": d(false, 0.3),
		"section": d(true, 0), "drop": d(true, 0), "lift": d(true, 0), "break": d(false, 0),
		"stop": d(true, 0.5), "phrase": d(false, 0), "word": d(false, 0), "custom": d(true, 0),
		"accent": d(true, 0.3),
	}
}

// NewProject is the document Create stores (SPEC.md §6.2).
func NewProject(aspect string, fps int, seed int64) EditProject {
	return EditProject{
		Version: 1, Aspect: aspect, FPS: fps,
		Markers: MarkerState{
			Lanes: LaneDefaults(), Hidden: []string{}, Moved: map[string]int64{},
			Labels: map[string]string{}, Custom: []CustomMarker{},
		},
		Sources:    []Source{},
		Tracks:     []Track{{ID: "t1", Kind: "video", Name: "Video 1", Clips: []Clip{}}},
		Background: "#000000", Seed: seed, ExportHeight: 1080,
	}
}

func randomSeed() int64 {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return int64(binary.LittleEndian.Uint32(b[:])&0x7ffffffe) + 1
}

// normalize fills nil slices and maps so the frontend always gets arrays.
func normalize(doc EditProject) EditProject {
	doc.Version = 1
	if doc.Sources == nil {
		doc.Sources = []Source{}
	}
	if doc.Tracks == nil {
		doc.Tracks = []Track{}
	}
	for i := range doc.Tracks {
		if doc.Tracks[i].Clips == nil {
			doc.Tracks[i].Clips = []Clip{}
		}
	}
	mk := &doc.Markers
	if mk.Lanes == nil {
		mk.Lanes = LaneDefaults()
	}
	if mk.Hidden == nil {
		mk.Hidden = []string{}
	}
	if mk.Moved == nil {
		mk.Moved = map[string]int64{}
	}
	if mk.Labels == nil {
		mk.Labels = map[string]string{}
	}
	if mk.Custom == nil {
		mk.Custom = []CustomMarker{}
	}
	return doc
}

// List returns the edits, most recently updated first.
func (s *Service) List() ([]core.ProjectInfo, error) { return s.m.docs.List(context.Background()) }

// Get returns an edit.
func (s *Service) Get(id string) (EditProject, error) {
	doc, err := s.m.Get(context.Background(), id)
	if err != nil {
		return EditProject{}, err
	}
	return normalize(doc), nil
}

// Create makes an empty edit.
func (s *Service) Create(name, aspect string, fps int) (core.ProjectInfo, error) {
	if !slices.Contains(aspects, aspect) {
		return core.ProjectInfo{}, vErr("aspect", "Pick 9:16, 4:5, 1:1 or 16:9")
	}
	if !slices.Contains(fpsValues, fps) {
		return core.ProjectInfo{}, vErr("fps", "Pick 30 or 60 fps")
	}
	return s.m.docs.Create(context.Background(), name, NewProject(aspect, fps, randomSeed()))
}

// Save validates and stores an edit, then removes mattes no clip uses.
func (s *Service) Save(id, name string, doc EditProject) (core.ProjectInfo, error) {
	doc = normalize(doc)
	if err := validateShape(doc); err != nil {
		return core.ProjectInfo{}, err
	}
	info, err := s.m.docs.Save(context.Background(), id, name, doc)
	if err != nil {
		return info, err
	}
	s.m.pruneMattes(id, doc)
	return info, nil
}

// Duplicate copies an edit (and its mattes and thumbnail).
func (s *Service) Duplicate(id string) (core.ProjectInfo, error) {
	return s.m.docs.Duplicate(context.Background(), id)
}

// Delete removes an edit and its folder.
func (s *Service) Delete(id string) error { return s.m.docs.Delete(context.Background(), id) }

// SaveThumb stores a JPEG data URL (≤ 512 KiB) as the edit's thumbnail.
func (s *Service) SaveThumb(id, jpegDataURL string) error {
	if _, err := s.m.docs.Load(context.Background(), id); err != nil {
		return err
	}
	const prefix = "data:image/jpeg;base64,"
	if !strings.HasPrefix(jpegDataURL, prefix) {
		return vErr("thumb", "The thumbnail must be a JPEG")
	}
	data, err := base64.StdEncoding.DecodeString(jpegDataURL[len(prefix):])
	if err != nil || len(data) == 0 {
		return vErr("thumb", "The thumbnail is damaged")
	}
	if len(data) > MaxThumbBytes {
		return vErr("thumb", "The thumbnail is too large")
	}
	dir := s.m.docs.Dir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the edit's folder").WithCause(err)
	}
	tmp := filepath.Join(dir, "thumb.tmp.jpg")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the thumbnail").WithCause(err)
	}
	if err := os.Rename(tmp, s.m.docs.ThumbPath(id)); err != nil {
		_ = os.Remove(tmp)
		return core.Errorf(core.CodeInternal, "Couldn't save the thumbnail").WithCause(err)
	}
	return nil
}

// Probe describes source files. A file that can't be read still gets a row.
func (s *Service) Probe(paths []string) ([]videoeditor.ClipInfo, error) {
	if len(paths) > MaxSources {
		return nil, vErr("paths", fmt.Sprintf("At most %d files at a time", MaxSources))
	}
	if len(paths) == 0 {
		return []videoeditor.ClipInfo{}, nil
	}
	if s.m.cfg.Resolve == nil {
		return nil, core.ErrDependencyMissing("ffprobe", "")
	}
	ffprobe, err := s.m.cfg.Resolve("ffprobe")
	if err != nil {
		return nil, err
	}
	return videoeditor.ProbeFiles(context.Background(), ffprobe, paths), nil
}

// Analysis returns a cached analysis by key.
func (s *Service) Analysis(key string) (viz.AnalysisRef, error) {
	if s.m.cfg.Analyzer != nil {
		if ref, ok := s.m.cfg.Analyzer.Lookup(key); ok {
			return ref, nil
		}
	}
	return viz.AnalysisRef{}, core.Errorf(core.CodeNotFound, "That analysis is no longer available").WithHint("Analyze the song again")
}

// AnalysisFor returns the newest cached analysis of path with stems, if any.
func (s *Service) AnalysisFor(path string) (viz.AnalysisRef, bool) {
	if s.m.cfg.Analyzer == nil {
		return viz.AnalysisRef{}, false
	}
	return s.m.cfg.Analyzer.AnalysisFor(path, true)
}

func (s *Service) submit(o Options) (core.Job, error) {
	raw, err := json.Marshal(o)
	if err != nil {
		return core.Job{}, fmt.Errorf("marshal edit studio options: %w", err)
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

// Analyze submits the song analysis of an edit.
func (s *Service) Analyze(projectID string, req AnalyzeRequest) (core.Job, error) {
	return s.submit(Options{Action: ActionAnalyze, ProjectID: projectID, Analyze: &req})
}

// Sources reports what exists for source files (no work).
func (s *Service) Sources(paths []string, fps int) ([]SourceState, error) {
	if len(paths) > MaxSources {
		return nil, vErr("paths", fmt.Sprintf("At most %d files at a time", MaxSources))
	}
	out, err := s.m.sourceStates(context.Background(), paths, fps)
	if err != nil {
		return nil, err
	}
	busy := s.preparing(fps)
	for i := range out {
		out[i].Preparing = busy[out[i].Path]
	}
	return out, nil
}

// preparing lists the paths of queued or running prepare jobs at fps.
func (s *Service) preparing(fps int) map[string]bool {
	busy := map[string]bool{}
	if s.jobs == nil {
		return busy
	}
	jobs, err := s.jobs.List(context.Background(), core.JobFilter{ModuleID: ModuleID, Statuses: []core.JobStatus{core.JobQueued, core.JobRunning}, Limit: 500})
	if err != nil {
		return busy
	}
	for _, j := range jobs {
		var o Options
		if json.Unmarshal([]byte(j.OptionsJSON), &o) != nil || o.Action != ActionPrepare || o.Prepare == nil || o.Prepare.FPS != fps {
			continue
		}
		for _, p := range o.Prepare.Paths {
			busy[p] = true
		}
	}
	return busy
}

// Prepare submits one prepare job for source paths.
func (s *Service) Prepare(projectID string, paths []string, fps int) (core.Job, error) {
	return s.submit(Options{Action: ActionPrepare, ProjectID: projectID, Prepare: &PrepareRequest{Paths: paths, FPS: fps}})
}

// Interpolate submits an interpolated slow-motion job.
func (s *Service) Interpolate(projectID string, req InterpRequest) (core.Job, error) {
	return s.submit(Options{Action: ActionInterp, ProjectID: projectID, Interp: &req})
}

// InterpFor returns the preview interp stream of a range if it was made.
func (s *Service) InterpFor(path string, fromMs, toMs int64, fps int) (*EditStream, error) {
	return s.m.InterpFor(path, fromMs, toMs, fps, TierPreview), nil
}

// Matte submits a clip's cut-out job.
func (s *Service) Matte(projectID string, req MatteRequest) (core.Job, error) {
	return s.submit(Options{Action: ActionMatte, ProjectID: projectID, Matte: &req})
}

// Mattes reports which of a project's mattes exist.
func (s *Service) Mattes(projectID string, ids []string) ([]MatteState, error) {
	if _, err := s.m.docs.Load(context.Background(), projectID); err != nil {
		return nil, err
	}
	return s.m.matteStates(projectID, ids)
}

// MatteModels reports which cut-out models are installed.
func (s *Service) MatteModels() MatteModels { return s.m.matteModels() }

// Render submits the export job.
func (s *Service) Render(projectID string) (core.Job, error) {
	return s.submit(Options{Action: ActionRender, ProjectID: projectID})
}

// ExportText submits a markers or SRT file job.
func (s *Service) ExportText(projectID string, req TextRequest) (core.Job, error) {
	return s.submit(Options{Action: ActionText, ProjectID: projectID, Text: &req})
}

// ListFolder lists the video and photo files directly inside dir (not
// recursive, dot files skipped), sorted by name, at most MaxSources (§14.6).
func (s *Service) ListFolder(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, core.Errorf(core.CodeNotFound, "Couldn't read that folder").WithCause(err)
	}
	exts := slices.Concat(media.VideoExtensions(), media.ImageExtensions())
	out := []string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") || !slices.Contains(exts, strings.ToLower(filepath.Ext(name))) {
			continue
		}
		out = append(out, filepath.Join(dir, name))
		if len(out) == MaxSources {
			break
		}
	}
	return out, nil
}

// Fonts lists the fonts offered for captions.
func (s *Service) Fonts() []string { return media.Fonts() }

// ResultShape exists so the binding generator emits Result.
func (s *Service) ResultShape() Result { return Result{} }

// StreamIndexShape exists so the binding generator emits StreamIndex.
func (s *Service) StreamIndexShape() StreamIndex { return StreamIndex{} }
