package audiocleanup

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2): one submission with every file of the
// item; the module splits it into one job per file.

var _ core.Chainable = (*Module)(nil)

// StepOptions are Audio Cleanup's pipeline step options (Options without the
// preview fields).
type StepOptions struct {
	HighPass bool     `json:"highPass"`
	Hum      Hum      `json:"hum"`
	Denoise  Denoise  `json:"denoise"`
	Loudness Loudness `json:"loudness"`
	Format   Format   `json:"format"`
}

// DefaultStepOptions mirrors DefaultOptions.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{HighPass: o.HighPass, Hum: o.Hum, Denoise: o.Denoise, Loudness: o.Loudness, Format: o.Format}
}

// toOptions is the job's options: a full run, never a preview.
func (s StepOptions) toOptions() Options {
	return Options{HighPass: s.HighPass, Hum: s.Hum, Denoise: s.Denoise, Loudness: s.Loudness, Format: s.Format, Preview: false}
}

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
	var parts []string
	switch s.Denoise {
	case DenoiseLight:
		parts = append(parts, "Light noise reduction")
	case DenoiseStrong:
		parts = append(parts, "Strong noise reduction")
	case DenoiseVoice:
		parts = append(parts, "Voice isolation")
	}
	switch s.Hum {
	case HumAuto:
		parts = append(parts, "Hum removal")
	case Hum50, Hum60:
		parts = append(parts, string(s.Hum)+" Hz hum removal")
	}
	if s.HighPass {
		parts = append(parts, "Rumble filter")
	}
	switch s.Loudness {
	case LoudnessPodcast:
		parts = append(parts, "Podcast loudness")
	case LoudnessStreaming:
		parts = append(parts, "Streaming loudness")
	case LoudnessBroadcast:
		parts = append(parts, "Broadcast loudness")
	}
	if len(parts) == 0 {
		parts = append(parts, "No cleanup")
	}
	if s.Format != FormatSame {
		parts = append(parts, strings.ToUpper(string(s.Format)))
	}
	return strings.Join(parts, " · ")
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
	return core.StepInfo{
		Accepts: m.Descriptor().Accepts,
		// The same kind as the input; audio takes the chosen format and
		// videos keep their container, so no extension is promised.
		Produces: []core.StepProduct{{}},
		Vars:     []core.StepVar{},
		Summary:  stepSummary(s),
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
		return nil, core.ValidationError("There's no file to clean up", nil)
	}
	opts := s.toOptions()
	raw, err := json.Marshal(opts)
	if err != nil {
		return nil, fmt.Errorf("marshal audio cleanup options: %w", err)
	}
	if err := m.Validate(inputs, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: inputs, Options: opts}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID})
	}
	return res, nil
}
