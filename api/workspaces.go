package api

import (
	"toolbox/core"
	"toolbox/core/workspace"
)

// WorkspacesService lists, creates and switches workspaces (Phase 21 SPEC
// §A6). FROZEN signatures after Wave 0; W1 implements the bodies.
type WorkspacesService struct {
	// Boot is the workspace this process opened.
	Boot workspace.Boot
	// Relaunch restarts Toolbox with extra arguments (desktop.Relaunch).
	Relaunch func(args []string) error
	// Jobs submits restore/tidy jobs (module "workspace").
	Jobs *core.Jobs
}

func notYet() error { return core.Errorf(core.CodeInternal, "Workspaces aren't ready yet") }

// Current returns the open workspace.
func (s *WorkspacesService) Current() workspace.Info { return s.Boot.Info }

// List returns every known workspace (Personal first).
func (s *WorkspacesService) List() ([]workspace.Info, error) {
	return []workspace.Info{s.Boot.Info}, nil
}

// Create makes a workspace folder (and workspace.json) and adds it to the
// list. It does not switch.
func (s *WorkspacesService) Create(req workspace.CreateRequest) (workspace.Info, error) {
	return workspace.Info{}, notYet()
}

// AddExisting adds a folder that already holds .toolbox/workspace.json.
func (s *WorkspacesService) AddExisting(root string) (workspace.Info, error) {
	return workspace.Info{}, notYet()
}

// Rename renames a workspace (not Personal).
func (s *WorkspacesService) Rename(id, name string) error { return notYet() }

// Remove takes a workspace off the list. It never deletes files.
func (s *WorkspacesService) Remove(id string) error { return notYet() }

// Switch quits and reopens Toolbox in the workspace.
func (s *WorkspacesService) Switch(id string) error { return notYet() }

// SetPresent turns "Hide personal details" on or off for the open workspace.
func (s *WorkspacesService) SetPresent(on bool) error { return notYet() }

// Restore re-copies missing or changed baseline files (a job).
func (s *WorkspacesService) Restore() (core.Job, error) { return core.Job{}, notYet() }

// TidyPreview lists what Tidy would move to the trash.
func (s *WorkspacesService) TidyPreview() (workspace.TidyPlan, error) {
	return workspace.TidyPlan{Sample: []string{}}, notYet()
}

// Tidy moves non-baseline, non-kept library files to the trash (a job).
func (s *WorkspacesService) Tidy() (core.Job, error) { return core.Job{}, notYet() }

// Presenter is what the frontend's displayPath needs (SPEC §A5).
func (s *WorkspacesService) Presenter() workspace.Presenter { return workspace.Presenter{} }
