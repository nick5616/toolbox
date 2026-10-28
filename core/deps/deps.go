// Package deps detects external tools (yt-dlp, ffmpeg, …) and manages the
// app-installed yt-dlp and uv. See SPEC.md §6.3 and Phase 2 §3.3.
package deps

import (
	"context"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"toolbox/core"
)

// Dependency IDs.
const (
	YtDlp    = "yt-dlp"
	FFmpeg   = "ffmpeg"
	FFprobe  = "ffprobe"
	Deno     = "deno"
	Node     = "node"
	ExifTool = "exiftool"
	Upscayl  = "upscayl"
)

// UpdateModuleID is the hidden system module that installs/updates yt-dlp.
const UpdateModuleID = "system-ytdlp-update"

// Spec describes one external tool.
type Spec struct {
	ID, Name, Purpose string
	Binary            string   // base name without .exe
	VersionArgs       []string // e.g. ["--version"]
	VersionRegex      *regexp.Regexp
	Managed           bool              // app can install/update it
	ArchiveDir        string            // managed archive install folder under bin ("" = single binary)
	VersionFile       string            // relative to ArchiveDir: read the version from this file instead of running the binary
	PinnedVersion     string            // installed VERSION differing from this → outdated (pinned managed archives)
	InstallHint       map[string]string // GOOS → hint
}

// entry is one dependency: a binary (detect == nil) or a virtual one.
type entry struct {
	Spec
	detect func(ctx context.Context) core.DepStatus
}

// Service detects and resolves dependencies. Safe for concurrent use.
type Service struct {
	binDir  string
	specs   []Spec
	virtual []entry
	reg     *core.Registry
	em      core.Emitter

	// test seams
	goos       string
	lookPath   func(file string) (string, error)
	knownDirs  func() []string
	githubBase string // "" = api.github.com

	mu    sync.Mutex
	cache map[string]core.DepStatus // base statuses (no RequiredBy)
}

// New builds a service. binDir is the managed bin dir (<support>/bin).
func New(binDir string, specs []Spec, reg *core.Registry, em core.Emitter) *Service {
	if em == nil {
		em = core.NopEmitter{}
	}
	s := &Service{
		binDir: binDir, specs: specs, reg: reg, em: em,
		goos:     runtime.GOOS,
		cache:    map[string]core.DepStatus{},
		lookPath: lookPath,
	}
	s.knownDirs = func() []string { return defaultKnownDirs(s.goos) }
	return s
}

// BinDir is the managed bin dir.
func (s *Service) BinDir() string { return s.binDir }

// RegisterVirtual adds a dependency detected by a function instead of by
// running a binary (e.g. the audio engine). spec supplies ID, Name, Purpose,
// Managed and InstallHint; detect returns its status (Path is what Resolve
// returns when OK). It participates in List, Detect, Resolve and deps:changed.
func (s *Service) RegisterVirtual(spec Spec, detect func(ctx context.Context) core.DepStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, e := range s.virtual {
		if e.ID == spec.ID {
			s.virtual[i] = entry{Spec: spec, detect: detect}
			return
		}
	}
	s.virtual = append(s.virtual, entry{Spec: spec, detect: detect})
}

// entries lists binaries (catalog order) then virtual deps.
func (s *Service) entries() []entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]entry, 0, len(s.specs)+len(s.virtual))
	for _, sp := range s.specs {
		out = append(out, entry{Spec: sp})
	}
	return append(out, s.virtual...)
}

func (s *Service) entry(id string) (entry, bool) {
	for _, e := range s.entries() {
		if e.ID == id {
			return e, true
		}
	}
	return entry{}, false
}

func (s *Service) spec(id string) (Spec, bool) {
	e, ok := s.entry(id)
	return e.Spec, ok
}

// check detects one entry (no registry-derived fields).
func (s *Service) check(ctx context.Context, e entry) core.DepStatus {
	if e.detect == nil {
		return s.detectOne(ctx, e.Spec)
	}
	st := e.detect(ctx)
	base := s.missing(e.Spec)
	if st.ID == "" {
		st.ID = base.ID
	}
	if st.Name == "" {
		st.Name = base.Name
	}
	if st.Purpose == "" {
		st.Purpose = base.Purpose
	}
	if st.InstallHint == "" {
		st.InstallHint = base.InstallHint
	}
	st.Managed = e.Managed
	if st.Source == "" {
		st.Source = core.SourceNone
	}
	st.RequiredBy, st.RecommendedBy = []string{}, []string{}
	if st.CheckedAt == 0 {
		st.CheckedAt = time.Now().UnixMilli()
	}
	return st
}

// Resolve returns the absolute path of a dependency or an *AppError with
// CodeDependencyMissing (with the OS install hint). Uses cached detection and
// re-detects a missing dep once on demand. An outdated dependency does not
// resolve.
func (s *Service) Resolve(depID string) (string, error) {
	e, ok := s.entry(depID)
	if !ok {
		return "", core.Errorf(core.CodeNotFound, "Unknown dependency %q", depID)
	}
	s.mu.Lock()
	st, cached := s.cache[depID]
	s.mu.Unlock()
	if cached && st.State == core.DepOK {
		return st.Path, nil
	}
	st = s.check(context.Background(), e)
	s.mu.Lock()
	s.cache[depID] = st
	s.mu.Unlock()
	s.emit()
	if st.State == core.DepOK {
		return st.Path, nil
	}
	if st.State == core.DepOutdated {
		return "", (&core.AppError{
			Code:    core.CodeDependencyMissing,
			Message: "The " + strings.ToLower(e.Name) + " needs an update",
		}).WithHint(s.hint(e.Spec))
	}
	return "", core.ErrDependencyMissing(depID, s.hint(e.Spec))
}

// List returns the cached statuses in catalog order (virtual deps last).
func (s *Service) List() []core.DepStatus {
	entries := s.entries()
	s.mu.Lock()
	base := make([]core.DepStatus, 0, len(entries))
	for _, e := range entries {
		st, ok := s.cache[e.ID]
		if !ok {
			st = s.missing(e.Spec)
		}
		base = append(base, st)
	}
	s.mu.Unlock()
	for i := range base {
		s.decorate(&base[i])
	}
	return base
}

// decorate fills the registry-derived fields.
func (s *Service) decorate(st *core.DepStatus) {
	st.RequiredBy = []string{}
	st.RecommendedBy = []string{}
	if s.reg != nil {
		for _, id := range s.reg.RequiringDep(st.ID) {
			if id != UpdateModuleID && id != UVUpdateModuleID {
				st.RequiredBy = append(st.RequiredBy, id)
			}
		}
		st.RecommendedBy = append(st.RecommendedBy, s.reg.RecommendingDep(st.ID)...)
	}
	st.Required = len(st.RequiredBy) > 0
}

func (s *Service) emit() {
	s.em.Emit(core.EventDepsChanged, core.DepsChanged{Deps: s.List()})
}

// Detect re-checks every dependency in parallel (5 s timeout each for
// binaries) and emits deps:changed.
func (s *Service) Detect(ctx context.Context) []core.DepStatus {
	entries := s.entries()
	res := make([]core.DepStatus, len(entries))
	var wg sync.WaitGroup
	for i, e := range entries {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res[i] = s.check(ctx, e)
		}()
	}
	wg.Wait()
	s.mu.Lock()
	for i, e := range entries {
		s.cache[e.ID] = res[i]
	}
	s.mu.Unlock()
	out := s.List()
	s.em.Emit(core.EventDepsChanged, core.DepsChanged{Deps: out})
	return out
}
