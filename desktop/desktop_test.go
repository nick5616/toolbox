package desktop

import (
	"errors"
	"reflect"
	"testing"

	"toolbox/core"
)

type fakeReg struct {
	fail  map[string]error
	panic map[string]bool
	live  map[string]func()
	log   []string
}

func newFakeReg() *fakeReg {
	return &fakeReg{fail: map[string]error{}, panic: map[string]bool{}, live: map[string]func(){}}
}

func (f *fakeReg) Register(a string, cb func()) error {
	f.log = append(f.log, "reg:"+a)
	if f.panic[a] {
		panic("boom")
	}
	if err := f.fail[a]; err != nil {
		return err
	}
	f.live[a] = cb
	return nil
}

func (f *fakeReg) Unregister(a string) error {
	f.log = append(f.log, "unreg:"+a)
	delete(f.live, a)
	return nil
}

type emitRec struct {
	names []string
	data  []any
}

func (e *emitRec) Emit(n string, d any) { e.names = append(e.names, n); e.data = append(e.data, d) }

func TestHotkeyApply(t *testing.T) {
	reg := newFakeReg()
	em := &emitRec{}
	hit := ""
	m := newHotkeyManager(reg, em, map[string]func(){
		core.HotkeyClipboard: func() { hit = "clip" },
		core.HotkeyQuickOpen: func() { hit = "open" },
	})

	st := m.Apply(map[string]string{core.HotkeyClipboard: "Ctrl+Alt+V", core.HotkeyQuickOpen: ""})
	if len(st) != 2 || !st[0].Registered || st[1].Registered || st[1].Error != "" {
		t.Fatalf("status = %+v", st)
	}
	if st[0].Action != core.HotkeyClipboard || st[1].Action != core.HotkeyQuickOpen {
		t.Fatalf("order: %+v", st)
	}
	reg.live["Ctrl+Alt+V"]()
	if hit != "clip" {
		t.Fatal("handler not wired")
	}
	if len(em.names) != 1 || em.names[0] != core.EventHotkeysStatus {
		t.Fatalf("emit: %v", em.names)
	}

	// Re-apply unregisters the previous accelerator first; errors per action.
	reg.log = nil
	reg.fail["Ctrl+Alt+Space"] = errors.New("RegisterHotKey failed: hotkey is already registered")
	reg.fail["Ctrl+Alt+B"] = errors.New("weird os failure")
	st = m.Apply(map[string]string{core.HotkeyClipboard: "Ctrl+Alt+B", core.HotkeyQuickOpen: "Ctrl+Alt+Space"})
	if !reflect.DeepEqual(reg.log[:1], []string{"unreg:Ctrl+Alt+V"}) {
		t.Fatalf("log = %v", reg.log)
	}
	if st[0].Registered || st[0].Error != "weird os failure" {
		t.Fatalf("clip = %+v", st[0])
	}
	if st[1].Registered || st[1].Error != "In use by another app" {
		t.Fatalf("open = %+v", st[1])
	}
	if len(reg.live) != 0 {
		t.Fatalf("live = %v", reg.live)
	}
	if !reflect.DeepEqual(m.Status(), st) || len(em.names) != 2 {
		t.Fatal("status/emit mismatch")
	}
}

func TestHotkeyPanicAndUnknown(t *testing.T) {
	reg := newFakeReg()
	reg.panic["Ctrl+Alt+V"] = true
	m := newHotkeyManager(reg, nil, map[string]func(){core.HotkeyClipboard: func() {}})
	st := m.Apply(map[string]string{core.HotkeyClipboard: "Ctrl+Alt+V", core.HotkeyQuickOpen: "Ctrl+Alt+Q"})
	if st[0].Registered || st[0].Error == "" || st[1].Error != "Unknown action" {
		t.Fatalf("%+v", st)
	}
	if got := newHotkeyManager(reg, nil, nil).Status(); got == nil || len(got) != 0 {
		t.Fatalf("empty status = %v", got)
	}
}

func ids(items []trayItem) []string {
	var out []string
	for _, it := range items {
		out = append(out, it.ID)
	}
	return out
}

func find(items []trayItem, id string) *trayItem {
	for i := range items {
		if items[i].ID == id {
			return &items[i]
		}
	}
	return nil
}

func TestTrayModel(t *testing.T) {
	base := trayState{ClipboardHotkey: "CmdOrCtrl+Alt+V"}
	m := trayModel(base)
	if find(m, itemPause) != nil || find(m, itemRunning) != nil {
		t.Fatalf("pause/running should be hidden: %v", ids(m))
	}
	if c := find(m, itemClipboard); c.Label != "Clipboard history  Ctrl+Alt+V" {
		t.Fatalf("label = %q", c.Label)
	}
	if c := find(trayModel(trayState{ClipboardHotkey: "CmdOrCtrl+Alt+V", Mac: true}), itemClipboard); c.Label != "Clipboard history  Cmd+Alt+V" {
		t.Fatalf("mac label = %q", c.Label)
	}
	if c := find(trayModel(trayState{}), itemClipboard); c.Label != "Clipboard history" {
		t.Fatalf("no-hint label = %q", c.Label)
	}

	rec := trayModel(trayState{ClipboardEnabled: true})
	p := find(rec, itemPause)
	if p == nil || !p.Checkbox || p.Checked || p.Label != "Pause clipboard history" {
		t.Fatalf("pause = %+v", p)
	}
	paused := find(trayModel(trayState{ClipboardEnabled: true, Paused: true}), itemPause)
	if !paused.Checked || paused.Label != "Resume clipboard history" {
		t.Fatalf("paused = %+v", paused)
	}
	if find(trayModel(trayState{Paused: true}), itemPause) != nil {
		t.Fatal("pause shown while recording is off")
	}

	if r := find(trayModel(trayState{Running: 3}), itemRunning); r == nil || r.Label != "Running: 3 jobs" || r.Enabled {
		t.Fatalf("running = %+v", r)
	}
	if r := find(trayModel(trayState{Running: 1}), itemRunning); r.Label != "Running: 1 job" {
		t.Fatalf("running = %+v", r)
	}

	var outs []core.Output
	for i := 0; i < 8; i++ {
		outs = append(outs, core.Output{Name: "f", Path: "/f"})
	}
	if r := find(trayModel(trayState{Recent: outs}), itemRecent); len(r.Children) != 5 || !r.Children[0].Enabled {
		t.Fatalf("recent = %+v", r)
	}
	if r := find(trayModel(trayState{}), itemRecent); len(r.Children) != 1 || r.Children[0].Enabled {
		t.Fatalf("empty recent = %+v", r)
	}

	got := ids(m)
	want := []string{itemOpen, itemClipboard, itemSep, itemRecent, itemSep, itemSettings, itemQuit}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %v", got)
	}
}

func TestHandleClose(t *testing.T) {
	for _, keep := range []bool{true, false} {
		var calls []string
		var emitted []string
		handleClose(keep, closeActions{
			cancel: func() { calls = append(calls, "cancel") },
			hide:   func() { calls = append(calls, "hide") },
			emit:   func(n string, _ any) { emitted = append(emitted, n) },
			quit:   func() { calls = append(calls, "quit") },
		})
		if keep {
			if !reflect.DeepEqual(calls, []string{"cancel", "hide"}) || !reflect.DeepEqual(emitted, []string{core.EventHiddenToTray}) {
				t.Fatalf("keep: %v %v", calls, emitted)
			}
		} else if !reflect.DeepEqual(calls, []string{"quit"}) || len(emitted) != 0 {
			t.Fatalf("quit: %v %v", calls, emitted)
		}
	}
}

type fakeAuto struct {
	on     bool
	err    error
	isErr  error
	enable int
	disab  int
}

func (f *fakeAuto) Enable() error {
	f.enable++
	if f.err == nil {
		f.on = true
	}
	return f.err
}
func (f *fakeAuto) Disable() error {
	f.disab++
	if f.err == nil {
		f.on = false
	}
	return f.err
}
func (f *fakeAuto) IsEnabled() (bool, error) { return f.on, f.isErr }

func TestLoginItem(t *testing.T) {
	f := &fakeAuto{}
	l := loginItem{f}

	if err := l.beforeChange(core.Settings{}, core.Settings{KeepInTray: true}); err != nil || f.enable+f.disab != 0 {
		t.Fatalf("unchanged: %v", err)
	}
	if err := l.beforeChange(core.Settings{}, core.Settings{StartAtLogin: true}); err != nil || !f.on {
		t.Fatalf("enable: %v", err)
	}
	if err := l.beforeChange(core.Settings{StartAtLogin: true}, core.Settings{}); err != nil || f.on {
		t.Fatalf("disable: %v", err)
	}

	f.err = errors.New("access denied")
	err := l.beforeChange(core.Settings{}, core.Settings{StartAtLogin: true})
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeValidation || ae.Fields["startAtLogin"] != "access denied" {
		t.Fatalf("err = %v", err)
	}
}

func TestLoginReconcile(t *testing.T) {
	f := &fakeAuto{on: false}
	loginItem{f}.reconcile(true)
	if !f.on {
		t.Fatal("setting should win (enable)")
	}
	loginItem{f}.reconcile(false)
	if f.on {
		t.Fatal("setting should win (disable)")
	}
	n := f.enable + f.disab
	loginItem{f}.reconcile(false)
	if f.enable+f.disab != n {
		t.Fatal("no-op expected when in sync")
	}
	f.isErr = errors.New("nope")
	loginItem{f}.reconcile(true) // must not panic or apply
	if f.on {
		t.Fatal("must not apply when state unreadable")
	}
}

func TestPopupPosition(t *testing.T) {
	x, y := popupPosition(0, 0, 1920, 1040, 440, 560)
	if x != 740 || y != 160 {
		t.Fatalf("%d,%d", x, y)
	}
	if _, y := popupPosition(0, 0, 800, 400, 440, 560); y != 0 {
		t.Fatalf("y = %d", y)
	}
}
