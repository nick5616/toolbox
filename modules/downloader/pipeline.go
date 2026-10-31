package downloader

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2).
// CONTRACT STUB (Wave 0): the step options and the method set are final;
// WP-AD1 implements PrepareStep and StepOutputs and completes DescribeStep.

var _ core.Chainable = (*Module)(nil)

// stepDefaults are the Downloader defaults without playlists.
func stepDefaults() Options {
	o := DefaultOptions()
	o.Playlist = false
	return o
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return stepDefaults() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	if _, err := core.DecodeOptionsJSON[Options](options); err != nil {
		return core.StepInfo{}, err
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: []core.StepProduct{{Kind: core.KindAudio, Exts: []string{".mp3"}}},
		Vars:     []core.StepVar{{Name: "title", Label: "Title"}, {Name: "url", Label: "Link"}},
		Summary:  "Downloader",
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Downloader as a pipeline step")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Downloader as a pipeline step")
}
