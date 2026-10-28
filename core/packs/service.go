package packs

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/disk"
)

// Hidden module IDs.
const (
	InstallModuleID = "system-pack-install"
	MoveModuleID    = "system-tools-move"
)

// InstallOptions are the options of a system-pack-install job.
type InstallOptions struct {
	Pack string   `json:"pack"`
	Only []string `json:"only"` // component IDs (InstallFor); empty = the whole pack
}

// MoveOptions are the options of a system-tools-move job.
type MoveOptions struct {
	Path string `json:"path"` // the new tools folder
}

// Config wires the service.
type Config struct {
	Paths    core.Paths
	Reg      *core.Registry
	Deps     *deps.Service
	Jobs     *core.Jobs
	Settings *core.SettingsService
	Emitter  core.Emitter
	// StopEngines stops the AI engine and the chat server before a move.
	StopEngines func()
	// GOOS/GOARCH select catalog sizes (default: runtime values).
	GOOS, GOARCH string
}

// Service reports pack status and installs, removes and moves tool packs
// (SPEC.md §7.9). The bound wrapper is api.PacksService.
type Service struct {
	cfg Config
	key string // PlatformKey of cfg.GOOS/GOARCH

	mu          sync.Mutex
	timer       *time.Timer
	notifyDelay time.Duration // coalesces packs:changed bursts
	injected    map[string]bool
}

// New returns a pack service.
func New(cfg Config) *Service {
	if cfg.GOOS == "" {
		cfg.GOOS, cfg.GOARCH = runtime.GOOS, runtime.GOARCH
	}
	if cfg.Emitter == nil {
		cfg.Emitter = core.NopEmitter{}
	}
	return &Service{
		cfg: cfg, key: PlatformKey(cfg.GOOS, cfg.GOARCH),
		notifyDelay: 80 * time.Millisecond, injected: map[string]bool{},
	}
}

// Disk returns free and total space for the volume holding path ("" = the
// tools folder), walking up to the nearest existing parent.
func (s *Service) Disk(path string) (core.DiskInfo, error) {
	if path == "" {
		path = s.cfg.Paths.ToolsDir
	}
	free, total, err := disk.Free(path)
	if err != nil {
		return core.DiskInfo{}, core.Errorf(core.CodeNotFound, "Couldn't read that drive's free space").WithCause(err)
	}
	return core.DiskInfo{Path: path, Free: clampInt64(free), Total: clampInt64(total)}, nil
}

func clampInt64(v uint64) int64 {
	if v > 1<<62 {
		return 1 << 62
	}
	return int64(v)
}

// ToolsDir describes the current tools folder.
func (s *Service) ToolsDir() core.ToolsDirInfo {
	p := s.cfg.Paths
	return core.ToolsDirInfo{Path: p.ToolsDir, IsDefault: p.ToolsDir == p.SupportDir, FromEnv: p.ToolsDirFromEnv, Available: p.ToolsAvailable()}
}

// FinishSetup marks the first-run setup as done.
func (s *Service) FinishSetup() error {
	_, err := s.cfg.Settings.Update(context.Background(), core.SettingsPatch{Setup: &core.SetupSettings{Done: true}})
	return err
}

// Register adds the hidden install and move modules.
func Register(reg *core.Registry, s *Service) error {
	if err := reg.Register(&installModule{s: s}); err != nil {
		return err
	}
	return reg.Register(&moveModule{s: s})
}

// Install queues one job per pack (catalog order). A toolsDir different from
// the current one, with nothing managed installed yet, writes the pointer and
// the pending file instead and returns Restart (SPEC.md §7.3).
func (s *Service) Install(ids []string, toolsDir string) (core.PackInstallResult, error) {
	empty := core.PackInstallResult{Jobs: []core.Job{}}
	ordered, err := s.orderPacks(ids)
	if err != nil {
		return empty, err
	}
	if len(ordered) == 0 {
		return empty, core.ValidationError("Choose at least one pack", nil)
	}
	for _, id := range ordered {
		if reason := s.unsupportedReason(id); reason != "" {
			p, _ := packByID(id)
			return empty, core.ValidationError(p.Name+" isn't available on this computer", nil).WithHint(reason)
		}
	}
	if toolsDir != "" && !samePath(toolsDir, s.cfg.Paths.ToolsDir) {
		return s.installElsewhere(ordered, toolsDir)
	}
	if s.cfg.Jobs == nil {
		return empty, core.Errorf(core.CodeInternal, "Tool packs aren't available")
	}
	jobs := make([]core.Job, 0, len(ordered))
	for _, id := range ordered {
		opts, _ := json.Marshal(InstallOptions{Pack: id})
		js, err := s.cfg.Jobs.Submit(context.Background(), InstallModuleID, nil, string(opts))
		if err != nil {
			return core.PackInstallResult{Jobs: jobs}, err
		}
		jobs = append(jobs, js...)
	}
	s.notify()
	return core.PackInstallResult{Jobs: jobs}, nil
}

// installElsewhere records a new tools folder and the packs to install after
// the app restarts.
func (s *Service) installElsewhere(ordered []string, toolsDir string) (core.PackInstallResult, error) {
	empty := core.PackInstallResult{Jobs: []core.Job{}}
	p := s.cfg.Paths
	if p.ToolsDirFromEnv {
		return empty, core.ValidationError("The tools folder is set by TOOLBOX_TOOLS_DIR", nil)
	}
	if s.hasManaged() {
		return empty, core.ValidationError("Tools are already installed", nil).
			WithHint("Use Move… in Settings → Tool packs to change the folder")
	}
	abs, err := filepath.Abs(toolsDir)
	if err != nil {
		return empty, core.ValidationError("That isn't a usable folder", map[string]string{"path": toolsDir})
	}
	if err := s.checkToolsTarget(abs); err != nil {
		return empty, err
	}
	if !samePath(abs, p.SupportDir) {
		if err := writeMarker(abs); err != nil {
			return empty, core.Errorf(core.CodeInternal, "Couldn't use that folder").WithCause(err)
		}
	}
	if err := writePending(p.SupportDir, ordered); err != nil {
		return empty, err
	}
	if err := core.WriteToolsPointer(p.SupportDir, abs); err != nil {
		return empty, core.Errorf(core.CodeInternal, "Couldn't save the new folder").WithCause(err)
	}
	return core.PackInstallResult{Jobs: []core.Job{}, Restart: true}, nil
}

// InstallFor queues an install of only the components moduleID needs.
func (s *Service) InstallFor(moduleID string) (core.Job, error) {
	if s.cfg.Jobs == nil {
		return core.Job{}, core.Errorf(core.CodeInternal, "Tool packs aren't available")
	}
	pack, unlock, ok := unlockFor(moduleID)
	if !ok {
		return core.Job{}, core.Errorf(core.CodeNotFound, "No tool pack provides this tool")
	}
	if reason := s.unsupportedReason(pack.ID); reason != "" {
		return core.Job{}, core.ValidationError(pack.Name+" isn't available on this computer", nil).WithHint(reason)
	}
	missing := s.missingAmong(unlock.Needs)
	if len(missing) == 0 {
		return core.Job{}, core.ValidationError("Everything this tool needs is already installed", nil)
	}
	opts, _ := json.Marshal(InstallOptions{Pack: pack.ID, Only: missing})
	js, err := s.cfg.Jobs.Submit(context.Background(), InstallModuleID, nil, string(opts))
	if err != nil {
		return core.Job{}, err
	}
	s.notify()
	return js[0], nil
}

// MoveToolsDir queues a move of the tools folder (SPEC.md §7.3).
func (s *Service) MoveToolsDir(path string) (core.Job, error) {
	if s.cfg.Jobs == nil {
		return core.Job{}, core.Errorf(core.CodeInternal, "Tool packs aren't available")
	}
	target, err := s.checkMove(path)
	if err != nil {
		return core.Job{}, err
	}
	if s.otherJobsRunning("") {
		return core.Job{}, core.Errorf(core.CodeConflict, "Wait for running jobs to finish")
	}
	opts, _ := json.Marshal(MoveOptions{Path: target})
	js, err := s.cfg.Jobs.Submit(context.Background(), MoveModuleID, nil, string(opts))
	if err != nil {
		return core.Job{}, err
	}
	return js[0], nil
}

// otherJobsRunning reports whether any job other than self is queued or running.
func (s *Service) otherJobsRunning(self string) bool {
	if s.cfg.Jobs == nil {
		return false
	}
	js, err := s.cfg.Jobs.List(context.Background(), core.JobFilter{
		Statuses: []core.JobStatus{core.JobQueued, core.JobRunning}, Limit: 500,
	})
	if err != nil {
		return false
	}
	for _, j := range js {
		if j.ID != self {
			return true
		}
	}
	return false
}

func writePending(supportDir string, ids []string) error {
	b, _ := json.Marshal(pendingFile{Packs: ids})
	path := filepath.Join(supportDir, core.SetupPendingFile)
	if err := writeFileAtomic(path, b); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the pending install").WithCause(err)
	}
	return nil
}

// orderPacks validates ids and returns them deduplicated in catalog order.
func (s *Service) orderPacks(ids []string) ([]string, error) {
	want := map[string]bool{}
	for _, id := range ids {
		if _, ok := packByID(id); !ok {
			return nil, core.Errorf(core.CodeNotFound, "Unknown tool pack %q", id)
		}
		want[id] = true
	}
	var out []string
	for _, p := range Catalog() {
		if want[p.ID] {
			out = append(out, p.ID)
		}
	}
	return out, nil
}

// emitChanged sends the full list now.
func (s *Service) emitChanged() {
	s.cfg.Emitter.Emit(core.EventPacksChanged, core.PacksChanged{Packs: s.List()})
}

// notify schedules a packs:changed event; bursts coalesce into one.
func (s *Service) notify() {
	if s.notifyDelay <= 0 {
		s.emitChanged()
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(s.notifyDelay, func() {
		s.mu.Lock()
		s.timer = nil
		s.mu.Unlock()
		s.emitChanged()
	})
}

// Refresh emits packs:changed now.
func (s *Service) Refresh() { s.emitChanged() }

// OnEvent is fed the app's events (deps:changed, jobs:changed) by the bound
// layer, which subscribes to them; it re-emits packs:changed when pack state
// may have changed. Events carrying other jobs are ignored.
func (s *Service) OnEvent(name string, data any) {
	switch name {
	case core.EventDepsChanged:
		s.notify()
	case core.EventJobsChanged:
		if j, ok := data.(core.Job); ok && (j.ModuleID == InstallModuleID || j.ModuleID == MoveModuleID) {
			s.notify()
		}
	}
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1_000_000_000:
		return fmt.Sprintf("%.1f GB", float64(n)/1e9)
	case n >= 1_000_000:
		return fmt.Sprintf("%d MB", n/1_000_000)
	}
	return fmt.Sprintf("%d KB", n/1000)
}
