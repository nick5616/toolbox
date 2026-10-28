package packs

import (
	"context"
	"runtime"

	"toolbox/core"
	"toolbox/core/deps"
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
}

// New returns a pack service.
func New(cfg Config) *Service {
	if cfg.GOOS == "" {
		cfg.GOOS, cfg.GOARCH = runtime.GOOS, runtime.GOARCH
	}
	if cfg.Emitter == nil {
		cfg.Emitter = core.NopEmitter{}
	}
	return &Service{cfg: cfg}
}

var errNotBuilt = core.Errorf(core.CodeInternal, "Tool packs aren't available yet")

// List returns every pack with its components and state.
func (s *Service) List() []core.PackStatus { return []core.PackStatus{} }

// Disk returns free and total space for the volume holding path ("" = the
// tools folder), walking up to the nearest existing parent.
func (s *Service) Disk(path string) (core.DiskInfo, error) { return core.DiskInfo{}, errNotBuilt }

// ToolsDir describes the current tools folder.
func (s *Service) ToolsDir() core.ToolsDirInfo {
	p := s.cfg.Paths
	return core.ToolsDirInfo{Path: p.ToolsDir, IsDefault: p.ToolsDir == p.SupportDir, FromEnv: p.ToolsDirFromEnv, Available: p.ToolsAvailable()}
}

// ResolveToolsDir applies the folder-picking rules of SPEC.md §7.3 to a
// folder the user picked and returns the tools folder to use.
func (s *Service) ResolveToolsDir(picked string) (string, error) { return "", errNotBuilt }

// Install queues one job per pack (catalog order). A toolsDir different from
// the current one, with nothing managed installed yet, writes the pointer and
// the pending file instead and returns Restart (SPEC.md §7.3).
func (s *Service) Install(ids []string, toolsDir string) (core.PackInstallResult, error) {
	return core.PackInstallResult{Jobs: []core.Job{}}, errNotBuilt
}

// InstallFor queues an install of only the components moduleID needs.
func (s *Service) InstallFor(moduleID string) (core.Job, error) { return core.Job{}, errNotBuilt }

// RemovePreview says what Remove(id) would free and keep.
func (s *Service) RemovePreview(id string) core.PackRemovePreview {
	return core.PackRemovePreview{Kept: []core.PackKept{}}
}

// Remove deletes the pack's components that no other installed pack uses.
// System copies are never touched.
func (s *Service) Remove(id string) error { return errNotBuilt }

// MoveToolsDir queues a move of the tools folder (SPEC.md §7.3).
func (s *Service) MoveToolsDir(path string) (core.Job, error) { return core.Job{}, errNotBuilt }

// FinishSetup marks the first-run setup as done.
func (s *Service) FinishSetup() error {
	_, err := s.cfg.Settings.Update(context.Background(), core.SettingsPatch{Setup: &core.SetupSettings{Done: true}})
	return err
}

// StartupTasks runs at app start before services are used: tools-move
// cleanup and reading setup-pending.json. It returns the packs to install
// (nil when none are pending).
func (s *Service) StartupTasks() []string { return nil }

// Register adds the hidden install and move modules.
func Register(reg *core.Registry, s *Service) error { return nil }
