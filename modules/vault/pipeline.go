package vault

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2, §6.3).

var _ core.Chainable = (*Module)(nil)

// StepOptions are the Vault's pipeline step options: add the files to Folder
// ({vars} allowed; "" = the root).
type StepOptions struct {
	Folder string `json:"folder"`
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return StepOptions{} }

func decodeStep(raw json.RawMessage) (StepOptions, error) {
	var o StepOptions
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

// placeholderFolder replaces every {var} with a stand-in so the folder name
// can be checked before any values exist.
func placeholderFolder(tpl string) string {
	vals := map[string]string{}
	for _, n := range core.TemplateVars(tpl) {
		vals[n] = "x"
	}
	out, _ := core.ExpandVars(tpl, vals)
	return out
}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if _, err := cleanFolder(placeholderFolder(o.Folder)); err != nil {
		return core.StepInfo{}, err
	}
	summary := "Add to the Vault"
	if f, _ := cleanFolder(o.Folder); f != "" {
		summary = "Add to Vault › " + f
	}
	return core.StepInfo{
		Accepts:   m.Descriptor().Accepts,
		Produces:  []core.StepProduct{},
		Vars:      []core.StepVar{},
		Secrets:   []core.StepSecret{},
		Templates: []string{"/folder"},
		Warnings:  []string{},
		Summary:   summary,
	}, nil
}

// PrepareStep implements core.Chainable. One job per item with all its
// files. While the Vault is locked (or not created yet) the step waits.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	folder, missing := core.ExpandVars(o.Folder, req.Item.Vars)
	_ = missing // unknown names become "": the run's own checks report them
	folder, err = cleanFolder(folder)
	if err != nil {
		return nil, err
	}
	if _, _, _, err := m.v.unlockedSnapshot(); err != nil {
		if errors.Is(err, errLocked) {
			return nil, core.ErrWaiting("Unlock the Vault to continue", "Open the Vault and unlock it")
		}
		return nil, err
	}
	inputs := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		inputs = append(inputs, f.Path)
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("Choose files to add", map[string]string{"inputs": "Choose files to add"})
	}
	return []core.StepJob{{Inputs: inputs, Options: Options{Action: ActionAdd, Folder: folder}}}, nil
}

// StepOutputs implements core.Chainable: adding to the Vault makes no files.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}, nil
}
