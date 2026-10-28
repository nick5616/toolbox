package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/sidecar"
)

// ModulesService exposes the registry.
type ModulesService struct {
	Reg *core.Registry
}

// List returns all visible modules (ready and coming soon), in sidebar order.
func (s *ModulesService) List() []core.Descriptor { return s.Reg.List() }

// Match reports which modules accept the given file paths.
func (s *ModulesService) Match(paths []string) core.MatchResult { return s.Reg.Match(paths) }

// JobsService exposes the job manager.
type JobsService struct {
	Jobs *core.Jobs
}

// ServiceShutdown cancels running jobs and waits briefly for them.
func (s *JobsService) ServiceShutdown() error { return s.Jobs.Shutdown(5 * time.Second) }

// List returns jobs, newest first.
func (s *JobsService) List(f core.JobFilter) ([]core.Job, error) {
	return s.Jobs.List(context.Background(), f)
}

// Get returns one job.
func (s *JobsService) Get(id string) (core.Job, error) { return s.Jobs.Get(context.Background(), id) }

// Cancel cancels a queued or running job.
func (s *JobsService) Cancel(id string) error { return s.Jobs.Cancel(id) }

// CancelAll cancels every queued and running job.
func (s *JobsService) CancelAll() error {
	s.Jobs.CancelAll()
	return nil
}

// Retry re-queues a failed or cancelled job.
func (s *JobsService) Retry(id string) (core.Job, error) {
	return s.Jobs.Retry(context.Background(), id)
}

// Remove deletes a finished job (its outputs stay in the library).
func (s *JobsService) Remove(id string) error { return s.Jobs.Remove(context.Background(), id) }

// ClearFinished removes all finished jobs and returns how many.
func (s *JobsService) ClearFinished() (int, error) {
	return s.Jobs.ClearFinished(context.Background())
}

// Logs returns a job's persisted log lines.
func (s *JobsService) Logs(id string) ([]core.LogLine, error) {
	return s.Jobs.Logs(context.Background(), id)
}

// LibraryService exposes recent outputs and file-manager actions.
type LibraryService struct {
	Outputs  core.OutputStore
	Settings *core.SettingsService
	Paths    core.Paths
	Em       core.Emitter
}

// Recent pages through outputs, newest first.
func (s *LibraryService) Recent(q core.OutputQuery) (core.OutputPage, error) {
	return s.Outputs.ListOutputs(context.Background(), q)
}

func (s *LibraryService) existing(id string) (core.Output, error) {
	o, err := s.Outputs.GetOutput(context.Background(), id)
	if err != nil {
		return o, err
	}
	if _, err := os.Stat(o.Path); err != nil {
		return o, core.Errorf(core.CodeNotFound, "%s no longer exists", o.Name).
			WithHint("Remove it from the library").WithCause(err)
	}
	return o, nil
}

// Reveal shows the output in Finder / Explorer.
func (s *LibraryService) Reveal(outputID string) error {
	o, err := s.existing(outputID)
	if err != nil {
		return err
	}
	return application.Get().Env.OpenFileManager(o.Path, true)
}

// Open opens the output with its default application.
func (s *LibraryService) Open(outputID string) error {
	o, err := s.existing(outputID)
	if err != nil {
		return err
	}
	return application.Get().Browser.OpenFile(o.Path)
}

// RevealPath reveals a path inside the library or support dir. Directories
// are opened; files are selected.
func (s *LibraryService) RevealPath(path string) error {
	lib := s.Settings.Current().LibraryDir
	if !core.IsWithin(path, lib) && !core.IsWithin(path, s.Paths.SupportDir) {
		return core.Errorf(core.CodeConflict, "Only paths inside the library or app folder can be revealed")
	}
	info, err := os.Stat(path)
	if err != nil {
		return core.Errorf(core.CodeNotFound, "%s doesn't exist", path).WithCause(err)
	}
	return application.Get().Env.OpenFileManager(path, !info.IsDir())
}

// Remove deletes an output from the library database (not from disk).
func (s *LibraryService) Remove(outputID string) error {
	if err := s.Outputs.DeleteOutput(context.Background(), outputID); err != nil {
		return err
	}
	s.Em.Emit(core.EventLibraryRemoved, core.OutputsRemoved{IDs: []string{outputID}})
	return nil
}

// OpenLibraryFolder opens <library>/<subdir> ("" = root), creating it.
func (s *LibraryService) OpenLibraryFolder(subdir string) error {
	clean := filepath.Clean(subdir)
	if subdir != "" && (filepath.IsAbs(subdir) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator))) {
		return core.Errorf(core.CodeValidation, "Invalid folder")
	}
	dir := filepath.Join(s.Settings.Current().LibraryDir, subdir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return core.Errorf(core.CodeConflict, "Can't create %s", dir).WithCause(err)
	}
	return application.Get().Env.OpenFileManager(dir, false)
}

// SettingsService exposes user settings and app info.
type SettingsService struct {
	Settings *core.SettingsService
	Paths    core.Paths
}

// Get returns the current settings.
func (s *SettingsService) Get() core.Settings { return s.Settings.Current() }

// Update applies a partial update.
func (s *SettingsService) Update(p core.SettingsPatch) (core.Settings, error) {
	return s.Settings.Update(context.Background(), p)
}

// ChooseLibraryDir shows a native folder picker. Returns "" if cancelled.
func (s *SettingsService) ChooseLibraryDir() (string, error) {
	dir, err := application.Get().Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseDirectories: true,
		CanChooseFiles:       false,
		CanCreateDirectories: true,
		Title:                "Choose library folder",
		ButtonText:           "Choose",
		Directory:            s.Settings.Current().LibraryDir,
	}).PromptForSingleSelection()
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return "", nil
		}
		return "", fmt.Errorf("folder dialog: %w", err)
	}
	return dir, nil
}

// ModuleState returns a module's saved UI state JSON ("" if none).
func (s *SettingsService) ModuleState(moduleID string) (string, error) {
	return s.Settings.ModuleState(context.Background(), moduleID)
}

// SetModuleState saves a module's UI state JSON.
func (s *SettingsService) SetModuleState(moduleID, stateJSON string) error {
	return s.Settings.SetModuleState(context.Background(), moduleID, stateJSON)
}

// AppInfo describes the running app.
func (s *SettingsService) AppInfo() core.AppInfo {
	return core.AppInfo{
		Version:    core.Version,
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
		SupportDir: s.Paths.SupportDir,
		DBPath:     s.Paths.DBPath,
		LogPath:    s.Paths.LogFile,
		LibraryDir: s.Settings.Current().LibraryDir,
	}
}

// DepsService exposes dependency status and the managed installers.
type DepsService struct {
	Deps   *deps.Service
	Jobs   *core.Jobs
	Reg    *core.Registry
	Engine *sidecar.Manager
	Paths  core.Paths
	// StopExiftool stops the EXIF tool's long-running ExifTool process so an
	// update can replace its files (Windows locks running executables).
	StopExiftool func()
}

// List returns cached dependency statuses.
func (s *DepsService) List() []core.DepStatus { return s.Deps.List() }

// Recheck re-detects all dependencies.
func (s *DepsService) Recheck(ctx context.Context) ([]core.DepStatus, error) {
	return s.Deps.Detect(ctx), nil
}

// UpdateYtDlp queues the install/update job for the managed yt-dlp.
func (s *DepsService) UpdateYtDlp() (core.Job, error) {
	users := s.Reg.RequiringDep(deps.YtDlp)
	var others []string
	for _, id := range users {
		if id != deps.UpdateModuleID {
			others = append(others, id)
		}
	}
	if s.Jobs.HasActive(others...) {
		return core.Job{}, core.Errorf(core.CodeConflict, "Wait for running downloads to finish")
	}
	if s.Jobs.HasActive(deps.UpdateModuleID) {
		return core.Job{}, core.Errorf(core.CodeConflict, "yt-dlp is already being updated")
	}
	jobs, err := s.Jobs.Submit(context.Background(), deps.UpdateModuleID, nil, "{}")
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "No update job was created")
	}
	return jobs[0], nil
}

// engineUsers are the modules that run on the audio engine.
func (s *DepsService) engineUsers() []string { return s.Reg.RequiringDep(sidecar.DepID) }

func (s *DepsService) submitSystem(moduleID string) (core.Job, error) {
	if s.Jobs.HasActive(moduleID) {
		return core.Job{}, core.Errorf(core.CodeConflict, "Already in progress")
	}
	jobs, err := s.Jobs.Submit(context.Background(), moduleID, nil, "{}")
	if err != nil {
		return core.Job{}, err
	}
	if len(jobs) == 0 {
		return core.Job{}, core.Errorf(core.CodeInternal, "No job was created")
	}
	return jobs[0], nil
}

// InstallAudioEngine queues install / update / repair of the audio engine.
func (s *DepsService) InstallAudioEngine() (core.Job, error) {
	if s.Jobs.HasActive(s.engineUsers()...) {
		return core.Job{}, core.Errorf(core.CodeConflict, "Wait for running audio jobs to finish")
	}
	return s.submitSystem(sidecar.SetupModuleID)
}

// RemoveAudioEngine deletes the installed engine (models are kept).
func (s *DepsService) RemoveAudioEngine() error {
	if s.Jobs.HasActive(append(s.engineUsers(), sidecar.SetupModuleID)...) {
		return core.Errorf(core.CodeConflict, "Wait for running audio jobs to finish")
	}
	if err := sidecar.Remove(s.Paths, s.Engine); err != nil {
		return err
	}
	s.Deps.Detect(context.Background())
	return nil
}

// ModelsUsage is the size of downloaded models in bytes.
func (s *DepsService) ModelsUsage() (int64, error) { return sidecar.ModelsUsage(s.Paths) }

// ClearModels deletes downloaded models.
func (s *DepsService) ClearModels() error {
	if s.Jobs.HasActive(s.engineUsers()...) {
		return core.Errorf(core.CodeConflict, "Wait for running audio jobs to finish")
	}
	return sidecar.ClearModels(s.Paths)
}

// UpdateUv queues the uv install/update job.
func (s *DepsService) UpdateUv() (core.Job, error) {
	if s.Jobs.HasActive(sidecar.SetupModuleID) {
		return core.Job{}, core.Errorf(core.CodeConflict, "Wait for the audio engine setup to finish")
	}
	return s.submitSystem(deps.UVUpdateModuleID)
}

// InstallUpscaler queues the upscaler install/update job (pinned versions).
func (s *DepsService) InstallUpscaler() (core.Job, error) {
	if s.Jobs.HasActive(s.Reg.RequiringDep(deps.Upscayl)...) {
		return core.Job{}, core.Errorf(core.CodeConflict, "Wait for running upscaling jobs to finish")
	}
	return s.submitSystem(deps.UpscalerInstallModuleID)
}

// UpdateExiftool queues the ExifTool install/update job.
func (s *DepsService) UpdateExiftool() (core.Job, error) {
	if s.Jobs.HasActive(s.Reg.RequiringDep(deps.ExifTool)...) {
		return core.Job{}, core.Errorf(core.CodeConflict, "Wait for running EXIF jobs to finish")
	}
	if s.StopExiftool != nil && !s.Jobs.HasActive(deps.ExifToolUpdateModuleID) {
		s.StopExiftool()
	}
	return s.submitSystem(deps.ExifToolUpdateModuleID)
}
