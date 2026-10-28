package midi

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

type transcribeResult struct {
	Notes       int     `json:"notes"`
	PitchRange  [2]int  `json:"pitchRange"`
	DurationSec float64 `json:"durationSec"`
	OutputPath  string  `json:"outputPath"`
}

func validateOptions(o Options) error {
	fields := map[string]string{}
	if !(o.Sensitivity >= 0.1 && o.Sensitivity <= 0.9) {
		fields["sensitivity"] = "Must be between 0.1 and 0.9"
	}
	if !(o.NoteFloor >= 0.1 && o.NoteFloor <= 0.6) {
		fields["noteFloor"] = "Must be between 0.1 and 0.6"
	}
	if !(o.MinNoteMs >= 30 && o.MinNoteMs <= 500) {
		fields["minNoteMs"] = "Must be between 30 and 500 ms"
	}
	switch o.Range {
	case RangeFull, RangeBass, RangeMelody:
	default:
		fields["range"] = "Choose full, bass or melody"
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

var noteNames = [12]string{"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"}

// noteName converts a MIDI note number to a name with sharps (60 = C4).
func noteName(n int) string {
	oct := int(math.Floor(float64(n)/12)) - 1
	return fmt.Sprintf("%s%d", noteNames[((n%12)+12)%12], oct)
}

func message(r Result) string {
	if r.Notes <= 0 {
		return "No notes found"
	}
	return fmt.Sprintf("%d notes · %s–%s", r.Notes, noteName(r.PitchRange[0]), noteName(r.PitchRange[1]))
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
	outPath := core.UniquePath(job.OutputDir, core.StemName(input), ".mid")
	var minHz, maxHz any
	switch o.Range {
	case RangeBass:
		maxHz = 400
	case RangeMelody:
		minHz = 200
	}
	params := map[string]any{
		"input": input, "outputPath": outPath,
		"onsetThreshold": math.Round((1-o.Sensitivity)*100) / 100,
		"frameThreshold": o.NoteFloor, "minNoteMs": o.MinNoteMs,
		"minHz": minHz, "maxHz": maxHz, "melodiaTrick": o.MelodiaTrick,
	}
	outs := newOutputs(job)
	raw, err := m.sc.Call(ctx, "midi.transcribe", params, outs.onEvent)
	if err != nil {
		return err
	}
	var tr transcribeResult
	if err := json.Unmarshal(raw, &tr); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	if tr.OutputPath != "" {
		outs.register(tr.OutputPath)
	} else {
		outs.register(outPath)
	}
	if outs.err != nil {
		return outs.err
	}
	res := Result{Notes: tr.Notes, PitchRange: tr.PitchRange, DurationSec: tr.DurationSec}
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, message(res))
	return nil
}
