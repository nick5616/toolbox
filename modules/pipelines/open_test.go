package pipelines

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/focus"
	"toolbox/core/proc"
)

// fakeLaunch records launches instead of starting programs.
type fakeLaunch struct {
	mu    sync.Mutex
	specs []proc.LaunchSpec
	err   error
}

func (f *fakeLaunch) launch(ctx context.Context, s proc.LaunchSpec) (proc.Launched, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.specs = append(f.specs, s)
	if f.err != nil {
		return proc.Launched{}, f.err
	}
	return proc.Launched{PID: uint32(1000 + len(f.specs)), Created: 5000 + int64(len(f.specs))}, nil
}

type closeCall struct {
	pid     uint32
	created int64
	path    string
}

// openFixture swaps the seams and wires a fake focus engine into the module.
type openFixture struct {
	*harness
	launches *fakeLaunch
	closes   chan closeCall
	noted    []string
	mu       sync.Mutex
	fn       func(focus.State)
	unsubbed int
}

func newOpenFixture(t *testing.T) *openFixture {
	t.Helper()
	f := &openFixture{harness: newHarness(t, nil), launches: &fakeLaunch{}, closes: make(chan closeCall, 10)}
	oldL, oldC := launchApp, askToClose
	launchApp = f.launches.launch
	askToClose = func(pid uint32, created int64, path string) error {
		f.closes <- closeCall{pid, created, path}
		return nil
	}
	t.Cleanup(func() { launchApp, askToClose = oldL, oldC; f.m.CloseOpened() })
	f.m.launcher = Launcher{
		NoteLaunch: func(p string) { f.mu.Lock(); f.noted = append(f.noted, p); f.mu.Unlock() },
		Subscribe: func(fn func(focus.State)) func() {
			f.mu.Lock()
			f.fn = fn
			f.mu.Unlock()
			return func() { f.mu.Lock(); f.unsubbed++; f.fn = nil; f.mu.Unlock() }
		},
	}
	return f
}

func (f *openFixture) send(st focus.State) {
	f.mu.Lock()
	fn := f.fn
	f.mu.Unlock()
	if fn != nil {
		fn(st)
	}
}

func (f *openFixture) subscribed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fn != nil
}

func (f *openFixture) step() *openStep { return &openStep{m: f.m} }

func appPath(t *testing.T) string {
	return writeFile(t, filepath.Join(t.TempDir(), "Live 12.exe"), "x")
}

func (f *openFixture) prepare(t *testing.T, s OpenStep, files ...string) []core.StepJob {
	t.Helper()
	rf := make([]core.RunFile, len(files))
	for i, p := range files {
		rf[i] = core.RunFile{Path: p, Name: filepath.Base(p)}
	}
	jobs, err := f.step().PrepareStep(context.Background(), core.StepRequest{
		RunID: "run1", Pipeline: "P", Options: mustJSON(t, s),
		Item: core.StepItem{Files: rf, Vars: map[string]string{"song": "Blue"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return jobs
}

func TestOpenDescribe(t *testing.T) {
	f := newOpenFixture(t)
	app := appPath(t)
	for _, tc := range []struct {
		name string
		step OpenStep
		want string // "" = fine
	}{
		{"no app", DefaultOpen(), "Pick an app"},
		{"relative", OpenStep{App: "live.exe", Files: OpenFilesNone, Window: OpenWindowNormal, CloseWhen: CloseNever}, "full path"},
		{"too many args", OpenStep{App: app, Args: make([]string, 21), Files: OpenFilesNone, Window: OpenWindowNormal, CloseWhen: CloseNever}, "at most 20"},
		{"bad files", OpenStep{App: app, Files: "some", Window: OpenWindowNormal, CloseWhen: CloseNever}, "files setting"},
		{"bad close", OpenStep{App: app, Files: OpenFilesNone, Window: OpenWindowNormal, CloseWhen: "later"}, "close setting"},
		{"ok", OpenStep{App: app, Label: "Ableton Live 12", Files: OpenFilesNone, Window: OpenWindowNormal, CloseWhen: CloseFocusEnds}, ""},
	} {
		info, err := f.step().DescribeStep(mustJSON(t, tc.step))
		if tc.want == "" {
			if err != nil {
				t.Errorf("%s: %v", tc.name, err)
			} else if !strings.Contains(info.Summary, "Ableton Live 12") || !strings.Contains(info.Summary, "focus ends") || !info.NoFiles {
				t.Errorf("%s: info %+v", tc.name, info)
			}
			continue
		}
		if err == nil || !strings.Contains(core.AsAppError(err).Message, tc.want) {
			t.Errorf("%s: got %v want %q", tc.name, err, tc.want)
		}
	}
}

func TestOpenTemplatesNeverIncludeApp(t *testing.T) {
	f := newOpenFixture(t)
	info, err := f.step().DescribeStep(mustJSON(t, OpenStep{
		App: appPath(t), Args: []string{"--song={song}", filesArg, "{file}"}, Files: OpenFilesEach, Window: OpenWindowNormal, CloseWhen: CloseNever,
	}))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range info.Templates {
		if !strings.HasPrefix(p, "/args/") {
			t.Errorf("template %q isn't an argument", p)
		}
	}
	if !slices.Equal(info.Templates, []string{"/args/0"}) {
		t.Errorf("templates = %v (file variables exist only here, so they're not checked against earlier steps)", info.Templates)
	}
}

func TestOpenPrepareEachVsAll(t *testing.T) {
	f := newOpenFixture(t)
	app := appPath(t)
	a, b := filepath.Join(t.TempDir(), "a.als"), filepath.Join(t.TempDir(), "b.als")
	args := []string{"--song={song}", "--name={name}.{ext}", "--one={file}", filesArg}

	each := f.prepare(t, OpenStep{App: app, Args: args, Files: OpenFilesEach, Window: OpenWindowMinimized, CloseWhen: CloseRunEnds}, a, b)
	if len(each) != 2 {
		t.Fatalf("each: %d jobs", len(each))
	}
	o := jobOptions(t, each[1]).Open
	want := []string{"--song=Blue", "--name=b.als", "--one=" + b, b}
	if !slices.Equal(o.Args, want) || o.Window != OpenWindowMinimized || o.CloseWhen != CloseRunEnds || o.RunID != "run1" || o.App != app || o.Label != "Live 12" {
		t.Fatalf("each job = %+v", o)
	}
	if !slices.Equal(each[0].Inputs, []string{a}) {
		t.Errorf("each inputs = %v", each[0].Inputs)
	}

	all := f.prepare(t, OpenStep{App: app, Args: []string{filesArg, "--n={song}"}, Files: OpenFilesAll, Window: OpenWindowNormal, CloseWhen: CloseNever}, a, b)
	if len(all) != 1 {
		t.Fatalf("all: %d jobs", len(all))
	}
	if got := jobOptions(t, all[0]).Open.Args; !slices.Equal(got, []string{a, b, "--n=Blue"}) {
		t.Errorf("all args = %v", got)
	}
	if !slices.Equal(all[0].Inputs, []string{a, b}) {
		t.Errorf("all inputs = %v", all[0].Inputs)
	}

	none := f.prepare(t, OpenStep{App: app, Args: []string{filesArg, "x"}, Files: OpenFilesNone, Window: OpenWindowNormal, CloseWhen: CloseNever}, a)
	if len(none) != 1 || !slices.Equal(jobOptions(t, none[0]).Open.Args, []string{"x"}) || !slices.Equal(none[0].Inputs, []string{a}) {
		t.Errorf("none = %+v", none)
	}

	if _, err := f.step().PrepareStep(context.Background(), core.StepRequest{
		Options: mustJSON(t, OpenStep{App: app, Files: OpenFilesEach, Window: OpenWindowNormal, CloseWhen: CloseNever}),
	}); err == nil {
		t.Error("each with no files should say so")
	}
}

func TestOpenAppIsNeverExpanded(t *testing.T) {
	f := newOpenFixture(t)
	app := writeFile(t, filepath.Join(t.TempDir(), "{song}.exe"), "x")
	jobs := f.prepare(t, OpenStep{App: app, Label: "{song}", Files: OpenFilesNone, Window: OpenWindowNormal, CloseWhen: CloseNever})
	if got := jobOptions(t, jobs[0]).Open.App; got != app {
		t.Errorf("app = %q, want it untouched", got)
	}
}

func openOptions(app string, closeWhen string, runID string) Options {
	return Options{Action: ActionOpen, Pipeline: "P", Open: &OpenJob{
		App: app, Label: "Live", Args: []string{"-x"}, Window: OpenWindowMinimized, CloseWhen: closeWhen, RunID: runID,
	}}
}

func TestOpenRunLaunchesAndNotes(t *testing.T) {
	f := newOpenFixture(t)
	app := appPath(t)
	rec, err := f.run(openOptions(app, CloseNever, "r"))
	if err != nil {
		t.Fatal(err)
	}
	if len(f.launches.specs) != 1 {
		t.Fatalf("launches = %v", f.launches.specs)
	}
	s := f.launches.specs[0]
	if s.Path != app || !s.Minimized || !slices.Equal(s.Args, []string{"-x"}) {
		t.Errorf("spec = %+v", s)
	}
	if !slices.Equal(f.noted, []string{app}) {
		t.Errorf("NoteLaunch = %v", f.noted)
	}
	if len(rec.files(t)) != 0 {
		t.Errorf("files = %v", rec.files(t))
	}
	if f.subscribed() {
		t.Error("closeWhen never must not subscribe")
	}
}

func TestOpenRunFailureIsLaunchFailed(t *testing.T) {
	for _, cause := range []error{&proc.ExitedEarlyError{Code: 1}, errors.New("no such file")} {
		f := newOpenFixture(t)
		f.launches.err = cause
		_, err := f.run(openOptions("/x/Live.exe", CloseNever, "r"))
		ae := core.AsAppError(err)
		if ae == nil || string(ae.Code) != CodeLaunchFailed || ae.Message != "Couldn't open Live" || !strings.Contains(ae.Hint, "pick it again") {
			t.Errorf("err = %#v", ae)
		}
		if len(f.noted) != 0 {
			t.Error("a failed launch must not be noted")
		}
	}
}

func TestOpenValidate(t *testing.T) {
	f := newOpenFixture(t)
	if _, err := f.run(Options{Action: ActionOpen, Pipeline: "P"}); err == nil {
		t.Error("no open settings should fail")
	}
	if _, err := f.run(Options{Action: ActionOpen, Open: &OpenJob{CloseWhen: CloseNever}}); err == nil {
		t.Error("no app should fail")
	}
}

func TestOpenPassesFilesThrough(t *testing.T) {
	f := newOpenFixture(t)
	in := filepath.Join(t.TempDir(), "a.als")
	rec, err := f.run(openOptions(appPath(t), CloseNever, "r"))
	if err != nil {
		t.Fatal(err)
	}
	// harness jobs have no inputs; StepOutputs must hand back what the job recorded.
	res, err := f.step().StepOutputs(core.Job{ResultJSON: string(rec.result)})
	if err != nil || len(res.Files) != 0 {
		t.Fatalf("outputs = %+v, %v", res, err)
	}
	res, err = f.step().StepOutputs(core.Job{ResultJSON: `{"files":[{"path":` + string(mustJSON(t, in)) + `,"name":"a.als"}]}`})
	if err != nil || len(res.Files) != 1 || res.Files[0].Path != in {
		t.Fatalf("outputs = %+v, %v", res, err)
	}
}

func waitClose(t *testing.T, f *openFixture) closeCall {
	t.Helper()
	select {
	case c := <-f.closes:
		return c
	case <-time.After(2 * time.Second):
		t.Fatal("no close request")
		return closeCall{}
	}
}

func noClose(t *testing.T, f *openFixture) {
	t.Helper()
	select {
	case c := <-f.closes:
		t.Fatalf("unexpected close %+v", c)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestOpenClosesPolitelyWhenFocusEnds(t *testing.T) {
	f := newOpenFixture(t)
	app := appPath(t)
	if _, err := f.run(openOptions(app, CloseFocusEnds, "r")); err != nil {
		t.Fatal(err)
	}
	if !f.subscribed() {
		t.Fatal("focusEnds should follow the focus state")
	}
	f.send(focus.State{Session: &focus.Session{ID: "s1"}})
	noClose(t, f)
	f.send(focus.State{})
	c := waitClose(t, f)
	if c.pid != 1001 || c.created != 5001 || c.path != app {
		t.Errorf("close = %+v", c)
	}
	// Remembered once, then forgotten, and the subscription is dropped.
	deadline := time.Now().Add(2 * time.Second)
	for f.subscribed() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if f.subscribed() {
		t.Error("still subscribed after the last app closed")
	}
	f.send(focus.State{})
	noClose(t, f)
}

func TestOpenFocusEndsWaitsForASession(t *testing.T) {
	// Idle was seen and no session since: an idle state must not close an app
	// launched before the session began.
	f := newOpenFixture(t)
	f.m.openTracker().active = -1
	if _, err := f.run(openOptions(appPath(t), CloseFocusEnds, "r")); err != nil {
		t.Fatal(err)
	}
	f.send(focus.State{})
	noClose(t, f)
	f.send(focus.State{Session: &focus.Session{ID: "s"}})
	f.send(focus.State{})
	waitClose(t, f)
}

func TestOpenFocusEndsUsesCurrentState(t *testing.T) {
	// Launcher.Current says idle at launch: the first idle event must not close
	// the app (no session has run since it opened).
	f := newOpenFixture(t)
	f.m.launcher.Current = func() focus.State { return focus.State{} }
	if _, err := f.run(openOptions(appPath(t), CloseFocusEnds, "r")); err != nil {
		t.Fatal(err)
	}
	f.send(focus.State{})
	noClose(t, f)
	f.send(focus.State{Session: &focus.Session{ID: "s"}})
	f.send(focus.State{})
	waitClose(t, f)
}

func TestOpenNeverClosesWithoutRequest(t *testing.T) {
	f := newOpenFixture(t)
	if _, err := f.run(openOptions(appPath(t), CloseNever, "r")); err != nil {
		t.Fatal(err)
	}
	f.send(focus.State{})
	noClose(t, f)
}

func TestOpenClosesWhenRunEnds(t *testing.T) {
	f := newOpenFixture(t)
	app := appPath(t)
	tr := f.m.openTracker()
	if _, err := f.run(openOptions(app, CloseRunEnds, "runA")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.run(openOptions(app, CloseRunEnds, "runB")); err != nil {
		t.Fatal(err)
	}
	tr.onRunFinished("runA")
	c := waitClose(t, f)
	if c.pid != 1001 {
		t.Errorf("closed %+v, want the first launch", c)
	}
	noClose(t, f)
	tr.onRunFinished("runA") // already closed
	noClose(t, f)
	tr.onRunFinished("runB")
	if c := waitClose(t, f); c.pid != 1002 {
		t.Errorf("closed %+v", c)
	}
}

func TestOpenCloseOpenedStopsFollowing(t *testing.T) {
	f := newOpenFixture(t)
	if _, err := f.run(openOptions(appPath(t), CloseFocusEnds, "r")); err != nil {
		t.Fatal(err)
	}
	f.m.CloseOpened()
	if f.subscribed() {
		t.Error("CloseOpened should unsubscribe")
	}
	noClose(t, f)
}

func TestOpenExpiredLaunchesAreForgotten(t *testing.T) {
	f := newOpenFixture(t)
	now := time.Now()
	oldNow := openedNow
	openedNow = func() time.Time { return now }
	t.Cleanup(func() { openedNow = oldNow })
	if _, err := f.run(openOptions(appPath(t), CloseRunEnds, "old")); err != nil {
		t.Fatal(err)
	}
	now = now.Add(openedTTL + time.Minute)
	if _, err := f.run(openOptions(appPath(t), CloseRunEnds, "new")); err != nil {
		t.Fatal(err)
	}
	tr := f.m.openTracker()
	tr.onRunFinished("old")
	noClose(t, f)
	tr.onRunFinished("new")
	waitClose(t, f)
}

func TestOpenDescribeProblemStillTakesNoFiles(t *testing.T) {
	info, err := (&openStep{}).DescribeStep(mustJSON(t, DefaultOpen()))
	if err == nil {
		t.Fatal("an empty app should be a problem")
	}
	if !info.NoFiles {
		t.Error("a step with a problem must still say it takes no files")
	}
}
