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
	"unicode"

	"toolbox/core"
	"toolbox/core/par"
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
	Llama    = "llama-runtime"
	// Phase 12 (Documents).
	Pandoc   = "pandoc"
	Typst    = "typst"
	Monolith = "monolith"
)

// Pinned managed versions (SPEC.md §0.4, §3.3, §7.6).
const (
	FFmpegVersion   = "9.0.2"
	DenoVersion     = "2.9.8"
	LlamaVersion    = "b11938"
	PandocVersion   = "3.13"
	TypstVersion    = "0.15.1"
	MonolithVersion = "2.12.0"
)

// Hidden installer module IDs (Phase 5).
const (
	FFmpegInstallModuleID   = "system-ffmpeg-install"
	DenoInstallModuleID     = "system-deno-install"
	LlamaInstallModuleID    = "system-llama-install"
	PandocInstallModuleID   = "system-pandoc-install"
	TypstInstallModuleID    = "system-typst-install"
	MonolithInstallModuleID = "system-monolith-install"
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
	MinVersion        string            // a system copy older than this does not count (managed copies are exempt)
	AllowSystem       bool              // pinned archive tools: a copy on PATH / in known dirs also counts (managed first)
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

	// Persisted detection results (cache.go), single-flight checks, change hooks.
	cachePath string
	keyed     map[string]cacheEntry // guarded by mu
	hooks     []func()              // guarded by mu
	fmu       sync.Mutex
	flights   map[string]*flight
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
		keyed:    map[string]cacheEntry{},
		flights:  map[string]*flight{},
		lookPath: lookPath,
	}
	s.knownDirs = func() []string { return defaultKnownDirs(s.goos) }
	return s
}

// BinDir is the managed bin dir.
func (s *Service) BinDir() string { return s.binDir }

// RegisterVirtual adds a dependency detected by a function instead of by
// running a binary (e.g. the AI engine). spec supplies ID, Name, Purpose,
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

// check detects one entry (no registry-derived fields), always re-running it.
func (s *Service) check(ctx context.Context, e entry) core.DepStatus {
	return s.checkMode(ctx, e, true)
}

// checkMode is check; without force a binary may reuse its persisted result
// when the file hasn't changed.
func (s *Service) checkMode(ctx context.Context, e entry, force bool) core.DepStatus {
	if e.detect == nil {
		return s.detectSpec(ctx, e.Spec, force)
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
	// Waits for a check of this dep already in flight (e.g. the start-up
	// detection) instead of starting a second one.
	st = s.checkShared(context.Background(), e, true)
	changed := s.setStatus(e.ID, st)
	s.emit()
	if changed {
		s.notify()
	}
	if st.State == core.DepOK {
		return st.Path, nil
	}
	if st.State == core.DepOutdated {
		return "", (&core.AppError{
			Code:    core.CodeDependencyMissing,
			Message: "The " + inSentence(e.Name) + " needs an update",
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

// Known returns the cached status of a dependency without running anything.
// The bool is false while the dependency hasn't been detected yet (unknown is
// not the same as missing).
func (s *Service) Known(id string) (core.DepStatus, bool) {
	s.mu.Lock()
	st, ok := s.cache[id]
	s.mu.Unlock()
	if ok {
		s.decorate(&st)
	}
	return st, ok
}

// OnChange registers fn to run (on the detecting goroutine, never holding a
// lock) whenever a detection changes a dependency's state, path or version.
func (s *Service) OnChange(fn func()) {
	s.mu.Lock()
	s.hooks = append(s.hooks, fn)
	s.mu.Unlock()
}

func (s *Service) notify() {
	s.mu.Lock()
	hooks := append([]func(){}, s.hooks...)
	s.mu.Unlock()
	for _, h := range hooks {
		h()
	}
}

// setStatus stores a status and reports whether it differs from the cached one.
func (s *Service) setStatus(id string, st core.DepStatus) bool {
	s.mu.Lock()
	old, had := s.cache[id]
	s.cache[id] = st
	s.mu.Unlock()
	return !had || !sameStatus(old, st)
}

func sameStatus(a, b core.DepStatus) bool {
	return a.State == b.State && a.Path == b.Path && a.Version == b.Version && a.Source == b.Source && a.Error == b.Error
}

// flight is one check of one dependency in progress.
type flight struct {
	done  chan struct{}
	force bool
	st    core.DepStatus
}

// checkShared runs checkMode single-flight per dependency: a caller arriving
// while a check of the same dep runs waits for it (a forced caller waits for a
// non-forced check, then runs its own).
func (s *Service) checkShared(ctx context.Context, e entry, force bool) core.DepStatus {
	for {
		s.fmu.Lock()
		f, busy := s.flights[e.ID]
		if !busy {
			f = &flight{done: make(chan struct{}), force: force}
			s.flights[e.ID] = f
			s.fmu.Unlock()
			f.st = s.checkMode(ctx, e, force)
			s.fmu.Lock()
			delete(s.flights, e.ID)
			s.fmu.Unlock()
			close(f.done)
			return f.st
		}
		s.fmu.Unlock()
		select {
		case <-f.done:
		case <-ctx.Done():
			if st, ok := s.Known(e.ID); ok {
				return st
			}
			return s.missing(e.Spec)
		}
		if f.force || !force {
			return f.st
		}
	}
}

// Detect re-checks every dependency in parallel (5 s timeout each for
// binaries), always re-running the version commands, and emits deps:changed.
// It is what Settings' "Recheck" calls.
func (s *Service) Detect(ctx context.Context) []core.DepStatus {
	return s.detectAll(ctx, true, 0)
}

// Refresh is the start-up detection: persisted results are reused for binaries
// whose path, size and modification time haven't changed, and at most two
// checks run at once so the window's own start isn't slowed.
func (s *Service) Refresh(ctx context.Context) []core.DepStatus {
	return s.detectAll(ctx, false, 2)
}

func (s *Service) detectAll(ctx context.Context, force bool, limit int) []core.DepStatus {
	entries := s.entries()
	res := make([]core.DepStatus, len(entries))
	if limit <= 0 {
		limit = len(entries)
	}
	_ = par.ForEach(ctx, len(entries), limit, func(ctx context.Context, i int) error {
		res[i] = s.checkShared(ctx, entries[i], force)
		return nil
	})
	changed := false
	for i, e := range entries {
		if res[i].ID == "" { // cancelled before it started: keep what we had
			continue
		}
		if s.setStatus(e.ID, res[i]) {
			changed = true
		}
	}
	s.saveCache()
	out := s.List()
	s.em.Emit(core.EventDepsChanged, core.DepsChanged{Deps: out})
	if changed {
		s.notify()
	}
	return out
}

// inSentence lower-cases a dependency name for use mid-sentence, keeping a
// leading acronym ("AI engine" stays, "Upscaler engine" → "upscaler engine").
func inSentence(name string) string {
	if len(name) >= 2 && unicode.IsUpper(rune(name[0])) && unicode.IsUpper(rune(name[1])) {
		return name
	}
	return strings.ToLower(name)
}
