//go:build windows

package proc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// launchChild launches this test binary as the helper in the given mode and
// kills it by PID when the test ends. It is the only thing these tests start.
func launchChild(t *testing.T, mode string, extra ...string) (Launched, error) {
	t.Helper()
	t.Setenv("PROC_HELPER", mode)
	l, err := Launch(context.Background(), LaunchSpec{
		Path: os.Args[0], Args: append([]string{"-test.run=^TestHelperProcess$"}, extra...), Minimized: true,
	})
	if l.PID != 0 {
		t.Cleanup(func() {
			if p, perr := os.FindProcess(int(l.PID)); perr == nil {
				_ = p.Kill()
			}
		})
	}
	return l, err
}

func TestLaunchRunsDetached(t *testing.T) {
	l, err := launchChild(t, "sleep")
	if err != nil {
		t.Fatal(err)
	}
	if l.PID == 0 {
		t.Fatal("no PID")
	}
	if age := time.Since(time.UnixMilli(l.Created)); l.Created == 0 || age < 0 || age > time.Minute {
		t.Errorf("creation time %d (age %v)", l.Created, age)
	}
	// Still running after Launch returned (it isn't tied to a context).
	p, _ := os.FindProcess(int(l.PID))
	if p == nil {
		t.Fatal("process gone")
	}
}

func TestLaunchCancelledContextDoesNotKill(t *testing.T) {
	t.Setenv("PROC_HELPER", "sleep")
	ctx, cancel := context.WithCancel(context.Background())
	l, err := Launch(ctx, LaunchSpec{Path: os.Args[0], Args: []string{"-test.run=^TestHelperProcess$"}, Minimized: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if p, e := os.FindProcess(int(l.PID)); e == nil {
			_ = p.Kill()
		}
	})
	cancel()
	time.Sleep(200 * time.Millisecond)
	if !alive(int(l.PID)) {
		t.Error("the launched program died when the context ended")
	}
}

func TestLaunchEarlyFailure(t *testing.T) {
	_, err := launchChild(t, "exit3")
	var ee *ExitedEarlyError
	if !errors.As(err, &ee) || ee.Code != 3 {
		t.Fatalf("got %v, want ExitedEarlyError{3}", err)
	}
}

func TestLaunchEarlyExitZeroIsSuccess(t *testing.T) {
	// "lines" prints and exits 0: a hand-off, not a failure.
	if _, err := launchChild(t, "lines"); err != nil {
		t.Fatal(err)
	}
}

func TestLaunchMissing(t *testing.T) {
	_, err := Launch(context.Background(), LaunchSpec{Path: filepath.Join(t.TempDir(), "nope.exe")})
	if err == nil {
		t.Fatal("want an error")
	}
	var ee *ExitedEarlyError
	if errors.As(err, &ee) {
		t.Error("a missing program isn't an early exit")
	}
}
