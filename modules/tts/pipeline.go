package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"sort"

	"toolbox/core"
)

// Pipeline step adapter: one submission with every file of the item; the job
// manager splits it into one job per text file.

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

// plainProblem turns a field-validation error into one whose message is the
// first field's message.
func plainProblem(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	keys := make([]string, 0, len(ae.Fields))
	for k := range ae.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return core.ValidationError(ae.Fields[keys[0]], ae.Fields)
}

func stepSummary(s StepOptions) string {
	name := s.Voice
	if v, ok := lookupVoice(s.Voice); ok {
		name = v.Name
	}
	out := name + " · " + string(s.Format)
	if s.Speed != 1 {
		out += fmt.Sprintf(" · %.2g×", s.Speed)
	}
	if s.Split == SplitHeadings {
		out += " · by heading"
	}
	return out
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	s, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := validateOptions(s.toOptions()); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	exts := []string{"." + string(s.Format)}
	products := []core.StepProduct{{Role: "speech", Label: "Speech", Kind: core.KindAudio, Exts: exts}}
	if s.Split == SplitHeadings {
		products[0].Many = true
		products = append(products, core.StepProduct{Role: "chapter", Label: "Chapter", Kind: core.KindAudio, Exts: exts, Many: true})
	}
	return core.StepInfo{
		Accepts:   m.Descriptor().Accepts,
		Produces:  products,
		Vars:      []core.StepVar{{Name: "voice", Label: "Voice", Type: core.ValueText}, {Name: "speech_file", Label: "Spoken file", Type: core.ValueFile}},
		Secrets:   []core.StepSecret{},
		Templates: []string{},
		Warnings:  []string{},
		Summary:   stepSummary(s),
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	s, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	inputs := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		inputs = append(inputs, f.Path)
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("There's no text to read aloud", nil)
	}
	opts := s.toOptions()
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal text to speech options: %w", err)
	}
	if err := m.Validate(inputs, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: slices.Clone(inputs), Options: opts}}, nil
}

// StepOutputs implements core.Chainable. Chapter files are role "chapter";
// a single spoken file is "speech".
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	vars := map[string]string{}
	var o Options
	if job.OptionsJSON != "" {
		if err := json.Unmarshal([]byte(job.OptionsJSON), &o); err == nil {
			vars["voice"] = o.Voice
		}
	}
	chapter := map[string]bool{}
	if job.ResultJSON != "" {
		var r Result
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err == nil {
			for _, f := range r.Files {
				chapter[f.Path] = f.Chapter
			}
		}
	}
	res := core.StepResult{Files: []core.RunFile{}, Vars: vars}
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		role, label := "speech", "Speech"
		if chapter[out.Path] {
			role, label = "chapter", "Chapter"
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: core.KindAudio, Role: role, RoleLabel: label, OutputID: out.ID})
		if _, ok := vars["speech_file"]; !ok {
			// The first spoken file, so a later step can use it by path
			// (e.g. "Assemble a video"'s music bed: {speech_file}).
			vars["speech_file"] = out.Path
		}
	}
	return res, nil
}
