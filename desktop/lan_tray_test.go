package desktop

import "testing"

func TestLanTrayItems(t *testing.T) {
	has := func(m []trayItem, id string) (trayItem, bool) {
		for _, it := range m {
			if it.ID == id {
				return it, true
			}
		}
		return trayItem{}, false
	}

	off := trayModel(trayState{})
	for _, id := range []string{itemLanStatus, itemLanStop, itemLanStart} {
		if _, ok := has(off, id); ok {
			t.Errorf("off: unexpected %s", id)
		}
	}

	on := trayModel(trayState{LanListening: true, LanAlias: "Desk"})
	status, ok := has(on, itemLanStatus)
	if !ok || status.Label != "Receiving files — Desk" || status.Enabled {
		t.Errorf("status = %+v", status)
	}
	if stop, ok := has(on, itemLanStop); !ok || stop.Label != "Stop receiving" || !stop.Enabled {
		t.Errorf("stop = %+v", stop)
	}
	if _, ok := has(on, itemLanStart); ok {
		t.Error("start shown while listening")
	}

	start, ok := has(trayModel(trayState{LanCanStart: true}), itemLanStart)
	if !ok || start.Label != "Start receiving files" || !start.Enabled {
		t.Errorf("start = %+v", start)
	}
	if _, ok := has(trayModel(trayState{LanListening: true, LanCanStart: true}), itemLanStart); ok {
		t.Error("start shown while listening")
	}
}

func TestTrayTooltip(t *testing.T) {
	for name, tc := range map[string]struct {
		s    trayState
		want string
	}{
		"idle":      {trayState{}, "Toolbox"},
		"receiving": {trayState{LanListening: true, LanAlias: "Desk"}, "Toolbox — receiving files as Desk"},
		"prompt":    {trayState{LanListening: true, LanAlias: "Desk", LanPrompt: "Pixel"}, "Toolbox — Pixel wants to send you files"},
	} {
		if got := trayTooltip(tc.s); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
}
