package focus

import "testing"

func TestReusedToolboxPIDIsNotToolbox(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	// a Toolbox child (parent = Toolbox, pid 100) is allowed
	h.fp.add(200, 100, 2000, `C:\Apps\helper.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs())
	// it exits and its PID is reused by a blocked program with a child
	h.fp.remove(200)
	h.e.tickNow()
	h.fp.add(200, 1, 5000, blockedExe)
	h.fp.add(201, 200, 5010, `C:\Program Files\Discord\helper.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs(), 200, 201)
	h.e.mu.Lock()
	_, stale := h.e.w.toolbox[200]
	h.e.mu.Unlock()
	if stale {
		t.Fatal("exited Toolbox child still in the Toolbox set")
	}
	// the stop guard compares Created too
	h.e.mu.Lock()
	defer h.e.mu.Unlock()
	h.e.w.toolbox[9] = 1
	if !h.e.safeToStopLocked(ProcInfo{PID: 9, Created: 2, Session: 1, Path: blockedExe}, h.e.w) {
		t.Fatal("a reused PID with another start time must be stoppable")
	}
}

func TestDecideStaleParentEntry(t *testing.T) {
	w := newWatcher(ProcInfo{PID: 100, Created: 1000})
	w.toolbox[200] = 2000 // stale: PID 200 was reused below
	w.insert(&seenEntry{info: ProcInfo{PID: 200, Created: 5000}, v: Verdict{Reason: "blocked"}})
	pol := &SessionPolicy{Self: ProcInfo{PID: 100, Created: 1000}, Session: 1, ToolboxPIDs: w.toolbox}
	v := Decide(ProcInfo{PID: 201, ParentPID: 200, Created: 5010, Session: 1, Path: blockedExe}, pol, w)
	if v.Allow {
		t.Fatalf("child of a reused PID treated as Toolbox's: %+v", v)
	}
}
