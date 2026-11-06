package focus

import "toolbox/core/focus"

// Engine is what the module and its service need from *focus.Engine
// (frozen in Wave 0); tests use a fake.
type Engine interface {
	State() focus.State
	Begin(req focus.StartRequest) (focus.Session, error)
	Extend(minutes int) (focus.Session, error)
	ExtendTo(until int64) (focus.Session, error)
	RequestWeaken(a focus.Weaken, rule *focus.AllowRule) (focus.Friction, error)
	ConfirmWeaken(a focus.Weaken, phrase string) error
	CancelWeaken()
	EndFor(runID string) error
	CloseAgain(pid uint32, created int64) error
	ForceClose(pid uint32, created int64) error
	LeaveOpen(pid uint32, created int64)
	SetLearn(on bool) error
	Profiles() ([]focus.Profile, error)
	SaveProfile(p focus.Profile) (focus.Profile, error)
	DeleteProfile(id string) error
	Settings() focus.Settings
	SaveSettings(s focus.Settings) (focus.Settings, error)
	Blocked(limit int) ([]focus.BlockedApp, error)
	Recent(limit int) ([]focus.Session, error)
	LearnList() ([]focus.LearnEntry, error)
	IgnoreLearn(path string) error
}

var _ Engine = (*focus.Engine)(nil)
