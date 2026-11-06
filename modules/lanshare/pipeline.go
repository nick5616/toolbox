package lanshare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"time"

	"toolbox/core"
	"toolbox/core/lan"
)

var _ core.Chainable = (*Module)(nil)

// decodeStep decodes step options strictly over the defaults.
func decodeStep(raw json.RawMessage) (StepOptions, error) {
	o := DefaultStepOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return o, nil
}

// checkStep validates step options; the device must be one the runtime knows.
func (m *Module) checkStep(o StepOptions) (lan.Device, error) {
	if o.Device == "" {
		return lan.Device{}, core.ValidationError("Pick a device", map[string]string{"device": "Pick a device"})
	}
	if o.WaitMinutes < 0 || o.WaitMinutes > 1440 {
		return lan.Device{}, core.ValidationError("Wait between 0 and 1440 minutes", map[string]string{"waitMinutes": "Use 0 to 1440 minutes"})
	}
	if len(o.Text) > lan.MaxTextBytes {
		return lan.Device{}, core.ValidationError("The message is too long (64 KiB at most)", map[string]string{"text": "Too long"})
	}
	if m.rt == nil {
		return lan.Device{Fingerprint: o.Device}, nil
	}
	dev, ok := m.rt.Device(o.Device)
	if !ok {
		return lan.Device{}, core.ValidationError("That device isn't known any more. Pick one again", map[string]string{"device": "Pick a device"})
	}
	return dev, nil
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	dev, err := m.checkStep(o)
	if err != nil {
		return core.StepInfo{}, err
	}
	summary := "Send to " + dev.Alias
	if dev.Alias == "" {
		summary = "Send to a device"
	}
	if !(dev.Toolbox && dev.Paired) {
		summary += " · LocalSend devices ask their user to accept"
	}
	return core.StepInfo{
		Accepts:   core.Accepts{Any: true, Extensions: []string{}},
		Produces:  []core.StepProduct{{Role: "sent", Label: "Sent file", Many: true}},
		Vars:      []core.StepVar{{Name: "device", Label: "Device", Type: core.ValueText}},
		Secrets:   []core.StepSecret{},
		Templates: []string{"/text"},
		Warnings:  []string{},
		Summary:   summary,
	}, nil
}

// PrepareStep implements core.Chainable: one job per item with all its files.
// While the device isn't on the network it waits, up to WaitMinutes from the
// run's start, then fails with lan_offline.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	dev, err := m.checkStep(o)
	if err != nil {
		return nil, err
	}
	var inputs []string
	for _, f := range req.Item.Files {
		if !slices.Contains(inputs, f.Path) {
			inputs = append(inputs, f.Path)
		}
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("There are no files to send", nil)
	}
	text, _ := core.ExpandVars(o.Text, req.Item.Vars, core.FileVars(req.Item.Files[0]))

	if m.rt != nil {
		if _, perr := m.rt.Probe(ctx, o.Device); perr != nil {
			if cur, ok := m.rt.Device(o.Device); !ok || !cur.Online {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				deadline := time.UnixMilli(req.Started).Add(time.Duration(o.WaitMinutes) * time.Minute)
				if req.Started > 0 && time.Now().After(deadline) {
					return nil, offlineError(dev.Alias).WithCause(perr)
				}
				return nil, core.ErrWaiting("Waiting for "+dev.Alias+" to be on the network",
					"Open Toolbox or LocalSend on it and make sure it's receiving")
			}
		}
	}
	return []core.StepJob{{Inputs: inputs, Options: Options{Device: o.Device, Text: text}}}, nil
}

// StepOutputs implements core.Chainable: the sent files pass through with the
// role "sent"; var "device" is the receiver's alias.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{"device": ""}}
	for _, in := range job.Inputs {
		res.Files = append(res.Files, core.RunFile{Path: in, Name: filepath.Base(in), Role: "sent", RoleLabel: "Sent file"})
	}
	if job.ResultJSON != "" {
		var r SendJobResult
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err == nil {
			res.Vars["device"] = r.Device
		}
	}
	return res, nil
}
