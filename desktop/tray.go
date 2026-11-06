package desktop

import (
	_ "embed"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"toolbox/core"
	"toolbox/core/lan"
)

//go:embed icons/tray.png
var trayIconPNG []byte

//go:embed icons/tray_template.png
var trayTemplatePNG []byte

const trayDebounce = 200 * time.Millisecond

// tray is the thin Wails glue around trayModel.
type tray struct {
	s    *Shell
	icon *application.SystemTray

	mu    sync.Mutex
	timer *time.Timer

	// --- local file transfer (Phase 13) ---
	lanResume bool   // the tray stopped an "always" receiver: offer to start it again
	lanPrompt string // alias of the device whose transfer prompt is open
}

func newTray(s *Shell) *tray { return &tray{s: s} }

func (t *tray) start() {
	t.icon = t.s.o.App.SystemTray.New()
	if runtime.GOOS == "darwin" {
		t.icon.SetTemplateIcon(trayTemplatePNG) // click opens the menu (platform convention)
	} else {
		t.icon.SetIcon(trayIconPNG)
		t.icon.OnClick(func() { _ = t.s.ShowMain("") })
	}
	t.icon.SetTooltip("Toolbox")
	t.icon.SetMenu(t.buildMenu())

	// Go-emitted custom events reach Go listeners (EventProcessor.Emit
	// dispatches to listeners), so subscribe instead of wrapping the Emitter.
	for _, name := range []string{
		core.EventJobsChanged, core.EventLibraryAdded, core.EventClipboardState,
		core.EventSettingsChanged, core.EventHotkeysStatus,
		core.EventVaultState, // --- vault (VA1) ---
		lan.EventState,       // --- local file transfer (Phase 13) ---
	} {
		t.s.o.App.Event.On(name, func(*application.CustomEvent) { t.refresh() })
	}
	// --- local file transfer (Phase 13) ---
	t.s.o.App.Event.On(lan.EventPrompt, func(e *application.CustomEvent) {
		alias := "Someone"
		switch p := e.Data.(type) {
		case lan.Prompt:
			if p.Kind == lan.PromptPair {
				return // pairing has its own dialog; the tooltip is about files
			}
			alias = p.Device.Alias
		case *lan.Prompt:
			if p != nil {
				if p.Kind == lan.PromptPair {
					return
				}
				alias = p.Device.Alias
			}
		}
		t.mu.Lock()
		t.lanPrompt = alias
		t.mu.Unlock()
		t.refresh()
	})
	t.s.o.App.Event.On(lan.EventPromptClose, func(*application.CustomEvent) {
		t.mu.Lock()
		t.lanPrompt = ""
		t.mu.Unlock()
		t.refresh()
	})
}

// refresh schedules a debounced menu rebuild.
func (t *tray) refresh() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.timer != nil {
		t.timer.Stop()
	}
	t.timer = time.AfterFunc(trayDebounce, func() {
		if t.icon != nil {
			t.icon.SetMenu(t.buildMenu())
		}
	})
}

func (t *tray) state() trayState {
	o := t.s.o
	st := trayState{Mac: runtime.GOOS == "darwin"}
	cur := o.Settings.Current()
	st.ClipboardEnabled = cur.Clipboard.Enabled
	for _, h := range t.s.HotkeyStatus() {
		if h.Action == core.HotkeyClipboard && h.Registered {
			st.ClipboardHotkey = h.Accelerator
		}
	}
	if o.Clipboard != nil {
		st.Paused = o.Clipboard.State().Paused
	}
	// --- vault (VA1) ---
	if o.Vault != nil {
		st.VaultUnlocked = o.Vault.State().Unlocked
	}
	// --- end vault ---
	st.NeedYou, st.NeedYouName = t.s.pipelinesNeedYou()
	if o.Lan != nil {
		ls := o.Lan.State()
		st.LanListening, st.LanAlias = ls.Listening, ls.Alias
		t.mu.Lock()
		st.LanPrompt = t.lanPrompt
		if ls.Mode != lan.ReceiveOff {
			t.lanResume = false // receiving was turned on again somewhere else
		}
		st.LanCanStart = !ls.Listening && (ls.Mode == lan.ReceiveAlways || t.lanResume)
		t.mu.Unlock()
		if !ls.Listening {
			st.LanPrompt = ""
		}
	}
	ctx, cancel := timeoutCtx()
	defer cancel()
	if jobs, err := o.Jobs.List(ctx, core.JobFilter{
		Statuses: []core.JobStatus{core.JobRunning, core.JobQueued}, Limit: 500,
	}); err == nil {
		st.Running = len(jobs)
	}
	if page, err := o.Outputs.ListOutputs(ctx, core.OutputQuery{Limit: maxRecent}); err == nil {
		st.Recent = page.Items
	}
	return st
}

func (t *tray) buildMenu() *application.Menu {
	st := t.state()
	if t.icon != nil {
		t.icon.SetTooltip(trayTooltip(st))
	}
	menu := application.NewMenu()
	fill(menu, trayModel(st), st, t)
	return menu
}

func fill(m *application.Menu, items []trayItem, st trayState, t *tray) {
	for _, it := range items {
		switch {
		case it.Separator:
			m.AddSeparator()
		case it.Submenu:
			sub := m.AddSubmenu(it.Label)
			fill(sub, it.Children, st, t)
		case it.Checkbox:
			mi := m.AddCheckbox(it.Label, it.Checked)
			mi.SetChecked(it.Checked)
			mi.OnClick(t.handler(it.ID, st))
		default:
			mi := m.Add(it.Label)
			mi.SetEnabled(it.Enabled)
			if it.Enabled {
				mi.OnClick(t.handler(it.ID, st))
			}
		}
	}
}

func (t *tray) handler(id string, st trayState) func(*application.Context) {
	return func(*application.Context) {
		s := t.s
		switch {
		case id == itemOpen:
			_ = s.ShowMain("")
		case id == itemClipboard:
			_ = s.TogglePopup()
		case id == itemPause:
			if s.o.Clipboard != nil {
				if s.o.Clipboard.State().Paused {
					_ = s.o.Clipboard.Resume()
				} else {
					_ = s.o.Clipboard.Pause()
				}
			}
			t.refresh()
		// --- vault (VA1) ---
		case id == itemLockVault:
			if s.o.Vault != nil {
				_ = s.o.Vault.Lock()
			}
			t.refresh()
		// --- end vault ---
		// --- local file transfer (Phase 13) ---
		case id == itemLanStop:
			if s.o.Lan != nil {
				if s.o.Lan.State().Mode == lan.ReceiveAlways {
					t.mu.Lock()
					t.lanResume = true
					t.mu.Unlock()
				}
				_ = s.o.Lan.SetReceive(lan.ReceiveOff)
			}
			t.refresh()
		case id == itemLanStart:
			if s.o.Lan != nil {
				t.mu.Lock()
				t.lanResume = false
				t.mu.Unlock()
				_ = s.o.Lan.SetReceive(lan.ReceiveAlways)
			}
			t.refresh()
		case id == itemPipelines:
			_ = s.ShowMain(NavigatePipelineRuns)
		case id == itemSettings:
			_ = s.ShowMain("settings")
		case id == itemQuit:
			s.Quit()
		default:
			var i int
			if _, err := fmt.Sscanf(id, itemRecentFmt, &i); err == nil && i >= 0 && i < len(st.Recent) {
				_ = s.o.App.Env.OpenFileManager(st.Recent[i].Path, true)
			}
		}
	}
}
