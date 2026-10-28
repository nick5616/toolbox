package paste

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

// fakePlatform records calls; it never touches the OS.
type fakePlatform struct {
	log       []string
	fg        Target
	own       bool
	alive     bool
	perm      string
	heldPolls int // ModifiersHeld reports true this many times (-1 = forever)
	actErr    error
}

func newFake() *fakePlatform { return &fakePlatform{fg: 42, alive: true, perm: Granted} }

func (f *fakePlatform) Foreground() (Target, bool) { return f.fg, f.own }
func (f *fakePlatform) Alive(Target) bool          { f.log = append(f.log, "alive"); return f.alive }
func (f *fakePlatform) Activate(Target) error      { f.log = append(f.log, "activate"); return f.actErr }
func (f *fakePlatform) ModifiersHeld() bool {
	f.log = append(f.log, "mods")
	if f.heldPolls == 0 {
		return false
	}
	if f.heldPolls > 0 {
		f.heldPolls--
	}
	return true
}
func (f *fakePlatform) SendPaste() error         { f.log = append(f.log, "chord"); return nil }
func (f *fakePlatform) Permission() string       { return f.perm }
func (f *fakePlatform) RequestPermission() error { f.log = append(f.log, "request"); return nil }

func newOrch(f *fakePlatform) (*Orchestrator, *[]time.Duration) {
	var sleeps []time.Duration
	o := NewOrchestrator(f)
	o.Sleep = func(_ context.Context, d time.Duration) error {
		sleeps = append(sleeps, d)
		f.log = append(f.log, "sleep")
		return nil
	}
	return o, &sleeps
}

func count(log []string, s string) int {
	n := 0
	for _, l := range log {
		if l == s {
			n++
		}
	}
	return n
}

func TestPasteSequence(t *testing.T) {
	f := newFake()
	f.heldPolls = 2
	o, sleeps := newOrch(f)
	o.Remember()
	if err := o.Paste(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"alive", "activate", "mods", "sleep", "mods", "sleep", "mods", "sleep", "chord"}
	if !reflect.DeepEqual(f.log, want) {
		t.Fatalf("log = %v, want %v", f.log, want)
	}
	if want := []time.Duration{15 * time.Millisecond, 15 * time.Millisecond, 60 * time.Millisecond}; !reflect.DeepEqual(*sleeps, want) {
		t.Fatalf("sleeps = %v", *sleeps)
	}
}

func TestPasteOnlyOncePerRemember(t *testing.T) {
	f := newFake()
	o, _ := newOrch(f)
	o.Remember()
	if err := o.Paste(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := o.Paste(context.Background()); !errors.Is(err, ErrNothingStored) {
		t.Fatalf("second paste err = %v", err)
	}
	if count(f.log, "chord") != 1 {
		t.Fatalf("chords = %d", count(f.log, "chord"))
	}
}

func TestPasteSkips(t *testing.T) {
	tests := []struct {
		name  string
		setup func(f *fakePlatform) bool // returns whether to Remember
		want  error
	}{
		{"nothing remembered", func(f *fakePlatform) bool { return false }, ErrNothingStored},
		{"own window", func(f *fakePlatform) bool { f.own = true; return true }, ErrNothingStored},
		{"no foreground", func(f *fakePlatform) bool { f.fg = 0; return true }, ErrNothingStored},
		{"target gone", func(f *fakePlatform) bool { f.alive = false; return true }, ErrTargetGone},
		{"permission denied", func(f *fakePlatform) bool { f.perm = Denied; return true }, ErrNoPermission},
		{"unsupported", func(f *fakePlatform) bool { f.perm = Unsupported; return true }, ErrUnsupported},
		{"modifiers never released", func(f *fakePlatform) bool { f.heldPolls = -1; return true }, ErrModifiersHeld},
		{"activate fails", func(f *fakePlatform) bool { f.actErr = errors.New("x"); return true }, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake()
			remember := tc.setup(f)
			o, _ := newOrch(f)
			if remember {
				o.Remember()
			}
			err := o.Paste(context.Background())
			if tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if err == nil {
				t.Fatal("expected an error")
			}
			if count(f.log, "chord") != 0 {
				t.Fatalf("chord sent: %v", f.log)
			}
		})
	}
}

func TestModifierWaitIsBounded(t *testing.T) {
	f := newFake()
	f.heldPolls = -1
	o, sleeps := newOrch(f)
	o.Remember()
	_ = o.Paste(context.Background())
	var total time.Duration
	for _, d := range *sleeps {
		total += d
	}
	if total < time.Second || total >= time.Second+DefaultPollEvery {
		t.Fatalf("waited %v, want about 1s", total)
	}
}

func TestRememberIgnoresOwnWindowAndClearsStale(t *testing.T) {
	f := newFake()
	o, _ := newOrch(f)
	o.Remember() // a real target
	f.own = true
	o.Remember() // our own window: must drop the stale target
	if err := o.Paste(context.Background()); !errors.Is(err, ErrNothingStored) {
		t.Fatalf("err = %v", err)
	}
}

func TestCancelledContextSendsNothing(t *testing.T) {
	f := newFake()
	o := NewOrchestrator(f) // real sleep
	o.Remember()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := o.Paste(ctx); err == nil {
		t.Fatal("expected error")
	}
	if count(f.log, "chord") != 0 {
		t.Fatal("chord sent")
	}
}
