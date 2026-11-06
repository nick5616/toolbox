package focus

import (
	"toolbox/core"
	"toolbox/core/focus"
)

// App is an installed or running program the picker offers.
type App struct {
	Label string          `json:"label"`
	Path  string          `json:"path"`  // the executable (or .app bundle)
	Rule  focus.AllowRule `json:"rule"`  // the suggested rule: a folder rule at the install root, or an exe rule
	Icon  string          `json:"icon"`  // PNG data URL; "" = none (lettered tile)
	Store bool            `json:"store"` // a Microsoft Store app (WindowsApps)
}

// Service is the Focus Lock Wails service. Wave 0: the engine pass-throughs
// work once WP-F1 lands; Apps/Running/AppFor/AppIcon are WP-F2's.
type Service struct {
	eng Engine
}

// NewService builds the service.
func NewService(eng Engine) *Service { return &Service{eng: eng} }

func todo() error { return core.NotImplemented("Focus Lock") }

// State is the current state (also pushed as focus:changed).
func (s *Service) State() focus.State { return s.eng.State() }

// Settings returns Always allowed, the defaults and learn mode.
func (s *Service) Settings() focus.Settings { return s.eng.Settings() }

// SaveSettings stores them.
func (s *Service) SaveSettings(v focus.Settings) (focus.Settings, error) {
	return s.eng.SaveSettings(v)
}

// Profiles lists profiles by name.
func (s *Service) Profiles() ([]focus.Profile, error) { return s.eng.Profiles() }

// SaveProfile creates (ID "") or updates a profile.
func (s *Service) SaveProfile(p focus.Profile) (focus.Profile, error) { return s.eng.SaveProfile(p) }

// DeleteProfile deletes a profile.
func (s *Service) DeleteProfile(id string) error { return s.eng.DeleteProfile(id) }

// Start starts a session.
func (s *Service) Start(req focus.StartRequest) (focus.Session, error) { return s.eng.Begin(req) }

// Extend adds minutes to the active session.
func (s *Service) Extend(minutes int) (focus.Session, error) { return s.eng.Extend(minutes) }

// RequestWeaken starts the friction for end/allow/quit/emergency.
func (s *Service) RequestWeaken(a focus.Weaken, rule *focus.AllowRule) (focus.Friction, error) {
	return s.eng.RequestWeaken(a, rule)
}

// ConfirmWeaken finishes it with the typed phrase.
func (s *Service) ConfirmWeaken(a focus.Weaken, phrase string) error {
	return s.eng.ConfirmWeaken(a, phrase)
}

// CancelWeaken drops it.
func (s *Service) CancelWeaken() { s.eng.CancelWeaken() }

// CloseAgain asks a "Still open" app to close again.
func (s *Service) CloseAgain(pid uint32, created int64) error { return s.eng.CloseAgain(pid, created) }

// ForceClose terminates a "Still open" app.
func (s *Service) ForceClose(pid uint32, created int64) error { return s.eng.ForceClose(pid, created) }

// LeaveOpen leaves a "Still open" app running.
func (s *Service) LeaveOpen(pid uint32, created int64) { s.eng.LeaveOpen(pid, created) }

// Blocked groups the session's stops by program.
func (s *Service) Blocked(limit int) ([]focus.BlockedApp, error) { return s.eng.Blocked(limit) }

// Recent lists the last ended sessions.
func (s *Service) Recent(limit int) ([]focus.Session, error) { return s.eng.Recent(limit) }

// SetLearn turns learn mode on or off.
func (s *Service) SetLearn(on bool) error { return s.eng.SetLearn(on) }

// LearnList lists learn mode's would-stop programs.
func (s *Service) LearnList() ([]focus.LearnEntry, error) { return s.eng.LearnList() }

// IgnoreLearn forgets one program's learn entries ("" = all).
func (s *Service) IgnoreLearn(path string) error { return s.eng.IgnoreLearn(path) }

// Apps lists installed programs (Start menu / Applications), cached 10 min.
func (s *Service) Apps() ([]App, error) { return []App{}, todo() }

// Running lists programs with a window that are running now.
func (s *Service) Running() ([]App, error) { return []App{}, todo() }

// AppFor turns a browsed path into an App with its suggested rule.
func (s *Service) AppFor(path string) (App, error) { return App{}, todo() }

// AppIcon is a program's 32 px icon as a PNG data URL ("" = none).
func (s *Service) AppIcon(path string) string { return "" }

// WindowsExtras lists the always-allowed system folders outside the OS's own
// folder (read-only in the tool).
func (s *Service) WindowsExtras() []string { return focus.WindowsExtras() }

// StepShape exposes the step options type to the bindings.
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }
