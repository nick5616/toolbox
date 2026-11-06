package focus

import (
	"sync"
	"time"

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

// Service is the Focus Lock Wails service: engine pass-throughs plus the app
// catalog (apps.go) and icons (icons.go).
type Service struct {
	eng Engine

	mu       sync.Mutex
	cacheDir string                       // <support>/cache/focus-icons; "" = no disk cache
	platform focus.Platform               // lazily focus.NewPlatform(); tests set it
	clock    func() time.Time             // tests set it
	scan     func() []App                 // the installed-apps scan; tests set it
	apps     []App                        // cached Apps()
	appsAt   time.Time                    // when apps was scanned
	icons    map[string]string            // in-memory icon cache by path+mtime
	iconFn   func(string) ([]byte, error) // renders a PNG; tests set it
}

// NewService builds the service.
func NewService(eng Engine) *Service {
	return &Service{eng: eng, clock: time.Now, icons: map[string]string{}}
}

// plat returns the OS platform, built on first use.
func (s *Service) plat() focus.Platform {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.platform == nil {
		s.platform = focus.NewPlatform()
	}
	return s.platform
}

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

// WindowsExtras lists the always-allowed system folders outside the OS's own
// folder (read-only in the tool).
func (s *Service) WindowsExtras() []string { return focus.WindowsExtras() }

// StepShape exposes the step options type to the bindings.
func (s *Service) StepShape() StepOptions { return DefaultStepOptions() }
