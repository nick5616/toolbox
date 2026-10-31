package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"toolbox/core"
)

// fakeOpts drive fakeStep. Every field is optional.
type fakeOpts struct {
	Make     int               `json:"make"`     // files made per input (default 1)
	Roles    []string          `json:"roles"`    // role of file i (cycled); "" = main
	Fail     string            `json:"fail"`     // Run fails with this message
	Vars     map[string]string `json:"vars"`     // variables set by StepOutputs (values take {vars} at Prepare)
	Wait     string            `json:"wait"`     // PrepareStep returns ErrWaiting(Wait) while WaitFlag file exists
	WaitFlag string            `json:"waitFlag"` //
	Together bool              `json:"together"` // one job over every item
	Secret   bool              `json:"secret"`   // asks for secret "pw"; Prepare fails without it
	Ext      string            `json:"ext"`      // made files' extension (default ".txt")
	Template string            `json:"template"` // a {vars} field (checked by Describe)
	Expanded string            `json:"expanded"` // set by Prepare: Template expanded (written into each file)

	Hold         string `json:"hold"`         // Run blocks until gate(Hold) is released
	FailFlag     string `json:"failFlag"`     // Run fails (with Fail or "flagged") while this file exists
	PrepFail     string `json:"prepFail"`     // PrepareStep fails with this message ...
	PrepFailFlag string `json:"prepFailFlag"` // ... while this file exists (always when empty)
	NoJob        bool   `json:"noJob"`        // PrepareStep returns zero jobs
	NoOutput     bool   `json:"noOutput"`     // Run succeeds without making files
	FailOn       string `json:"failOn"`       // Run fails when an input's name contains this (while FailFlag exists, if set)
}

var (
	gateMu sync.Mutex
	gates  = map[string]chan struct{}{}
)

// gate returns the channel Run waits on for options.Hold == key.
func gate(key string) chan struct{} {
	gateMu.Lock()
	defer gateMu.Unlock()
	if gates[key] == nil {
		gates[key] = make(chan struct{})
	}
	return gates[key]
}

func release(key string) { close(gate(key)) }

// fakeStep is a Chainable module for runner tests. It accepts .txt and .wav.
// With split, Submit makes one job per input (like most tools); register a
// non-split one for together steps so they run as a single job.
type fakeStep struct {
	id    string
	split bool

	cur, peak atomic.Int32 // running Run calls now / at most
	started   atomic.Int32 // Run calls ever started
}

func (f *fakeStep) Descriptor() core.Descriptor {
	return core.Descriptor{ID: f.id, Name: "Fake " + f.id, Icon: "box", Category: core.CategoryUtility,
		Status: core.StatusReady, Accepts: core.Accepts{Extensions: []string{".txt", ".wav"}}, OutputSubdir: f.id, SplitInputs: f.split}
}

func (f *fakeStep) Validate(inputs []string, options json.RawMessage) error {
	_, err := core.DecodeOptionsJSON[fakeOpts](options)
	return err
}

func (f *fakeStep) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[fakeOpts](job)
	if err != nil {
		return err
	}
	n0 := f.cur.Add(1)
	f.started.Add(1)
	defer f.cur.Add(-1)
	for {
		p := f.peak.Load()
		if n0 <= p || f.peak.CompareAndSwap(p, n0) {
			break
		}
	}
	if o.Hold != "" {
		select {
		case <-gate(o.Hold):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if o.FailOn != "" {
		for _, in := range job.Inputs {
			if strings.Contains(filepath.Base(in), o.FailOn) {
				if _, err := os.Stat(o.FailFlag); o.FailFlag == "" || err == nil {
					return core.ValidationError("bad input", nil)
				}
			}
		}
	}
	if o.FailFlag != "" && o.FailOn == "" {
		if _, err := os.Stat(o.FailFlag); err == nil {
			msg := o.Fail
			if msg == "" {
				msg = "flagged"
			}
			return core.ValidationError(msg, nil)
		}
	}
	if o.Fail != "" && o.FailFlag == "" && o.FailOn == "" {
		return core.ValidationError(o.Fail, nil)
	}
	if o.NoOutput {
		return nil
	}
	n := o.Make
	if n == 0 {
		n = 1
	}
	ext := o.Ext
	if ext == "" {
		ext = ".txt"
	}
	for _, in := range job.Inputs {
		for i := 0; i < n; i++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			stem := core.StemName(in)
			if len(o.Roles) > 0 {
				stem += " - " + o.Roles[i%len(o.Roles)]
			} else if n > 1 {
				stem += fmt.Sprintf(" %d", i+1)
			}
			p := core.UniquePath(job.OutputDir, stem, ext)
			if err := os.WriteFile(p, []byte(o.Expanded), 0o644); err != nil {
				return err
			}
			if _, err := job.Output(p); err != nil {
				return err
			}
		}
	}
	return nil
}

func (f *fakeStep) StepDefaults() any { return fakeOpts{} }

func (f *fakeStep) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := core.DecodeOptionsJSON[fakeOpts](options)
	if err != nil {
		return core.StepInfo{}, err
	}
	info := core.StepInfo{
		Accepts:   f.Descriptor().Accepts,
		Together:  o.Together,
		Templates: []string{"/template"},
		Summary:   "fake",
	}
	ext := o.Ext
	if ext == "" {
		ext = ".txt"
	}
	if len(o.Roles) == 0 {
		info.Produces = []core.StepProduct{{Kind: core.KindForPath("x" + ext), Exts: []string{ext}, Many: o.Make > 1}}
	}
	for _, r := range o.Roles {
		info.Produces = append(info.Produces, core.StepProduct{Role: strings.ToLower(r), Label: r, Kind: core.KindForPath("x" + ext), Exts: []string{ext}})
	}
	for k := range o.Vars {
		info.Vars = append(info.Vars, core.StepVar{Name: k, Label: k})
	}
	if o.Secret {
		info.Secrets = []core.StepSecret{{Key: "pw", Label: "Password"}}
	}
	return info, nil
}

func (f *fakeStep) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := core.DecodeOptionsJSON[fakeOpts](req.Options)
	if err != nil {
		return nil, err
	}
	if o.Wait != "" && o.WaitFlag != "" {
		if _, err := os.Stat(o.WaitFlag); err == nil {
			return nil, core.ErrWaiting(o.Wait, "")
		}
	}
	if o.Secret && req.Secrets["pw"] == "" {
		return nil, core.ValidationError("Needs a password", nil)
	}
	if o.PrepFail != "" {
		if o.PrepFailFlag == "" {
			return nil, core.ValidationError(o.PrepFail, nil)
		}
		if _, err := os.Stat(o.PrepFailFlag); err == nil {
			return nil, core.ValidationError(o.PrepFail, nil)
		}
	}
	if o.NoJob {
		return nil, nil
	}
	o.Expanded, _ = core.ExpandVars(o.Template, req.Item.Vars)
	for k, v := range o.Vars {
		o.Vars[k], _ = core.ExpandVars(v, req.Item.Vars)
	}
	items := []core.StepItem{req.Item}
	if o.Together {
		items = req.Items
	}
	var inputs []string
	for _, it := range items {
		for _, fl := range it.Files {
			inputs = append(inputs, fl.Path)
		}
	}
	if len(inputs) == 0 {
		return nil, nil
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

func (f *fakeStep) StepOutputs(job core.Job) (core.StepResult, error) {
	o, err := core.DecodeOptionsJSON[fakeOpts](json.RawMessage(job.OptionsJSON))
	if err != nil {
		return core.StepResult{}, err
	}
	res := core.StepResult{Vars: map[string]string{}}
	for _, out := range job.Outputs {
		rf := core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID}
		for _, r := range o.Roles {
			if strings.HasSuffix(core.StemName(out.Path), " - "+r) {
				rf.Role, rf.RoleLabel = strings.ToLower(r), r
			}
		}
		res.Files = append(res.Files, rf)
	}
	for k, v := range o.Vars {
		if v != "<unset>" {
			res.Vars[k] = v
		}
	}
	return res, nil
}

// fakeManual is a non-Chainable module (manual steps only).
type fakeManual struct{ id string }

func (f *fakeManual) Descriptor() core.Descriptor {
	return core.Descriptor{ID: f.id, Name: "Manual " + f.id, Status: core.StatusReady,
		Accepts: core.Accepts{Extensions: []string{".txt"}}, OutputSubdir: f.id}
}
func (f *fakeManual) Validate([]string, json.RawMessage) error { return nil }
func (f *fakeManual) Run(ctx context.Context, job *core.JobContext) error {
	for _, in := range job.Inputs {
		p := core.UniquePath(job.OutputDir, core.StemName(in)+" (by hand)", filepath.Ext(in))
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			return err
		}
		if _, err := job.Output(p); err != nil {
			return err
		}
	}
	return nil
}

var (
	_ core.Module    = (*fakeStep)(nil)
	_ core.Chainable = (*fakeStep)(nil)
	_ core.Module    = (*fakeManual)(nil)
)
