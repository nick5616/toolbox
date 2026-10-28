package api

import (
	"toolbox/core"
	"toolbox/core/packs"
)

// PacksService is the bound tool-packs API (SPEC.md §7.9). Folder picking and
// relaunching need Wails, so they live here; everything else is core/packs.
type PacksService struct {
	Packs *packs.Service
	// Relaunch restarts the app (desktop.Relaunch); set in main.go.
	RelaunchFn func() error
}

// List returns every pack with its components and state.
func (s *PacksService) List() []core.PackStatus { return s.Packs.List() }

// Disk returns free and total space for the volume holding path ("" = the
// tools folder).
func (s *PacksService) Disk(path string) (core.DiskInfo, error) { return s.Packs.Disk(path) }

// ToolsDir describes the current tools folder.
func (s *PacksService) ToolsDir() core.ToolsDirInfo { return s.Packs.ToolsDir() }

// PickToolsDir shows a native folder dialog and returns the tools folder to
// use for the picked folder ("" when cancelled).
func (s *PacksService) PickToolsDir() (string, error) {
	return "", core.Errorf(core.CodeInternal, "Tool packs aren't available yet")
}

// Install queues pack installs; see packs.Service.Install.
func (s *PacksService) Install(ids []string, toolsDir string) (core.PackInstallResult, error) {
	return s.Packs.Install(ids, toolsDir)
}

// InstallFor installs only what moduleID needs.
func (s *PacksService) InstallFor(moduleID string) (core.Job, error) {
	return s.Packs.InstallFor(moduleID)
}

// RemovePreview says what removing a pack frees and keeps.
func (s *PacksService) RemovePreview(id string) core.PackRemovePreview {
	return s.Packs.RemovePreview(id)
}

// Remove removes a pack's unshared components.
func (s *PacksService) Remove(id string) error { return s.Packs.Remove(id) }

// MoveToolsDir queues a move of the tools folder.
func (s *PacksService) MoveToolsDir(path string) (core.Job, error) { return s.Packs.MoveToolsDir(path) }

// Relaunch restarts the app (to use a new tools folder).
func (s *PacksService) Relaunch() error {
	if s.RelaunchFn == nil {
		return core.Errorf(core.CodeInternal, "Restart Toolbox to use the new folder")
	}
	return s.RelaunchFn()
}

// FinishSetup marks the first-run setup as done.
func (s *PacksService) FinishSetup() error { return s.Packs.FinishSetup() }
