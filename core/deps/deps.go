// Package deps detects external tools (yt-dlp, ffmpeg, …) and manages the
// app-installed yt-dlp. See SPEC.md §6.3.
package deps

import (
	"context"
	"regexp"
	"runtime"
	"sync"

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
	InstallHint       map[string]string // GOOS → hint
}

// Service detects and resolves dependencies. Safe for concurrent use.
type Service struct {
	binDir string
	specs  []Spec
	reg    *core.Registry
	em     core.Emitter

	// test seams
	goos      string
	lookPath  func(file string) (string, error)
	knownDirs func() []string

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

func (s *Service) spec(id string) (Spec, bool) {
	for _, sp := range s.specs {
		if sp.ID == id {
			return sp, true
		}
	}
	return Spec{}, false
}

// Resolve returns the absolute path of a dependency or an *AppError with
// CodeDependencyMissing (with the OS install hint). Uses cached detection and
// re-detects a missing dep once on demand.
func (s *Service) Resolve(depID string) (string, error) {
	sp, ok := s.spec(depID)
	if !ok {
		return "", core.Errorf(core.CodeNotFound, "Unknown dependency %q", depID)
	}
	s.mu.Lock()
	st, cached := s.cache[depID]
	s.mu.Unlock()
	if cached && st.State == core.DepOK {
		return st.Path, nil
	}
	st = s.detectOne(context.Background(), sp)
	s.mu.Lock()
	s.cache[depID] = st
	s.mu.Unlock()
	s.emit()
	if st.State == core.DepOK {
		return st.Path, nil
	}
	return "", core.ErrDependencyMissing(depID, s.hint(sp))
}

// List returns the cached statuses in catalog order.
func (s *Service) List() []core.DepStatus {
	s.mu.Lock()
	base := make([]core.DepStatus, 0, len(s.specs))
	for _, sp := range s.specs {
		st, ok := s.cache[sp.ID]
		if !ok {
			st = s.missing(sp)
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
			if id != UpdateModuleID {
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

// Detect re-checks every dependency in parallel (5 s timeout each) and emits
// deps:changed.
func (s *Service) Detect(ctx context.Context) []core.DepStatus {
	res := make([]core.DepStatus, len(s.specs))
	var wg sync.WaitGroup
	for i, sp := range s.specs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res[i] = s.detectOne(ctx, sp)
		}()
	}
	wg.Wait()
	s.mu.Lock()
	for i, sp := range s.specs {
		s.cache[sp.ID] = res[i]
	}
	s.mu.Unlock()
	out := s.List()
	s.em.Emit(core.EventDepsChanged, core.DepsChanged{Deps: out})
	return out
}
