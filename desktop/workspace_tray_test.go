package desktop

import (
	"testing"

	"toolbox/core"
)

func TestTrayWorkspaceSubmenu(t *testing.T) {
	find := func(m []trayItem, id string) *trayItem {
		for i := range m {
			if m[i].ID == id {
				return &m[i]
			}
		}
		return nil
	}
	if find(trayModel(trayState{}), "workspaces") != nil {
		t.Error("submenu shown with no workspaces")
	}
	if find(trayModel(trayState{Workspaces: []trayWorkspace{{ID: "personal", Name: "Personal", Current: true}}}), "workspaces") != nil {
		t.Error("submenu shown with only Personal")
	}
	m := trayModel(trayState{Workspaces: []trayWorkspace{
		{ID: "personal", Name: "Personal"},
		{ID: "abc", Name: "Demo", Current: true},
		{ID: "def", Name: "Old", Missing: true},
	}})
	sub := find(m, "workspaces")
	if sub == nil || !sub.Submenu || len(sub.Children) != 3 {
		t.Fatalf("submenu = %+v", sub)
	}
	if c := sub.Children[1]; c.ID != itemWorkspace+"abc" || !c.Checked || !c.Enabled {
		t.Errorf("current = %+v", c)
	}
	if c := sub.Children[2]; c.Enabled || c.Label != "Old (not found)" {
		t.Errorf("missing = %+v", c)
	}
	if c := sub.Children[0]; c.Checked || c.ID != itemWorkspace+"personal" {
		t.Errorf("personal = %+v", c)
	}
}

func TestTrayTooltipSuffix(t *testing.T) {
	if got := trayTooltip(trayState{}); got != "Toolbox" {
		t.Errorf("personal = %q", got)
	}
	if got := trayTooltip(trayState{WorkspaceName: "Demo"}); got != "Toolbox · Demo" {
		t.Errorf("demo = %q", got)
	}
	if got := trayTooltip(trayState{WorkspaceName: "Demo", LanListening: true, LanAlias: "Toolbox Demo"}); got != "Toolbox — receiving files as Toolbox Demo · Demo" {
		t.Errorf("lan = %q", got)
	}
}

func TestNoHotkeysEnv(t *testing.T) {
	reg := newFakeReg()
	m := newHotkeyManager(reg, nil, map[string]func(){core.HotkeyClipboard: func() {}})
	t.Setenv("TOOLBOX_NO_HOTKEYS", "1")
	for _, st := range m.Apply(core.DefaultHotkeys()) {
		if st.Registered {
			t.Errorf("%s registered under TOOLBOX_NO_HOTKEYS", st.Action)
		}
	}
	if len(reg.live) != 0 {
		t.Errorf("registrar called: %v", reg.log)
	}
	t.Setenv("TOOLBOX_NO_HOTKEYS", "")
	ok := false
	for _, st := range m.Apply(core.DefaultHotkeys()) {
		ok = ok || st.Registered
	}
	if !ok {
		t.Error("hotkeys not registered without the env var")
	}
}
