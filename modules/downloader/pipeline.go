package downloader

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2): one submission per item with its
// link(s); the module splits it into one job per link.

var _ core.Chainable = (*Module)(nil)

// stepDefaults are the Downloader defaults without playlists.
func stepDefaults() Options {
	o := DefaultOptions()
	o.Playlist = false
	return o
}

// decodeStep decodes step options strictly over the step defaults, so unset
// fields keep their defaults.
func decodeStep(raw json.RawMessage) (Options, error) {
	o := stepDefaults()
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
// first field's message (Describe shows messages as plain problem lines).
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

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return stepDefaults() }

// stepSummary is the one-line summary, e.g. "Video · up to 1080p".
func stepSummary(o Options) string {
	if o.Mode == ModeVideo {
		if o.MaxResolution == ResBest {
			return "Video · best quality"
		}
		return "Video · up to " + string(o.MaxResolution) + "p"
	}
	switch o.AudioFormat {
	case FormatWAV:
		return "Audio · WAV"
	case FormatFLAC:
		return "Audio · FLAC"
	}
	if o.AudioQuality == QualityBest {
		return "Audio · MP3 best"
	}
	return "Audio · MP3 " + string(o.AudioQuality)
}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	// Reuse Validate's option checks with a placeholder link.
	raw, err := json.Marshal(o)
	if err != nil {
		return core.StepInfo{}, fmt.Errorf("marshal downloader options: %w", err)
	}
	if err := m.Validate([]string{"https://example.com/watch"}, raw); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	prod := core.StepProduct{Many: o.Playlist}
	if o.Mode == ModeVideo {
		prod.Kind, prod.Exts = core.KindVideo, []string{".mp4"}
	} else {
		prod.Kind, prod.Exts = core.KindAudio, []string{"." + string(o.AudioFormat)}
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: []core.StepProduct{prod},
		Vars:     []core.StepVar{{Name: "title", Label: "Title", Type: core.ValueText}, {Name: "url", Label: "Link", Type: core.ValueText}},
		Summary:  stepSummary(o),
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	links := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		if p := strings.TrimSpace(f.Path); p != "" {
			links = append(links, p)
		}
	}
	if len(links) == 0 {
		return nil, core.ValidationError("There's no link to download", nil)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal downloader options: %w", err)
	}
	if err := m.Validate(links, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: links, Options: o}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID})
	}
	res.Vars["title"], _ = core.CapVar(job.Title)
	if len(job.Inputs) > 0 {
		res.Vars["url"], _ = core.CapVar(job.Inputs[0])
	}
	return res, nil
}
