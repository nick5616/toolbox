package focus

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// A slow polite close must not delay deciding a new launch.
func TestSlowCloseDoesNotStallTheLoop(t *testing.T) {
	h := newHarness(t, false)
	h.fp.add(11, 1, 101, `C:\Program Files\Discord\Discord.exe`)
	h.fp.windows[11] = true
	h.fp.askGate = make(chan struct{})
	h.begin(t, StrengthFirm, 30)

	h.e.mu.Lock()
	w := h.e.w
	h.e.mu.Unlock()
	done := make(chan struct{})
	go func() {
		h.e.tick(context.Background(), w) // first pass: asks Discord to close (blocks in the platform)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the tick waited for the slow close")
	}
	// a new blocked launch is decided and stopped while the close is still pending
	h.fp.add(200, 1, 5000, blockedExe)
	h.e.tick(context.Background(), w)
	eqPIDs(t, h.fp.terminatedPIDs(), 200)

	close(h.fp.askGate)
	h.e.asks.Wait()
	eqPIDs(t, h.fp.askedPIDs(), 11)
	evs := h.st.eventsFor(h.e.State().Session.ID)
	closed := 0
	for _, ev := range evs {
		if ev.Result == ResultClosed {
			closed++
		}
	}
	if closed != 1 {
		t.Fatalf("events = %+v", evs)
	}
}

func TestStopWaitsForAsks(t *testing.T) {
	h := newHarness(t, false)
	h.fp.add(11, 1, 101, `C:\Program Files\Discord\Discord.exe`)
	h.fp.windows[11] = true
	h.fp.askGate = make(chan struct{})
	h.begin(t, StrengthFirm, 30)
	h.e.mu.Lock()
	w := h.e.w
	h.e.mu.Unlock()
	h.e.tick(context.Background(), w)
	for i := 0; i < 400 && len(h.fp.askedPIDs()) == 0; i++ {
		time.Sleep(5 * time.Millisecond) // wait until the platform is mid-close
	}
	stopped := make(chan struct{})
	go func() { h.e.Stop(); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("Stop returned with a close still running")
	case <-time.After(100 * time.Millisecond):
	}
	close(h.fp.askGate)
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop never returned")
	}
}

func TestBundleHelpers(t *testing.T) {
	cases := []struct {
		path, bundle string
		main         bool
	}{
		{"/Applications/Foo.app/Contents/MacOS/Foo", "/Applications/Foo.app", true},
		{"/Applications/Foo.app/Contents/Frameworks/Foo Helper.app/Contents/MacOS/Foo Helper", "/Applications/Foo.app", false},
		{"/Applications/Foo.app/Contents/MacOS/sub/tool", "/Applications/Foo.app", false},
		{"/usr/bin/ssh", "", false},
		{"/Applications/Foo.app", "/Applications/Foo.app", false},
		{"/Applications/Foo.application/x", "", false},
	}
	for _, c := range cases {
		if got := bundleOf(c.path); got != c.bundle {
			t.Errorf("bundleOf(%q) = %q, want %q", c.path, got, c.bundle)
		}
		if got := isBundleMain(c.path); got != c.main {
			t.Errorf("isBundleMain(%q) = %v, want %v", c.path, got, c.main)
		}
	}
}

func TestQuitErrorWording(t *testing.T) {
	to := quitError("/Applications/Foo.app", fmt.Errorf("osascript timed out: %w", context.DeadlineExceeded))
	if to.Error() != "Foo.app didn't answer within 30 seconds" {
		t.Fatalf("timeout = %q", to)
	}
	refused := quitError("/Applications/Foo.app", errors.New("exit status 1"))
	if refused.Error() != "Toolbox isn't allowed to quit Foo.app: exit status 1" {
		t.Fatalf("refused = %q", refused)
	}
}

func TestQuitFlightSharesOneRequest(t *testing.T) {
	f := newQuitFlight()
	now := time.Unix(1000, 0)
	f.now = func() time.Time { return now }
	calls := 0
	gate := make(chan struct{})
	fn := func() error { calls++; <-gate; return nil }
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		go func() { errs <- f.do("/A.app", fn) }()
	}
	time.Sleep(50 * time.Millisecond)
	close(gate)
	for i := 0; i < 3; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("quit requested %d times", calls)
	}
	// a later request after the keep window runs again
	now = now.Add(time.Minute)
	_ = f.do("/A.app", func() error { calls++; return nil })
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
}
