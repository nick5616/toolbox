package desktop

import (
	"log/slog"

	"toolbox/core"
)

// autostarter is the OS login-item API (Wails' AutostartManager); tests use a
// fake so the real Run key is never touched.
type autostarter interface {
	Enable() error
	Disable() error
	IsEnabled() (bool, error)
}

// loginItem applies the StartAtLogin setting to the OS.
type loginItem struct{ a autostarter }

// beforeChange is the SettingsService.BeforeChange hook: it applies a changed
// StartAtLogin and aborts the update with a field error when the OS refuses.
// It must not call back into the settings service.
func (l loginItem) beforeChange(old, next core.Settings) error {
	if old.StartAtLogin == next.StartAtLogin {
		return nil
	}
	if err := l.apply(next.StartAtLogin); err != nil {
		return core.ValidationError("Couldn't change start at login",
			map[string]string{"startAtLogin": err.Error()})
	}
	return nil
}

func (l loginItem) apply(on bool) error {
	if on {
		return l.a.Enable()
	}
	return l.a.Disable()
}

// reconcile makes the OS state match the setting (the setting wins).
func (l loginItem) reconcile(want bool) {
	have, err := l.a.IsEnabled()
	if err != nil {
		slog.Warn("start at login: cannot read OS state", "err", err)
		return
	}
	if have == want {
		return
	}
	slog.Info("start at login: OS state differs from setting, applying setting", "setting", want, "os", have)
	if err := l.apply(want); err != nil {
		slog.Warn("start at login: cannot apply setting", "err", err)
	}
}
