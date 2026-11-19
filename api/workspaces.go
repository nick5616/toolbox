package api

import (
	"context"
	"encoding/json"
	"sync"

	"toolbox/core"
	"toolbox/core/workspace"
	wsjobs "toolbox/modules/workspace"
)

// WorkspacesService lists, creates and switches workspaces (Phase 21 SPEC
// §A6). The method signatures are frozen; the exported fields wire it up.
type WorkspacesService struct {
	// Boot is the workspace this process opened.
	Boot workspace.Boot
	// Relaunch restarts Toolbox with extra arguments (desktop.RelaunchWith).
	Relaunch func(args []string) error
	// Jobs submits restore/tidy jobs (module "workspace").
	Jobs *core.Jobs
	// Em receives workspace:changed (nil = none).
	Em core.Emitter
	// PersonalLibrary reports Personal's library folder, which a workspace may
	// not overlap (nil = the default ~/Toolbox).
	PersonalLibrary func() string

	mu         sync.Mutex
	cur        *workspace.Info // the open workspace as it is now (Present changes)
	noticeSent bool
}

// Notice returns the start-up notice once ("Demo's folder isn't there", a
// corrupt workspace list); later calls return "".
func (s *WorkspacesService) Notice() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.noticeSent {
		return ""
	}
	s.noticeSent = true
	return s.Boot.Notice
}

func (s *WorkspacesService) store() workspace.Store { return workspace.Store{Dir: s.Boot.GlobalDir} }

func (s *WorkspacesService) current() workspace.Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil {
		in := s.Boot.Info
		s.cur = &in
	}
	return *s.cur
}

func (s *WorkspacesService) guard() workspace.Guard {
	lib := ""
	if s.PersonalLibrary != nil {
		lib = s.PersonalLibrary()
	}
	// Boot.Paths.SupportDir is the workspace's own; the guard wants the global one.
	return workspace.GuardFor(core.Paths{SupportDir: s.Boot.GlobalDir, ToolsDir: s.Boot.Paths.ToolsDir}, lib)
}

func (s *WorkspacesService) emit() {
	if s.Em != nil {
		s.Em.Emit(workspace.EventChanged, s.current())
	}
}

func unavailable() error {
	return core.ValidationError("Workspaces aren't available in a dev sandbox", nil).
		WithHint("Start Toolbox without TOOLBOX_SUPPORT_DIR or TOOLBOX_WORKSPACE to manage workspaces")
}

// Current returns the open workspace.
func (s *WorkspacesService) Current() workspace.Info { return s.current() }

// List returns every known workspace (Personal first).
func (s *WorkspacesService) List() ([]workspace.Info, error) {
	cur := s.current()
	if !s.store().Enabled() {
		return []workspace.Info{cur}, nil
	}
	list, _ := s.store().List(cur.ID)
	for i := range list {
		if list[i].ID == cur.ID {
			list[i] = cur
			list[i].Current = true
		}
	}
	return list, nil
}

// Create makes a workspace folder (and workspace.json) and adds it to the
// list. It does not switch.
func (s *WorkspacesService) Create(req workspace.CreateRequest) (workspace.Info, error) {
	if !s.store().Enabled() {
		return workspace.Info{}, unavailable()
	}
	return s.store().Create(req, s.guard())
}

// AddExisting adds a folder that already holds .toolbox/workspace.json.
func (s *WorkspacesService) AddExisting(root string) (workspace.Info, error) {
	if !s.store().Enabled() {
		return workspace.Info{}, unavailable()
	}
	return s.store().AddExisting(root, s.guard())
}

// Rename renames a workspace (not Personal).
func (s *WorkspacesService) Rename(id, name string) error {
	if !s.store().Enabled() {
		return unavailable()
	}
	if err := s.store().Rename(id, name); err != nil {
		return err
	}
	s.mu.Lock()
	if s.cur != nil && s.cur.ID == id {
		s.cur.Name = name
	} else if s.cur == nil && s.Boot.Info.ID == id {
		in := s.Boot.Info
		in.Name = name
		s.cur = &in
	}
	s.mu.Unlock()
	if s.current().ID == id {
		s.emit()
	}
	return nil
}

// Remove takes a workspace off the list. It never deletes files.
func (s *WorkspacesService) Remove(id string) error {
	if !s.store().Enabled() {
		return unavailable()
	}
	if id == s.current().ID && id != workspace.PersonalID {
		return core.ValidationError("This workspace is open", nil).WithHint("Switch to another workspace first")
	}
	return s.store().Remove(id)
}

// Switch quits and reopens Toolbox in the workspace.
func (s *WorkspacesService) Switch(id string) error {
	if s.Boot.Sandboxed {
		return core.ValidationError("Switching workspaces isn't available in a dev sandbox", nil).
			WithHint("Start Toolbox again with TOOLBOX_WORKSPACE set to the folder you want")
	}
	cur := s.current()
	if id == cur.ID {
		return nil
	}
	arg := workspace.PersonalID
	if id != workspace.PersonalID {
		in, ok := s.store().Find(id)
		if !ok {
			return core.Errorf(core.CodeNotFound, "That workspace isn't in the list")
		}
		if in.Missing {
			return core.Errorf(core.CodeNotFound, "%s's folder isn't there", in.Name).WithHint("Plug in the drive or restore the folder")
		}
		arg = in.Root
	}
	if s.Relaunch == nil {
		return core.Errorf(core.CodeInternal, "Restart Toolbox to switch workspace")
	}
	return s.Relaunch([]string{workspace.ArgWorkspace, arg})
}

// SetPresent turns "Hide personal details" on or off for the open workspace.
func (s *WorkspacesService) SetPresent(on bool) error {
	cur := s.current()
	if cur.Root == "" || cur.Kind == workspace.KindPersonal {
		return core.ValidationError("Personal can't hide its details", nil).
			WithHint("Create a Demo workspace to present with")
	}
	cur.Present = on
	if err := workspace.WriteInfo(cur); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the workspace").WithCause(err)
	}
	s.mu.Lock()
	s.cur = &cur
	s.mu.Unlock()
	s.emit()
	return nil
}

func (s *WorkspacesService) submit(action wsjobs.Action) (core.Job, error) {
	if s.Jobs == nil {
		return core.Job{}, core.Errorf(core.CodeInternal, "Jobs aren't ready yet")
	}
	opts, _ := json.Marshal(wsjobs.Options{Action: action})
	jobs, err := s.Jobs.Submit(context.Background(), wsjobs.ModuleID, []string{}, string(opts))
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "The job wasn't queued")
	}
	return jobs[0], nil
}

func (s *WorkspacesService) needsBaseline() error {
	cur := s.current()
	if cur.Root == "" || cur.Kind == workspace.KindPersonal {
		return core.ValidationError("Personal has no starting folder", nil)
	}
	if cur.Baseline == "" {
		return core.ValidationError("This workspace has no starting folder", nil)
	}
	return nil
}

// Restore re-copies missing or changed baseline files (a job).
func (s *WorkspacesService) Restore() (core.Job, error) {
	if err := s.needsBaseline(); err != nil {
		return core.Job{}, err
	}
	return s.submit(wsjobs.ActionRestore)
}

func (s *WorkspacesService) needsDemo() error {
	cur := s.current()
	if cur.Kind != workspace.KindDemo {
		return core.ValidationError("Tidy up is only for Demo workspaces", nil)
	}
	return nil
}

// TidyPreview lists what Tidy would move to the trash.
func (s *WorkspacesService) TidyPreview() (workspace.TidyPlan, error) {
	plan := workspace.TidyPlan{Sample: []string{}}
	if err := s.needsDemo(); err != nil {
		return plan, err
	}
	files, err := wsjobs.PlanTidy(context.Background(), s.current())
	if err != nil {
		return plan, core.Errorf(core.CodeInternal, "Couldn't look through the library").WithCause(err)
	}
	pr := s.Presenter()
	plan.Files = len(files)
	for i, f := range files {
		plan.Bytes += f.Size
		if i < 20 {
			plan.Sample = append(plan.Sample, pr.Path(f.Path))
		}
	}
	if s.Jobs != nil {
		busy, err := s.Jobs.List(context.Background(), core.JobFilter{
			Statuses: []core.JobStatus{core.JobQueued, core.JobRunning}, Limit: 500,
		})
		if err == nil {
			plan.Jobs = len(busy)
		}
	}
	return plan, nil
}

// Tidy moves non-baseline, non-kept library files to the trash (a job).
func (s *WorkspacesService) Tidy() (core.Job, error) {
	if err := s.needsDemo(); err != nil {
		return core.Job{}, err
	}
	return s.submit(wsjobs.ActionTidy)
}

// Presenter is what the frontend's displayPath needs (SPEC §A5).
func (s *WorkspacesService) Presenter() workspace.Presenter {
	return workspace.NewPresenter(s.current())
}
