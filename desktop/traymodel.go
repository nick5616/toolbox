package desktop

import (
	"fmt"
	"strings"

	"toolbox/core"
)

// Tray item IDs.
const (
	itemOpen      = "open"
	itemClipboard = "clipboard"
	itemPause     = "pause"
	itemRunning   = "running"
	itemRecent    = "recent"
	itemRecentFmt = "recent:%d"
	itemSettings  = "settings"
	itemQuit      = "quit"
	itemSep       = "-"
)

const maxRecent = 5

// trayState is everything the tray menu depends on.
type trayState struct {
	Mac              bool
	ClipboardHotkey  string // accelerator when registered, else ""
	ClipboardEnabled bool   // Settings.Clipboard.Enabled
	Paused           bool
	Running          int // running + queued jobs
	Recent           []core.Output
}

// trayItem is one row of the tray menu.
type trayItem struct {
	ID        string
	Label     string
	Enabled   bool
	Checkbox  bool
	Checked   bool
	Separator bool
	Children  []trayItem // non-nil = submenu
	Submenu   bool
}

func item(id, label string) trayItem { return trayItem{ID: id, Label: label, Enabled: true} }

// trayModel builds the menu from state. Hidden items are simply absent.
func trayModel(s trayState) []trayItem {
	clip := "Clipboard history"
	if hint := displayAccelerator(s.ClipboardHotkey, s.Mac); hint != "" {
		clip += "  " + hint
	}
	m := []trayItem{item(itemOpen, "Open Toolbox"), item(itemClipboard, clip)}
	if s.ClipboardEnabled {
		p := item(itemPause, "Pause clipboard history")
		p.Checkbox = true
		if s.Paused {
			p.Label = "Resume clipboard history"
			p.Checked = true
		}
		m = append(m, p)
	}
	m = append(m, trayItem{ID: itemSep, Separator: true})
	if s.Running > 0 {
		label := fmt.Sprintf("Running: %d jobs", s.Running)
		if s.Running == 1 {
			label = "Running: 1 job"
		}
		m = append(m, trayItem{ID: itemRunning, Label: label})
	}
	recent := trayItem{ID: itemRecent, Label: "Recent outputs", Enabled: true, Submenu: true}
	for i, o := range s.Recent {
		if i >= maxRecent {
			break
		}
		name := o.Name
		if name == "" {
			name = o.Path
		}
		recent.Children = append(recent.Children, item(fmt.Sprintf(itemRecentFmt, i), name))
	}
	if len(recent.Children) == 0 {
		recent.Children = []trayItem{{ID: "recent:none", Label: "No outputs yet"}}
	}
	m = append(m, recent,
		trayItem{ID: itemSep, Separator: true},
		item(itemSettings, "Settings…"),
		item(itemQuit, "Quit Toolbox"))
	return m
}

// displayAccelerator renders a Wails accelerator for humans.
func displayAccelerator(accel string, mac bool) string {
	if accel == "" {
		return ""
	}
	cmd := "Ctrl"
	if mac {
		cmd = "Cmd"
	}
	parts := strings.Split(accel, "+")
	for i, p := range parts {
		if strings.EqualFold(p, "CmdOrCtrl") {
			parts[i] = cmd
		}
	}
	return strings.Join(parts, "+")
}
