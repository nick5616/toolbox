package stems

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

type stemFile struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type separateResult struct {
	Stems []stemFile `json:"stems"`
	Model string     `json:"model"`
}

func validateOptions(o Options) error {
	fields := map[string]string{}
	if _, ok := presets[o.Preset]; !ok {
		fields["preset"] = "Choose a valid preset"
	}
	switch o.Format {
	case FormatWAV, FormatFLAC, FormatMP3:
	default:
		fields["format"] = "Choose WAV, FLAC or MP3"
	}
	if len(fields) > 0 {
		return core.ValidationError("Some options are invalid", fields)
	}
	return nil
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return validateOptions(o)
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := validateOptions(o); err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("Add at least one file", map[string]string{"inputs": "Add at least one file"})
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	input := job.Inputs[0]
	job.SetTitle(filepath.Base(input))
	name := core.StemName(input)
	outDir := filepath.Join(job.OutputDir, name)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the output folder").WithCause(err)
	}
	spec := presets[o.Preset]
	params := map[string]any{
		"input": input, "outputDir": outDir, "model": spec.Model,
		"outputFormat": string(o.Format), "baseName": name,
	}
	outs := newOutputs(job)
	raw, err := m.sc.Call(ctx, "stems.separate", params, outs.onEvent)
	if err != nil {
		return err
	}
	var res separateResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The audio engine returned an unreadable result").WithCause(err)
	}
	for _, s := range res.Stems {
		outs.register(s.Path)
	}
	if outs.err != nil {
		return outs.err
	}
	if res.Stems == nil {
		res.Stems = []stemFile{}
	}
	model := res.Model
	if model == "" {
		model = spec.Model
	}
	if err := job.SetResult(map[string]any{"preset": string(o.Preset), "model": model, "stems": res.Stems}); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("%d stems", len(res.Stems)))
	return nil
}
