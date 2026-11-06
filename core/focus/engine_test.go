package focus

import (
	"context"
	"errors"
	"reflect"
	"runtime"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

const blockedExe = `C:\Program Files\Discord\Discord.exe`

func eqPIDs(t *testing.T, got []uint32, want ...uint32) {
	t.Helper()
	if len(want) == 0 {
		want = []uint32{}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pids = %v, want %v", got, want)
	}
}

func wantCode(t *testing.T, err error, code core.ErrorCode) {
	t.Helper()
	if !core.IsCode(err, code) {
		t.Fatalf("err = %v, want code %s", err, code)
	}
}

// ---- loop ------------------------------------------------------------------------

func TestLoopDecidesEachProcessOnce(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow() // initial pass over an empty machine
	h.fp.add(200, 1, 5000, blockedExe)
	h.e.tickNow()
	h.e.tickNow()
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs(), 200)
	if n := h.fp.pathCalls[200]; n != 1 {
		t.Fatalf("Paths called %d times for the process", n)
	}
	st := h.e.State()
	if st.Session == nil || st.Session.Blocked != 1 {
		t.Fatalf("blocked count = %+v", st.Session)
	}
	evs := h.st.eventsFor(st.Session.ID)
	if len(evs) != 1 || evs[0].Result != ResultStopped || evs[0].Name != "Discord.exe" {
		t.Fatalf("events = %+v", evs)
	}
}

func TestLoopAllowedAndIgnoredProcessesAreUntouched(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	h.fp.add(210, 1, 5000, liveExe)
	h.fp.add(211, 210, 5001, blockedExe) // child of an allowed app
	h.fp.add(212, 1, 5002, `C:\Windows\System32\svchost.exe`)
	h.fp.add(213, 100, 5003, `C:\Tools\ffmpeg.exe`) // child of Toolbox
	other := h.fp.add(214, 1, 5004, `C:\Evil\x.exe`)
	h.fp.mu.Lock()
	for i := range h.fp.procs {
		if h.fp.procs[i].PID == other.PID {
			h.fp.procs[i].Session = 0 // another session
		}
	}
	h.fp.mu.Unlock()
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs())
	if evs := h.st.eventsFor(h.e.State().Session.ID); len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
}

func TestLoopBlockedParentsFastChildren(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	// a launcher and the children it spawned inside one tick
	h.fp.add(300, 1, 6000, `C:\Program Files\Launcher\launcher.exe`)
	h.fp.add(301, 300, 6010, `C:\Program Files\Launcher\game.exe`)
	h.fp.add(302, 301, 6020, `C:\Program Files\Launcher\helper.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs(), 300, 301, 302)
}

func TestLoopBlockedParentChildNextTickIsBlocked(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	h.fp.add(300, 1, 6000, `C:\Program Files\Launcher\launcher.exe`)
	h.fp.termErr[300] = errDenied // it can't be stopped
	h.e.tickNow()
	h.fp.add(301, 300, 6500, `C:\Program Files\Launcher\game.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs(), 300, 301)
}

func TestLoopFailedStopIsLoggedOnce(t *testing.T) {
	h := newHarness(t, false)
	s := h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	h.fp.termErr[400] = errDenied
	h.fp.termErr[401] = errDenied
	h.fp.add(400, 1, 7000, `C:\Program Files\Steam\steam.exe`)
	h.fp.add(401, 1, 7001, `C:\Program Files\Steam\steam.exe`)
	h.e.tickNow()
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs(), 400, 401)
	evs := h.st.eventsFor(s.ID)
	if len(evs) != 1 || evs[0].Result != ResultFailed || evs[0].Error != "It runs as administrator" {
		t.Fatalf("events = %+v", evs)
	}
	got, err := h.e.Blocked(10)
	if err != nil || len(got) != 1 || got[0].Result != ResultFailed {
		t.Fatalf("Blocked = %+v %v", got, err)
	}
}

func TestLoopExitedProcessNotCountedAsStopped(t *testing.T) {
	h := newHarness(t, false)
	s := h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	h.fp.add(410, 1, 7000, blockedExe)
	h.fp.termErr[410] = ErrGone
	h.e.tickNow()
	if evs := h.st.eventsFor(s.ID); len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
}

func TestLoopDryRunNeverStops(t *testing.T) {
	h := newHarness(t, true)
	s := h.begin(t, StrengthSoft, 30)
	if !s.DryRun || !h.e.State().DryRun {
		t.Fatal("session should be dry")
	}
	h.fp.add(500, 1, 100, blockedExe)
	h.fp.windows[500] = true
	h.e.tickNow() // initial pass with a windowed blocked app
	h.fp.add(501, 1, 6000, `C:\Program Files\Steam\steam.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs())
	eqPIDs(t, h.fp.askedPIDs())
	evs := h.st.eventsFor(s.ID)
	if len(evs) != 2 {
		t.Fatalf("events = %+v", evs)
	}
	for _, ev := range evs {
		if ev.Result != ResultWouldStop {
			t.Fatalf("event = %+v", ev)
		}
	}
	// no Force close in a dry run either
	if err := h.e.ForceClose(500, 100); err == nil {
		t.Fatal("nothing should be listed")
	}
}

func TestLoopTimeEnd(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 10)
	h.e.tickNow()
	h.clock.Advance(9 * time.Minute)
	h.e.tickNow()
	if h.e.State().Session == nil {
		t.Fatal("ended early")
	}
	h.clock.Advance(2 * time.Minute) // sleep past the end
	h.fp.add(600, 1, 8000, blockedExe)
	h.e.tickNow()
	st := h.e.State()
	if st.Session != nil || st.Last == nil || st.Last.EndReason != EndTime {
		t.Fatalf("state = %+v", st)
	}
	if st.Last.EndedAt != st.Last.EndsAt {
		t.Fatalf("EndedAt = %d, EndsAt = %d", st.Last.EndedAt, st.Last.EndsAt)
	}
	eqPIDs(t, h.fp.terminatedPIDs()) // ended before enforcing
}

func TestResumedEndsPastSession(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthFirm, 10)
	h.e.Resumed()
	if h.e.State().Session == nil {
		t.Fatal("ended early")
	}
	h.clock.Advance(time.Hour)
	h.e.Resumed()
	if st := h.e.State(); st.Session != nil || st.Last.EndReason != EndTime {
		t.Fatalf("state = %+v", st)
	}
}

func TestLoopTenFailedSnapshotsEndWithError(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthStrict, 30)
	h.e.tickNow()
	h.fp.snapErr = errors.New("boom")
	for i := 0; i < FailedTicksToEnd-1; i++ {
		h.e.tickNow()
	}
	if h.e.State().Session == nil {
		t.Fatal("ended after 9 failures")
	}
	h.e.tickNow()
	st := h.e.State()
	if st.Session != nil || st.Last == nil || st.Last.EndReason != EndError {
		t.Fatalf("state = %+v", st)
	}
}

func TestLoopSuccessResetsFailures(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	for round := 0; round < 3; round++ {
		h.fp.snapErr = errors.New("boom")
		for i := 0; i < FailedTicksToEnd-1; i++ {
			h.e.tickNow()
		}
		h.fp.snapErr = nil
		h.e.tickNow()
	}
	if h.e.State().Session == nil {
		t.Fatal("ended")
	}
}

func TestStartCloseAsksWindowedLeavesWindowless(t *testing.T) {
	h := newHarness(t, false)
	h.fp.add(10, 1, 100, liveExe)
	h.fp.add(11, 1, 101, `C:\Program Files\Discord\Discord.exe`) // windowed, closes
	h.fp.add(12, 1, 102, `C:\Program Files\Slack\slack.exe`)     // windowed, stays open
	h.fp.add(13, 1, 103, `C:\Program Files\Sync\syncclient.exe`) // windowless helper
	h.fp.add(14, 1, 104, `C:\Windows\explorer.exe`)              // system
	h.fp.windows[11], h.fp.windows[12] = true, true
	h.fp.staysOpen[12] = true
	h.begin(t, StrengthFirm, 30)
	h.e.tickNow()
	eqPIDs(t, h.fp.askedPIDs(), 11, 12)
	eqPIDs(t, h.fp.terminatedPIDs())
	if got := h.e.State().StillOpen; len(got) != 0 {
		t.Fatalf("listed too early: %+v", got)
	}
	h.clock.Advance(StillOpenAfter + time.Second)
	h.e.tickNow()
	still := h.e.State().StillOpen
	if len(still) != 1 || still[0].PID != 12 || still[0].Name != "slack.exe" {
		t.Fatalf("StillOpen = %+v", still)
	}
	// Close again asks, Force close terminates, Leave drops.
	if err := h.e.CloseAgain(12, 102); err != nil {
		t.Fatal(err)
	}
	eqPIDs(t, h.fp.askedPIDs(), 11, 12, 12)
	if err := h.e.ForceClose(12, 102); err != nil {
		t.Fatal(err)
	}
	eqPIDs(t, h.fp.terminatedPIDs(), 12)
	if got := h.e.State().StillOpen; len(got) != 0 {
		t.Fatalf("StillOpen = %+v", got)
	}
	wantCode(t, h.e.ForceClose(12, 102), core.CodeNotFound)
}

func TestStillOpenLeaveAndExit(t *testing.T) {
	h := newHarness(t, false)
	h.fp.add(21, 1, 101, `C:\Program Files\A\a.exe`)
	h.fp.add(22, 1, 102, `C:\Program Files\B\b.exe`)
	h.fp.windows[21], h.fp.windows[22] = true, true
	h.fp.staysOpen[21], h.fp.staysOpen[22] = true, true
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	h.clock.Advance(11 * time.Second)
	h.e.tickNow()
	if n := len(h.e.State().StillOpen); n != 2 {
		t.Fatalf("StillOpen = %d", n)
	}
	h.e.LeaveOpen(21, 101)
	h.fp.remove(22) // the user closed it
	h.e.tickNow()
	if n := len(h.e.State().StillOpen); n != 0 {
		t.Fatalf("StillOpen = %d", n)
	}
	eqPIDs(t, h.fp.terminatedPIDs())
}

func TestStartLeaveOnlyBlocksNewLaunches(t *testing.T) {
	h := newHarness(t, false)
	h.fp.add(31, 1, 100, blockedExe)
	h.fp.windows[31] = true
	if _, err := h.e.Begin(StartRequest{ProfileID: h.prof.ID, Minutes: 30, Strength: StrengthSoft, OnStart: OnStartLeave}); err != nil {
		t.Fatal(err)
	}
	h.e.tickNow()
	h.fp.add(32, 31, 6000, `C:\Program Files\Discord\child.exe`) // child of an existing blocked app
	h.fp.add(33, 1, 6001, `C:\Program Files\Steam\steam.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.askedPIDs())
	eqPIDs(t, h.fp.terminatedPIDs(), 32, 33)
}

// ---- sessions ----------------------------------------------------------------------

func TestBeginValidation(t *testing.T) {
	h := newHarness(t, false)
	ctx := context.Background()
	_ = ctx
	now := h.clock.Now().UnixMilli()
	cases := []struct {
		name string
		req  StartRequest
		code core.ErrorCode
	}{
		{"no time", StartRequest{ProfileID: h.prof.ID}, core.CodeValidation},
		{"too long", StartRequest{ProfileID: h.prof.ID, Minutes: 721}, CodeTooLong},
		{"until too far", StartRequest{ProfileID: h.prof.ID, Until: now + 13*3600*1000}, CodeTooLong},
		{"until too soon", StartRequest{ProfileID: h.prof.ID, Until: now + 30*1000}, core.CodeValidation},
		{"bad strength", StartRequest{ProfileID: h.prof.ID, Minutes: 5, Strength: "iron"}, core.CodeValidation},
		{"bad onStart", StartRequest{ProfileID: h.prof.ID, Minutes: 5, OnStart: "burn"}, core.CodeValidation},
		{"missing profile", StartRequest{ProfileID: "nope", Minutes: 5}, core.CodeNotFound},
		{"too broad extra", StartRequest{ProfileID: h.prof.ID, Minutes: 5, Extra: []AllowRule{{Label: "x", Kind: RuleFolder, Path: `C:\`}}}, core.CodeValidation},
	}
	for _, c := range cases {
		if _, err := h.e.Begin(c.req); !core.IsCode(err, c.code) {
			t.Errorf("%s: err = %v, want %s", c.name, err, c.code)
		}
	}
	if h.e.State().Session != nil {
		t.Fatal("a session started")
	}
	s, err := h.e.Begin(StartRequest{ProfileID: h.prof.ID, Until: now + 90*60*1000})
	if err != nil {
		t.Fatal(err)
	}
	if s.EndsAt != now+90*60*1000 || s.Strength != StrengthFirm || s.OnStart != OnStartClose || s.StartedAt != now {
		t.Fatalf("session = %+v", s)
	}
	_, err = h.e.Begin(StartRequest{ProfileID: h.prof.ID, Minutes: 5})
	wantCode(t, err, CodeActive)
	if st := h.e.Settings(); st.LastProfileID != h.prof.ID {
		t.Fatalf("settings = %+v", st)
	}
}

func TestExtendNeverShortens(t *testing.T) {
	h := newHarness(t, false)
	s := h.begin(t, StrengthSoft, 30)
	s2, err := h.e.Extend(15)
	if err != nil || s2.EndsAt != s.EndsAt+15*60000 {
		t.Fatalf("extend = %+v %v", s2, err)
	}
	earlier, err := h.e.ExtendTo(s.EndsAt - 1000)
	if err != nil || earlier.EndsAt != s2.EndsAt {
		t.Fatalf("ExtendTo earlier = %+v %v", earlier, err)
	}
	later, err := h.e.ExtendTo(s2.EndsAt + 60000)
	if err != nil || later.EndsAt != s2.EndsAt+60000 {
		t.Fatalf("ExtendTo later = %+v %v", later, err)
	}
	if _, err := h.e.Extend(0); err == nil {
		t.Fatal("Extend(0) accepted")
	}
	// capped at 12 h from the start
	capped, err := h.e.ExtendTo(s.StartedAt + 24*3600*1000)
	if err != nil || capped.EndsAt != s.StartedAt+720*60000 {
		t.Fatalf("cap = %+v %v", capped, err)
	}
	_, err = h.e.Extend(5)
	wantCode(t, err, CodeTooLong)
}

func TestNoSessionErrors(t *testing.T) {
	h := newHarness(t, false)
	_, err := h.e.Extend(5)
	wantCode(t, err, CodeNotActive)
	_, err = h.e.RequestWeaken(WeakenEnd, nil)
	wantCode(t, err, CodeNotActive)
	wantCode(t, h.e.ConfirmWeaken(WeakenEnd, ""), CodeNotActive)
	if err := h.e.EndFor("r1"); err != nil {
		t.Fatal(err)
	}
	h.e.NoteLaunch(`C:\x\y.exe`) // no-op
}

func TestWeakenSoft(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	f, err := h.e.RequestWeaken(WeakenEnd, nil)
	if err != nil || f.Phrase != "" || f.ReadyAt > h.clock.Now().UnixMilli() {
		t.Fatalf("friction = %+v %v", f, err)
	}
	if err := h.e.ConfirmWeaken(WeakenEnd, ""); err != nil {
		t.Fatal(err)
	}
	st := h.e.State()
	if st.Session != nil || st.Last.EndReason != EndUser || st.Friction != nil {
		t.Fatalf("state = %+v", st)
	}
}

func TestWeakenFirmPhraseAndCountdown(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthFirm, 30)
	f, err := h.e.RequestWeaken(WeakenEnd, nil)
	if err != nil || f.Phrase != Phrase {
		t.Fatalf("friction = %+v %v", f, err)
	}
	if f.ReadyAt != h.clock.Now().UnixMilli()+30000 {
		t.Fatalf("ReadyAt = %d", f.ReadyAt)
	}
	wantCode(t, h.e.ConfirmWeaken(WeakenEnd, Phrase), CodeCountdown)
	h.clock.Advance(20 * time.Second)
	// asking again keeps the countdown
	f2, _ := h.e.RequestWeaken(WeakenEnd, nil)
	if f2.ReadyAt != f.ReadyAt {
		t.Fatalf("countdown reset: %d vs %d", f2.ReadyAt, f.ReadyAt)
	}
	wantCode(t, h.e.ConfirmWeaken(WeakenEnd, Phrase), CodeCountdown)
	h.clock.Advance(11 * time.Second)
	wantCode(t, h.e.ConfirmWeaken(WeakenEnd, "i am stopping"), CodePhrase)
	if h.e.State().Session == nil {
		t.Fatal("ended on a wrong phrase")
	}
	// curly apostrophe, different case and spacing are fine
	if err := h.e.ConfirmWeaken(WeakenEnd, "  I\u2019m choosing  to STOP early "); err != nil {
		t.Fatal(err)
	}
	if st := h.e.State(); st.Session != nil || st.Last.EndReason != EndUser {
		t.Fatalf("state = %+v", st)
	}
}

func TestWeakenCancelAndMismatch(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthFirm, 30)
	_, _ = h.e.RequestWeaken(WeakenEnd, nil)
	wantCode(t, h.e.ConfirmWeaken(WeakenQuit, Phrase), core.CodeConflict)
	h.e.CancelWeaken()
	if h.e.State().Friction != nil {
		t.Fatal("friction survived Cancel")
	}
	wantCode(t, h.e.ConfirmWeaken(WeakenEnd, Phrase), core.CodeConflict)
}

func TestWeakenStrict(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthStrict, 60)
	for _, a := range []Weaken{WeakenEnd, WeakenQuit, WeakenAllow} {
		_, err := h.e.RequestWeaken(a, &AllowRule{Label: "x", Kind: RuleExe, Path: `C:\x.exe`})
		wantCode(t, err, core.CodeConflict)
	}
	f, err := h.e.RequestWeaken(WeakenEmergency, nil)
	if err != nil || f.Phrase != Phrase || f.ReadyAt != h.clock.Now().UnixMilli()+5*60000 {
		t.Fatalf("friction = %+v %v", f, err)
	}
	// the session keeps enforcing during the countdown
	h.e.tickNow()
	h.clock.Advance(4 * time.Minute)
	h.fp.add(700, 1, h.clock.Now().UnixMilli(), blockedExe)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs(), 700)
	wantCode(t, h.e.ConfirmWeaken(WeakenEmergency, Phrase), CodeCountdown)
	h.clock.Advance(61 * time.Second)
	if err := h.e.ConfirmWeaken(WeakenEmergency, Phrase); err != nil {
		t.Fatal(err)
	}
	if st := h.e.State(); st.Session != nil || st.Last.EndReason != EndEmergency {
		t.Fatalf("state = %+v", st)
	}
}

func TestWeakenAllowAddsRuleForNewProcesses(t *testing.T) {
	h := newHarness(t, false)
	s := h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	rule := AllowRule{Label: "Discord", Kind: RuleExe, Path: blockedExe, Children: true}
	if _, err := h.e.RequestWeaken(WeakenAllow, &AllowRule{Label: "Broad", Kind: RuleFolder, Path: `C:\`}); err == nil {
		t.Fatal("broad rule accepted")
	}
	if _, err := h.e.RequestWeaken(WeakenAllow, &rule); err != nil {
		t.Fatal(err)
	}
	if err := h.e.ConfirmWeaken(WeakenAllow, ""); err != nil {
		t.Fatal(err)
	}
	st := h.e.State()
	if len(st.Session.Extra) != 1 || st.Session.ID != s.ID || st.Session.Extra[0].ID == "" {
		t.Fatalf("session = %+v", st.Session)
	}
	h.fp.add(800, 1, 9000, blockedExe)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs())
}

func TestWeakenQuitRelease(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthFirm, 30)
	if h.e.State().QuitReleased {
		t.Fatal("released at start")
	}
	_, _ = h.e.RequestWeaken(WeakenQuit, nil)
	h.clock.Advance(31 * time.Second)
	if err := h.e.ConfirmWeaken(WeakenQuit, Phrase); err != nil {
		t.Fatal(err)
	}
	st := h.e.State()
	if !st.QuitReleased || st.Session == nil {
		t.Fatalf("state = %+v", st)
	}
}

func TestEndFor(t *testing.T) {
	h := newHarness(t, false)
	if _, err := h.e.Begin(StartRequest{ProfileID: h.prof.ID, Minutes: 30, Strength: StrengthFirm, RunID: "run1", StepID: "s"}); err != nil {
		t.Fatal(err)
	}
	wantCode(t, h.e.EndFor("run2"), CodeNotYours)
	wantCode(t, h.e.EndFor(""), CodeNotYours)
	if h.e.State().Session == nil {
		t.Fatal("ended by the wrong run")
	}
	if err := h.e.EndFor("run1"); err != nil {
		t.Fatal(err)
	}
	if st := h.e.State(); st.Session != nil || st.Last.EndReason != EndPipeline {
		t.Fatalf("state = %+v", st)
	}
	// a soft session by the user can be ended by any run
	h.begin(t, StrengthSoft, 30)
	if err := h.e.EndFor("other"); err != nil {
		t.Fatal(err)
	}
	if h.e.State().Session != nil {
		t.Fatal("soft session survived")
	}
	// strict sessions started by the run can end by it; nobody else can
	_, _ = h.e.Begin(StartRequest{ProfileID: h.prof.ID, Minutes: 30, Strength: StrengthStrict, RunID: "r9"})
	wantCode(t, h.e.EndFor("r8"), CodeNotYours)
	if err := h.e.EndFor("r9"); err != nil {
		t.Fatal(err)
	}
}

func TestSessionIsASnapshot(t *testing.T) {
	h := newHarness(t, false)
	if _, err := h.e.SaveSettings(func() Settings {
		s := h.e.Settings()
		s.AlwaysAllowed = []AllowRule{{Label: "Spotify", Kind: RuleExe, Path: `C:\Apps\Spotify\spotify.exe`, Children: true}}
		return s
	}()); err != nil {
		t.Fatal(err)
	}
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	// loosen: add an app to the profile and Always allowed; tighten: remove Live
	p := h.prof
	p.Rules = []AllowRule{{Label: "Discord", Kind: RuleExe, Path: blockedExe, Children: true}}
	if _, err := h.e.SaveProfile(p); err != nil {
		t.Fatal(err)
	}
	s := h.e.Settings()
	s.AlwaysAllowed = []AllowRule{{Label: "Steam", Kind: RuleExe, Path: `C:\Program Files\Steam\steam.exe`, Children: true}}
	if _, err := h.e.SaveSettings(s); err != nil {
		t.Fatal(err)
	}
	h.fp.add(900, 1, 9000, blockedExe)                         // newly allowed by the edit: still blocked
	h.fp.add(901, 1, 9001, `C:\Program Files\Steam\steam.exe`) // newly always-allowed: still blocked
	h.fp.add(902, 1, 9002, liveExe)                            // removed from the profile: still allowed
	h.fp.add(903, 1, 9003, `C:\Apps\Spotify\spotify.exe`)      // Always allowed at start: still allowed
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs(), 900, 901)
}

func TestNoteLaunchKeepsAppAllowed(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	h.e.NoteLaunch(`C:\Games\game.exe`)
	h.e.NoteLaunch(`c:\games\GAME.exe`) // same app
	st := h.e.State()
	if len(st.Session.Launched) != 1 || st.Session.Launched[0].Kind != RuleExe || !st.Session.Launched[0].Children {
		t.Fatalf("Launched = %+v", st.Session.Launched)
	}
	h.fp.add(950, 7777, 9500, `C:\Games\game.exe`) // parent is gone (Toolbox restarted)
	h.fp.add(951, 950, 9501, `C:\Games\helper.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs())
}

func TestResumeAfterRestart(t *testing.T) {
	h := newHarness(t, false)
	s := h.begin(t, StrengthFirm, 40)
	h.e.NoteLaunch(`C:\Games\game.exe`)
	h.e.Stop() // Toolbox quits; the session stays in the store
	h.clock.Advance(2 * time.Minute)

	// A new Toolbox process: the old one is gone and a blocked app is open.
	fp := newFake()
	fp.add(10, 1, 100, blockedExe)
	fp.windows[10] = true
	fp.add(12, 7777, 200, `C:\Games\game.exe`)
	e2 := New(Options{Platform: fp, Store: h.st, Clock: h.clock.Now})
	e2.manual = true
	t.Cleanup(e2.Stop)
	if err := e2.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := e2.State()
	if st.Session == nil || st.Session.ID != s.ID || len(st.Session.Launched) != 1 {
		t.Fatalf("resumed state = %+v", st)
	}
	e2.tickNow()
	// OnStart isn't re-applied: the open blocked app is left running
	eqPIDs(t, fp.askedPIDs())
	eqPIDs(t, fp.terminatedPIDs())
	// ...and doesn't confer
	fp.add(11, 10, 5000, `C:\Program Files\Discord\child.exe`)
	e2.tickNow()
	eqPIDs(t, fp.terminatedPIDs(), 11)
}

func TestSessionEndedWhileClosed(t *testing.T) {
	h := newHarness(t, false)
	s := h.begin(t, StrengthFirm, 10)
	h.e.Stop()
	h.clock.Advance(time.Hour)
	e2 := New(Options{Platform: newFake(), Store: h.st, Clock: h.clock.Now})
	e2.manual = true
	t.Cleanup(e2.Stop)
	if err := e2.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := e2.State()
	if st.Session != nil || st.Last == nil || st.Last.ID != s.ID || st.Last.EndReason != EndTime || st.Last.EndedAt != s.EndsAt {
		t.Fatalf("state = %+v", st)
	}
	if a, _ := h.st.ActiveSession(context.Background()); a != nil {
		t.Fatal("session still active in the store")
	}
}

func TestStartPrunesEvents(t *testing.T) {
	h := newHarness(t, false)
	if len(h.st.pruned) != 1 {
		t.Fatalf("pruned = %v", h.st.pruned)
	}
	want := h.clock.Now().UnixMilli() - 30*24*3600*1000
	if h.st.pruned[0] != [2]int64{want, EventsKeepRows} {
		t.Fatalf("pruned = %v, want %v", h.st.pruned[0], want)
	}
}

func TestSubscribeAndEmit(t *testing.T) {
	h := newHarness(t, false)
	var mu sync.Mutex
	var states []State
	unsub := h.e.Subscribe(func(s State) { mu.Lock(); states = append(states, s); mu.Unlock() })
	var emitted []string
	h.e.o.Emit = func(name string, payload any) { emitted = append(emitted, name) }
	h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	h.fp.add(1000, 1, 9000, blockedExe)
	h.e.tickNow()
	mu.Lock()
	n := len(states)
	mu.Unlock()
	if n < 2 || states[0].Session == nil {
		t.Fatalf("subscriber got %d states", n)
	}
	var sawBlocked, sawChanged bool
	for _, name := range emitted {
		sawBlocked = sawBlocked || name == EventBlocked
		sawChanged = sawChanged || name == EventChanged
	}
	if !sawBlocked || !sawChanged {
		t.Fatalf("emitted = %v", emitted)
	}
	unsub()
	h.e.CancelWeaken()
	_, _ = h.e.Extend(5)
	mu.Lock()
	after := len(states)
	mu.Unlock()
	if after != n {
		t.Fatalf("got states after unsubscribe: %d -> %d", n, after)
	}
}

// ---- learn mode ---------------------------------------------------------------------

func TestLearnMode(t *testing.T) {
	h := newHarness(t, false)
	s := h.e.Settings()
	s.AlwaysAllowed = []AllowRule{{Label: "Spotify", Kind: RuleExe, Path: `C:\Apps\Spotify\spotify.exe`, Children: true}}
	if _, err := h.e.SaveSettings(s); err != nil {
		t.Fatal(err)
	}
	h.fp.add(1, 0, 10, blockedExe) // open before: not recorded
	if err := h.e.SetLearn(true); err != nil {
		t.Fatal(err)
	}
	if !h.e.State().Learn {
		t.Fatal("learn off")
	}
	h.e.tickNow()
	h.clock.Advance(time.Second)
	h.fp.add(2, 0, 20, `C:\Program Files\Steam\steam.exe`)
	h.fp.add(3, 0, 21, `C:\Apps\Spotify\spotify.exe`)
	h.e.tickNow()
	h.fp.remove(2)
	h.fp.add(4, 0, 22, `C:\Program Files\Steam\steam.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs()) // learn never stops anything
	list, err := h.e.LearnList()
	if err != nil || len(list) != 1 || list[0].Path != `C:\Program Files\Steam\steam.exe` || list[0].Count != 2 {
		t.Fatalf("learn = %+v %v", list, err)
	}
	if err := h.e.IgnoreLearn(list[0].Path); err != nil {
		t.Fatal(err)
	}
	if list, _ = h.e.LearnList(); len(list) != 0 {
		t.Fatalf("learn after ignore = %+v", list)
	}

	// learn pauses during a session: the session's events are recorded instead
	sess := h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	h.fp.add(5, 0, 30, `C:\Program Files\Zoom\zoom.exe`)
	h.e.tickNow()
	eqPIDs(t, h.fp.terminatedPIDs(), 5)
	if list, _ = h.e.LearnList(); len(list) != 0 {
		t.Fatalf("learn recorded during a session: %+v", list)
	}
	if len(h.st.eventsFor(sess.ID)) != 1 {
		t.Fatalf("session events = %+v", h.st.eventsFor(sess.ID))
	}
	// ...and it resumes after the session
	if err := h.e.EndFor("x"); err != nil {
		t.Fatal(err)
	}
	h.e.tickNow() // the fresh learn watcher's first pass
	h.fp.add(6, 0, 40, `C:\Program Files\Zoom\zoom2.exe`)
	h.e.tickNow()
	h.e.tickNow()
	if list, _ = h.e.LearnList(); len(list) != 1 || list[0].Name != "zoom2.exe" {
		t.Fatalf("learn after session = %+v", list)
	}
	if err := h.e.SetLearn(false); err != nil {
		t.Fatal(err)
	}
	if h.e.State().Learn {
		t.Fatal("learn still on")
	}
}

// ---- profiles and settings ------------------------------------------------------------

func TestSaveProfile(t *testing.T) {
	h := newHarness(t, false)
	rule := AllowRule{Label: "A", Kind: RuleExe, Path: `C:\a.exe`, Children: true}
	_, err := h.e.SaveProfile(Profile{Name: "  ", Rules: []AllowRule{rule}})
	wantCode(t, err, CodeProfile)
	_, err = h.e.SaveProfile(Profile{Name: "Empty"})
	wantCode(t, err, CodeProfile)
	_, err = h.e.SaveProfile(Profile{Name: string(make([]rune, 0)) + "this profile name is far too long to be accepted ok", Rules: []AllowRule{rule}})
	wantCode(t, err, CodeProfile)
	_, err = h.e.SaveProfile(Profile{Name: "Bad", Rules: []AllowRule{rule, {Label: "Broad", Kind: RuleFolder, Path: `C:\Program Files`}}})
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeValidation {
		t.Fatalf("err = %v", err)
	} else if ae.Message != "Broad: That folder holds too many programs. Pick the app's own folder." {
		t.Fatalf("message = %q", ae.Message)
	}
	_, err = h.e.SaveProfile(Profile{Name: "music", Rules: []AllowRule{rule}}) // same as "Music" ignoring case
	wantCode(t, err, core.CodeValidation)

	p, err := h.e.SaveProfile(Profile{Name: "Writing", Rules: []AllowRule{rule}})
	if err != nil || p.ID == "" || p.Rules[0].ID == "" || p.CreatedAt == 0 {
		t.Fatalf("profile = %+v %v", p, err)
	}
	created := p.CreatedAt
	h.clock.Advance(time.Minute)
	p.Name = "Writing 2"
	p2, err := h.e.SaveProfile(p)
	if err != nil || p2.ID != p.ID || p2.CreatedAt != created || p2.UpdatedAt <= created {
		t.Fatalf("update = %+v %v", p2, err)
	}
	ps, _ := h.e.Profiles()
	if len(ps) != 2 {
		t.Fatalf("profiles = %+v", ps)
	}
	if err := h.e.DeleteProfile(p.ID); err != nil {
		t.Fatal(err)
	}
	if ps, _ = h.e.Profiles(); len(ps) != 1 {
		t.Fatalf("profiles = %+v", ps)
	}
}

func TestSaveSettingsNormalises(t *testing.T) {
	h := newHarness(t, false)
	got, err := h.e.SaveSettings(Settings{PollMs: 5, LastMinutes: 0, DefaultStrength: "x", OnStart: "y"})
	if err != nil {
		t.Fatal(err)
	}
	if got.PollMs != MinPollMs || got.LastMinutes != DefaultMinutes || got.DefaultStrength != StrengthFirm || got.OnStart != OnStartClose || got.AlwaysAllowed == nil {
		t.Fatalf("settings = %+v", got)
	}
	got, _ = h.e.SaveSettings(Settings{PollMs: 99999, DefaultStrength: StrengthStrict, OnStart: OnStartLeave, LastMinutes: 25})
	if got.PollMs != MaxPollMs || got.DefaultStrength != StrengthStrict || got.LastMinutes != 25 {
		t.Fatalf("settings = %+v", got)
	}
	if _, err := h.e.SaveSettings(Settings{AlwaysAllowed: []AllowRule{{Label: "x", Kind: RuleFolder, Path: `C:\Windows`}}}); err == nil {
		t.Fatal("broad Always allowed accepted")
	}
	// the stored copy loads on the next start
	e2 := New(Options{Platform: newFake(), Store: h.st, Clock: h.clock.Now})
	e2.manual = true
	if err := e2.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e2.Stop)
	if s := e2.Settings(); s.DefaultStrength != StrengthStrict || s.PollMs != MaxPollMs {
		t.Fatalf("loaded = %+v", s)
	}
}

func TestBlockedGroupsByProgram(t *testing.T) {
	h := newHarness(t, false)
	s := h.begin(t, StrengthSoft, 30)
	h.e.tickNow()
	for i, p := range []string{blockedExe, `C:\Program Files\Steam\steam.exe`, blockedExe} {
		h.clock.Advance(time.Second)
		h.fp.add(uint32(2000+i), 1, int64(9000+i), p)
		h.e.tickNow()
	}
	got, err := h.e.Blocked(10)
	if err != nil || len(got) != 2 || got[0].Path != blockedExe || got[0].Count != 2 || got[1].Count != 1 {
		t.Fatalf("Blocked = %+v %v", got, err)
	}
	if got, _ = h.e.Blocked(1); len(got) != 1 {
		t.Fatalf("limit: %+v", got)
	}
	if err := h.e.EndFor("x"); err != nil {
		t.Fatal(err)
	}
	if got, _ = h.e.Blocked(10); len(got) != 2 { // the last session's
		t.Fatalf("after end: %+v", got)
	}
	rec, _ := h.e.Recent(5)
	if len(rec) != 1 || rec[0].ID != s.ID || rec[0].Blocked != 3 {
		t.Fatalf("recent = %+v", rec)
	}
}

func TestUnsupportedPlatform(t *testing.T) {
	fp := newFake()
	fp.unsupported = core.Errorf(CodeUnsupported, "Focus Lock works on Windows and macOS")
	e := New(Options{Platform: fp, Store: newMemStore()})
	e.manual = true
	if err := e.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer e.Stop()
	st := e.State()
	if st.Supported || st.Unsupported == "" {
		t.Fatalf("state = %+v", st)
	}
	_, err := e.Begin(StartRequest{ProfileID: "x", Minutes: 5})
	wantCode(t, err, CodeUnsupported)
	wantCode(t, e.SetLearn(true), CodeUnsupported)
}

// ---- the real loop (goroutines, kicks, no leaks) -----------------------------------------

func TestRealLoopKickAndStop(t *testing.T) {
	before := runtime.NumGoroutine()
	fp := newFake()
	st := newMemStore()
	e := New(Options{Platform: fp, Store: st})
	if err := e.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	p, err := e.SaveProfile(Profile{Name: "P", Rules: []AllowRule{{Label: "Live", Kind: RuleExe, Path: liveExe, Children: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Begin(StartRequest{ProfileID: p.ID, Minutes: 5, Strength: StrengthSoft}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { fp.mu.Lock(); defer fp.mu.Unlock(); return len(fp.pathCalls) > 0 }) // first tick ran
	// The poll interval is 1 s: only a kick can make this fast.
	fp.add(77, 1, time.Now().UnixMilli(), blockedExe)
	fp.kicks <- struct{}{}
	start := time.Now()
	waitFor(t, func() bool { return len(fp.terminatedPIDs()) == 1 })
	if d := time.Since(start); d > 600*time.Millisecond {
		t.Fatalf("kick took %v", d)
	}
	// a new launch without a kick is caught by the poll
	fp.add(78, 1, time.Now().UnixMilli(), blockedExe)
	waitFor(t, func() bool { return len(fp.terminatedPIDs()) == 2 })
	e.Stop()
	waitFor(t, func() bool { runtime.GC(); return runtime.NumGoroutine() <= before+1 })
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestSafeToStopGuards(t *testing.T) {
	h := newHarness(t, false)
	h.begin(t, StrengthSoft, 30)
	h.e.mu.Lock()
	defer h.e.mu.Unlock()
	w := h.e.w
	ok := func(p ProcInfo) bool { return h.e.safeToStopLocked(p, w) }
	if !ok(ProcInfo{PID: 5, Session: 1, Path: blockedExe}) {
		t.Fatal("ordinary blocked app should be stoppable")
	}
	if ok(ProcInfo{PID: 100, Session: 1, Path: blockedExe}) {
		t.Fatal("Toolbox itself")
	}
	if ok(ProcInfo{PID: 5, Session: 2, Path: blockedExe}) {
		t.Fatal("another session")
	}
	if ok(ProcInfo{PID: 5, Session: 1, Path: `C:\Windows\System32\x.exe`}) {
		t.Fatal("system folder")
	}
	if ok(ProcInfo{PID: 5, Session: 1, Path: `C:\Program Files\Windows Defender\x.exe`}) {
		t.Fatal("windows extras")
	}
	if ok(ProcInfo{PID: 0, Session: 1}) {
		t.Fatal("pid 0")
	}
	w.toolbox[9] = 1
	if ok(ProcInfo{PID: 9, Created: 1, Session: 1, Path: blockedExe}) {
		t.Fatal("toolbox descendant")
	}
	h.e.session.DryRun = true
	if ok(ProcInfo{PID: 5, Session: 1, Path: blockedExe}) {
		t.Fatal("dry run")
	}
}
