package focus

import (
	"encoding/json"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/focus"
)

// fakeEngine implements Engine in memory. It never touches the OS.
type fakeEngine struct {
	now      time.Time
	state    focus.State
	profiles []focus.Profile
	calls    []string
	begun    []focus.StartRequest
	extended []int64
	endedFor []string
	endErr   error
}

var _ Engine = (*fakeEngine)(nil)

func newFake(now time.Time) *fakeEngine {
	return &fakeEngine{
		now:      now,
		state:    focus.State{Supported: true, OS: "windows", StillOpen: []focus.OpenApp{}},
		profiles: []focus.Profile{{ID: "p1", Name: "Studio", Rules: []focus.AllowRule{{ID: "r", Label: "x", Kind: focus.RuleExe, Path: `C:\x.exe`, Children: true}}}},
	}
}

func (f *fakeEngine) State() focus.State { return f.state }
func (f *fakeEngine) Begin(req focus.StartRequest) (focus.Session, error) {
	f.calls = append(f.calls, "begin")
	if f.state.Session != nil {
		return focus.Session{}, core.Errorf(focus.CodeActive, "A focus session is already on")
	}
	f.begun = append(f.begun, req)
	ends := req.Until
	if ends == 0 {
		ends = f.now.Add(time.Duration(req.Minutes) * time.Minute).UnixMilli()
	}
	s := focus.Session{ID: "s1", Profile: f.profiles[0], Strength: req.Strength, StartedAt: f.now.UnixMilli(), EndsAt: ends, RunID: req.RunID, StepID: req.StepID}
	f.state.Session = &s
	return s, nil
}
func (f *fakeEngine) Extend(minutes int) (focus.Session, error) { return focus.Session{}, nil }
func (f *fakeEngine) ExtendTo(until int64) (focus.Session, error) {
	f.calls = append(f.calls, "extendTo")
	f.extended = append(f.extended, until)
	s := *f.state.Session
	if until > s.EndsAt {
		s.EndsAt = until
	}
	f.state.Session = &s
	return s, nil
}
func (f *fakeEngine) RequestWeaken(focus.Weaken, *focus.AllowRule) (focus.Friction, error) {
	return focus.Friction{}, nil
}
func (f *fakeEngine) ConfirmWeaken(focus.Weaken, string) error { return nil }
func (f *fakeEngine) CancelWeaken()                            {}
func (f *fakeEngine) EndFor(runID string) error {
	f.calls = append(f.calls, "endFor")
	f.endedFor = append(f.endedFor, runID)
	if f.endErr != nil {
		return f.endErr
	}
	f.state.Session = nil
	return nil
}
func (f *fakeEngine) CloseAgain(uint32, int64) error                        { return nil }
func (f *fakeEngine) ForceClose(uint32, int64) error                        { return nil }
func (f *fakeEngine) LeaveOpen(uint32, int64)                               {}
func (f *fakeEngine) SetLearn(bool) error                                   { return nil }
func (f *fakeEngine) Profiles() ([]focus.Profile, error)                    { return f.profiles, nil }
func (f *fakeEngine) SaveProfile(p focus.Profile) (focus.Profile, error)    { return p, nil }
func (f *fakeEngine) DeleteProfile(string) error                            { return nil }
func (f *fakeEngine) Settings() focus.Settings                              { return focus.DefaultSettings() }
func (f *fakeEngine) SaveSettings(s focus.Settings) (focus.Settings, error) { return s, nil }
func (f *fakeEngine) Blocked(int) ([]focus.BlockedApp, error)               { return nil, nil }
func (f *fakeEngine) Recent(int) ([]focus.Session, error)                   { return nil, nil }
func (f *fakeEngine) LearnList() ([]focus.LearnEntry, error)                { return nil, nil }
func (f *fakeEngine) IgnoreLearn(string) error                              { return nil }

// runJob runs a PrepareStep job on the module and reads it back like the runner.
func runJob(t *testing.T, m *Module, job core.StepJob) (core.StepResult, error) {
	t.Helper()
	raw, err := json.Marshal(job.Options)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Validate(job.Inputs, raw); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	var result json.RawMessage
	jc := core.NewJobContext(core.JobContext{ID: "j1", Inputs: job.Inputs, Options: raw}, core.JobHooks{
		Result: func(r json.RawMessage) { result = r },
	})
	if err := m.Run(t.Context(), jc); err != nil {
		return core.StepResult{}, err
	}
	return m.StepOutputs(core.Job{ID: "j1", Inputs: job.Inputs, ResultJSON: string(result)})
}
