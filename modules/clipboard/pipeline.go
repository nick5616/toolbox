package clipboard

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
)

// The "Copy to clipboard" pipeline step (Phase 14). Clipboard History is
// job-less, so the tool is a core.StepProvider and its jobs run on the hidden
// CopyModule. (The "When I copy…" trigger is History.OnRecorded plus
// pipeline.Runner.ClipboardCopied.)

// CopyModuleID is the hidden module whose jobs put text on the clipboard.
const CopyModuleID = "clipboard-copy"

var textExts = []string{".txt", ".md"}

var (
	_ core.StepProvider = Module{}
	_ core.Module       = (*CopyModule)(nil)
)

// StepOptions are what the user edits on a Copy to clipboard step.
type StepOptions struct {
	// Text is what to copy and takes {vars} (e.g. {reply}). Empty = the first
	// .txt or .md file the step receives.
	Text string `json:"text"`
}

// DefaultStepOptions copies the first text file.
func DefaultStepOptions() StepOptions { return StepOptions{} }

// CopyOptions are a clipboard-copy job's options.
type CopyOptions struct {
	Text  string         `json:"text"`
	Carry []core.RunFile `json:"carry"` // the step's files, passed on unchanged
}

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

// StepType implements core.StepProvider.
func (Module) StepType() core.StepType {
	return core.StepType{
		ModuleID:    CopyModuleID,
		Name:        "Copy to clipboard",
		Description: "Put a text result on the clipboard",
		Accepts:     core.Accepts{Extensions: slices.Clone(textExts)},
	}
}

// StepDefaults implements core.Chainable.
func (Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	info := core.StepInfo{
		Accepts:  core.Accepts{Extensions: slices.Clone(textExts)},
		Produces: []core.StepProduct{{Many: true}}, // the files go on unchanged
		Vars:     []core.StepVar{}, Secrets: []core.StepSecret{}, Templates: []string{"/text"}, Warnings: []string{},
		Summary: "Copy the first text file",
	}
	if strings.TrimSpace(o.Text) != "" {
		info.NoFiles = true
		info.Summary = "Copy " + ellipsize(strings.TrimSpace(o.Text), 40)
	}
	return info, nil
}

func ellipsize(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// PrepareStep implements core.Chainable.
func (Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	var text string
	var inputs []string
	if strings.TrimSpace(o.Text) != "" {
		text, _ = core.ExpandVars(o.Text, req.Item.Vars, firstFileVars(req.Item.Files))
	} else {
		for _, f := range req.Item.Files {
			if !slices.Contains(textExts, strings.ToLower(filepath.Ext(f.Path))) {
				continue
			}
			text, err = readText(f.Path)
			if err != nil {
				return nil, err
			}
			inputs = append(inputs, f.Path)
			break
		}
	}
	if len(text) > core.MaxVarBytes {
		return nil, core.ValidationError("That text is too long for the clipboard step", nil).
			WithHint("Copy up to 256 KiB")
	}
	if strings.TrimSpace(text) == "" {
		return nil, core.ValidationError("There is no text to copy", nil)
	}
	return []core.StepJob{{Inputs: inputs, Options: CopyOptions{Text: text, Carry: carry(req.Item.Files)}}}, nil
}

func firstFileVars(files []core.RunFile) map[string]string {
	if len(files) == 0 {
		return nil
	}
	return core.FileVars(files[0])
}

func carry(files []core.RunFile) []core.RunFile {
	out := make([]core.RunFile, len(files))
	copy(out, files)
	return out
}

// readText reads a text file for the clipboard (≤ MaxVarBytes + 1).
func readText(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "Can't read %s", filepath.Base(path)).WithCause(err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, core.MaxVarBytes+1))
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", filepath.Base(path), err)
	}
	return strings.ToValidUTF8(string(b), ""), nil
}

// StepOutputs implements core.Chainable: the files the step was given.
func (Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	if strings.TrimSpace(job.ResultJSON) == "" {
		return res, nil
	}
	var r copyResult
	if err := json.Unmarshal([]byte(job.ResultJSON), &r); err != nil {
		return res, fmt.Errorf("reading the result of job %s: %w", job.ID, err)
	}
	if r.Files != nil {
		res.Files = r.Files
	}
	return res, nil
}

type copyResult struct {
	Files []core.RunFile `json:"files"`
}

// CopyModule is the hidden module whose jobs put text on the clipboard.
type CopyModule struct{ h *History }

// Descriptor implements core.Module.
func (m *CopyModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: CopyModuleID, Name: "Copy to clipboard", Icon: "clipboard", Category: core.CategoryUtility,
		Status: core.StatusReady, Hidden: true, MaxConcurrent: 1, Interactive: true,
	}
}

// Validate implements core.Module.
func (m *CopyModule) Validate(_ []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[CopyOptions](options)
	if err != nil {
		return err
	}
	if strings.TrimSpace(o.Text) == "" {
		return core.ValidationError("There is no text to copy", nil)
	}
	return nil
}

// Run implements core.Module. The text is written with History.CopyTextQuiet,
// so it is recorded like any copy but starts no "When I copy…" pipeline.
func (m *CopyModule) Run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[CopyOptions](job)
	if err != nil {
		return err
	}
	if m.h == nil {
		return core.Errorf(core.CodeInternal, "Clipboard unavailable")
	}
	job.SetTitle("Copy to clipboard")
	if err := m.h.CopyTextQuiet(ctx, o.Text); err != nil {
		return err
	}
	job.Progress(1, "Copied")
	carryFiles := o.Carry
	if carryFiles == nil {
		carryFiles = []core.RunFile{}
	}
	return job.SetResult(copyResult{Files: carryFiles})
}
