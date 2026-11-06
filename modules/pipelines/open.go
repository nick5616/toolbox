package pipelines

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/focus"
	"toolbox/core/proc"
)

// Open in app (SPEC.md §4.2): launch a program, optionally with the run's
// files, and optionally ask it to close when the focus session or the run
// ends. Closing is always polite (focus.AskToClose), never a terminate.

const (
	maxOpenArgs = 20
	// openedTTL forgets a remembered launch (a session lasts ≤ 12 h).
	openedTTL = 13 * time.Hour
	// filesArg is the argument that expands to every file as its own argument.
	filesArg = "{files}"
)

// Seams for tests.
var (
	launchApp  = proc.Launch
	askToClose = focus.AskToClose
	openedNow  = time.Now
)

// openStep is the Open in app built-in step.
type openStep struct{ m *Module }

func (o *openStep) StepDefaults() any { return DefaultOpen() }

// openLabel is the name shown for the app.
func openLabel(s OpenStep) string {
	if l := strings.TrimSpace(s.Label); l != "" {
		return l
	}
	base := filepath.Base(filepath.Clean(s.App))
	return strings.TrimSuffix(base, filepath.Ext(base))
}

func checkOpenStep(s OpenStep) error {
	if strings.TrimSpace(s.App) == "" {
		return core.ValidationError("Pick an app to open", map[string]string{"app": "Pick an app"})
	}
	if !filepath.IsAbs(s.App) {
		return core.ValidationError("The app must be a full path", map[string]string{"app": "Pick the app again"})
	}
	if len(s.Args) > maxOpenArgs {
		return core.ValidationError(fmt.Sprintf("An app takes at most %d arguments", maxOpenArgs), map[string]string{"args": "Remove some"})
	}
	if !slices.Contains([]string{OpenFilesNone, OpenFilesEach, OpenFilesAll}, s.Files) {
		return core.ValidationError(fmt.Sprintf("Unknown files setting %q", s.Files), nil)
	}
	if !slices.Contains([]string{OpenWindowNormal, OpenWindowMinimized}, s.Window) {
		return core.ValidationError(fmt.Sprintf("Unknown window setting %q", s.Window), nil)
	}
	if !slices.Contains([]string{CloseNever, CloseFocusEnds, CloseRunEnds}, s.CloseWhen) {
		return core.ValidationError(fmt.Sprintf("Unknown close setting %q", s.CloseWhen), nil)
	}
	return nil
}

// usesFileVars reports whether an argument refers to {file} or {files}, which
// only exist for this step.
func usesFileVars(arg string) bool {
	return slices.ContainsFunc(core.TemplateVars(arg), func(n string) bool { return n == "file" || n == "files" })
}

func (o *openStep) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	// A step with a problem still takes no files of its own (or the runner
	// adds a misleading "needs files" problem next to the real one).
	bad := core.StepInfo{
		Accepts: core.Accepts{Extensions: []string{}, URLs: true, Any: true}, NoFiles: true,
		Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
		Templates: []string{}, Warnings: []string{}, Summary: "Open in app",
	}
	s, err := decodeStep(options, DefaultOpen())
	if err != nil {
		return bad, err
	}
	if err := checkOpenStep(s); err != nil {
		return bad, err
	}
	// App is never a template. Arguments that use {file}/{files} are left out
	// of the variable check, because those exist only here.
	templates := []string{}
	for i, a := range s.Args {
		if !usesFileVars(a) {
			templates = append(templates, fmt.Sprintf("/args/%d", i))
		}
	}
	warnings := []string{}
	if _, err := os.Stat(s.App); err != nil {
		warnings = append(warnings, openLabel(s)+" isn't at that place any more · pick it again")
	}
	if s.Files == OpenFilesNone && slices.ContainsFunc(s.Args, usesFileVars) {
		warnings = append(warnings, "An argument uses {file} but Files is set to none")
	}
	summary := "Open " + openLabel(s)
	switch s.CloseWhen {
	case CloseFocusEnds:
		summary += " · closes when focus ends"
	case CloseRunEnds:
		summary += " · closes when the run ends"
	}
	return core.StepInfo{
		Accepts: core.Accepts{Extensions: []string{}, URLs: true, Any: true}, NoFiles: true,
		Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
		Templates: templates, Warnings: warnings, Summary: summary,
	}, nil
}

// expandOpenArgs expands the arguments for one launch. files are the files
// this launch gets; {file} and the file variables come from the first.
func expandOpenArgs(args []string, files []core.RunFile, vars ...map[string]string) []string {
	fv := map[string]string{}
	if len(files) > 0 {
		fv = core.FileVars(files[0])
		fv["file"] = files[0].Path
	}
	all := append(slices.Clone(vars), fv)
	out := make([]string, 0, len(args)+len(files))
	for _, a := range args {
		if a == filesArg {
			for _, f := range files {
				out = append(out, f.Path)
			}
			continue
		}
		v, _ := core.ExpandVars(a, all...)
		out = append(out, v)
	}
	return out
}

func (o *openStep) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	s, err := decodeStep(req.Options, DefaultOpen())
	if err != nil {
		return nil, err
	}
	if err := checkOpenStep(s); err != nil {
		return nil, err
	}
	files := req.Item.Files
	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = f.Path
	}
	vars := runBuiltins(req, req.Item.Vars)
	job := func(args []string, inputs []string) core.StepJob {
		return core.StepJob{Inputs: slices.Clone(inputs), Options: Options{
			Action: ActionOpen, Pipeline: req.Pipeline,
			Open: &OpenJob{App: s.App, Label: openLabel(s), Args: args, Window: s.Window, CloseWhen: s.CloseWhen, RunID: req.RunID},
		}}
	}
	switch s.Files {
	case OpenFilesEach:
		if len(files) == 0 {
			return nil, core.ValidationError("There are no files to open with "+openLabel(s), nil)
		}
		jobs := make([]core.StepJob, 0, len(files))
		for i, f := range files {
			jobs = append(jobs, job(expandOpenArgs(s.Args, []core.RunFile{f}, vars, req.Item.Vars), paths[i:i+1]))
		}
		return jobs, nil
	case OpenFilesAll:
		return []core.StepJob{job(expandOpenArgs(s.Args, files, vars, req.Item.Vars), paths)}, nil
	default:
		return []core.StepJob{job(expandOpenArgs(s.Args, nil, vars, req.Item.Vars), paths)}, nil
	}
}

// StepOutputs passes the job's files on (the app makes none).
func (o *openStep) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	if strings.TrimSpace(job.ResultJSON) == "" {
		return res, nil
	}
	var jr jobResult
	if err := json.Unmarshal([]byte(job.ResultJSON), &jr); err != nil {
		return res, fmt.Errorf("reading the result of job %s: %w", job.ID, err)
	}
	if jr.Files != nil {
		res.Files = jr.Files
	}
	return res, nil
}

func validateOpenJob(j *OpenJob) error {
	if j == nil || strings.TrimSpace(j.App) == "" {
		return core.ValidationError("Pick an app to open", nil)
	}
	if !slices.Contains([]string{CloseNever, CloseFocusEnds, CloseRunEnds}, j.CloseWhen) {
		return core.ValidationError(fmt.Sprintf("Unknown close setting %q", j.CloseWhen), nil)
	}
	return nil
}

func (m *Module) runOpen(ctx context.Context, job *core.JobContext, o Options) error {
	j := o.Open
	label := j.Label
	if label == "" {
		label = openLabel(OpenStep{App: j.App})
	}
	job.Progress(core.IndeterminateProgress, "Opening "+label)
	l, err := launchApp(ctx, proc.LaunchSpec{Path: j.App, Args: j.Args, Minimized: j.Window == OpenWindowMinimized})
	if err != nil {
		return core.Errorf(CodeLaunchFailed, "Couldn't open %s", label).
			WithHint("The program may have moved; pick it again").WithCause(err)
	}
	job.Logf("Opened %s", label)
	if m.launcher.NoteLaunch != nil {
		m.launcher.NoteLaunch(j.App)
	}
	m.openTracker().remember(m, &openedApp{
		pid: l.PID, created: l.Created, path: j.App, label: label, closeWhen: j.CloseWhen, runID: j.RunID, at: openedNow(),
	})
	files := make([]core.RunFile, 0, len(job.Inputs))
	for _, p := range job.Inputs {
		files = append(files, runFile(p, "", "", ""))
	}
	return job.SetResult(jobResult{Files: files})
}

// ---- close-when tracking --------------------------------------------------

// openedApp is a launch remembered in memory (not after a restart).
type openedApp struct {
	pid     uint32
	created int64
	path    string
	label   string

	closeWhen string
	runID     string
	at        time.Time
	armed     bool // focusEnds: a session was on while it was open
}

// openedApps holds one module's launches and its subscriptions.
type openedApps struct {
	mu        sync.Mutex
	list      []*openedApp
	active    int // focus state: 1 session seen, -1 idle seen, 0 unknown
	unsub     func()
	runHooked bool
}

var openTrackers sync.Map // *Module -> *openedApps

func (m *Module) openTracker() *openedApps {
	v, _ := openTrackers.LoadOrStore(m, &openedApps{})
	return v.(*openedApps)
}

// remember records a launch and starts following what closes it.
func (t *openedApps) remember(m *Module, a *openedApp) {
	if a.closeWhen == CloseNever {
		return
	}
	// Ask before locking: the engine may be emitting to onFocus under its own lock.
	known := 0
	if a.closeWhen == CloseFocusEnds && m.launcher.Current != nil {
		known = -1
		if m.launcher.Current().Session != nil {
			known = 1
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked()
	if known != 0 {
		t.active = known
	}
	switch a.closeWhen {
	case CloseFocusEnds:
		// Launched in a session, or not known yet (assumed to be): armed.
		a.armed = t.active >= 0
		if t.unsub == nil && m.launcher.Subscribe != nil {
			t.unsub = m.launcher.Subscribe(func(st focus.State) { t.onFocus(st) })
		}
	case CloseRunEnds:
		if !t.runHooked && m.runner != nil {
			t.runHooked = true
			m.runner.OnRunFinished(func(run core.PipelineRun) { t.onRunFinished(run.ID) })
		}
	}
	t.list = append(t.list, a)
}

func (t *openedApps) pruneLocked() {
	cut := openedNow().Add(-openedTTL)
	t.list = slices.DeleteFunc(t.list, func(a *openedApp) bool { return a.at.Before(cut) })
}

// onFocus follows focus state: a session ending closes the armed apps.
func (t *openedApps) onFocus(st focus.State) {
	t.mu.Lock()
	var toClose []*openedApp
	if st.Session != nil {
		t.active = 1
		for _, a := range t.list {
			if a.closeWhen == CloseFocusEnds {
				a.armed = true
			}
		}
		t.mu.Unlock()
		return
	}
	t.active = -1
	t.list = slices.DeleteFunc(t.list, func(a *openedApp) bool {
		if a.closeWhen == CloseFocusEnds && a.armed {
			toClose = append(toClose, a)
			return true
		}
		return false
	})
	var unsub func()
	if !slices.ContainsFunc(t.list, func(a *openedApp) bool { return a.closeWhen == CloseFocusEnds }) {
		unsub, t.unsub = t.unsub, nil
	}
	t.mu.Unlock()
	closeApps(toClose)
	if unsub != nil {
		// Off the engine's goroutine: it may be holding its own lock.
		go unsub()
	}
}

// onRunFinished closes the apps a finished run opened.
func (t *openedApps) onRunFinished(runID string) {
	t.mu.Lock()
	var toClose []*openedApp
	t.list = slices.DeleteFunc(t.list, func(a *openedApp) bool {
		if a.closeWhen == CloseRunEnds && a.runID == runID {
			toClose = append(toClose, a)
			return true
		}
		return false
	})
	t.mu.Unlock()
	closeApps(toClose)
}

// closeApps asks each app to close, politely and off the caller's goroutine
// (the Mac's quit runs osascript). Never terminates.
func closeApps(apps []*openedApp) {
	if len(apps) == 0 {
		return
	}
	go func() {
		for _, a := range apps {
			_ = askToClose(a.pid, a.created, a.path)
		}
	}()
}

// CloseOpened stops following focus changes and forgets every launch; it
// closes nothing. Call it when the app stops.
func (m *Module) CloseOpened() {
	v, ok := openTrackers.LoadAndDelete(m)
	if !ok {
		return
	}
	t := v.(*openedApps)
	t.mu.Lock()
	unsub := t.unsub
	t.unsub, t.list = nil, nil
	t.mu.Unlock()
	if unsub != nil {
		unsub()
	}
}
