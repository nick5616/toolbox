package bgremove

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

func validateOptions(o Options) error {
	fields := map[string]string{}
	if _, ok := models[o.Model]; !ok {
		fields["model"] = "Choose a valid model"
	}
	switch o.Output {
	case OutputTransparent, OutputMask:
	case OutputColor:
		if !HexColor.MatchString(o.Color) {
			fields["color"] = "Choose a colour like #ffffff"
		}
	default:
		fields["output"] = "Choose transparent, colour or mask"
	}
	if o.Padding < MinPadding || o.Padding > MaxPadding {
		fields["padding"] = fmt.Sprintf("Padding must be between %d and %d px", MinPadding, MaxPadding)
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

// eventSink maps sidecar events onto a job and registers each output once.
type eventSink struct {
	job  *core.JobContext
	seen map[string]bool
	err  error
}

func (o *eventSink) register(path string) {
	if path == "" || o.seen[path] {
		return
	}
	o.seen[path] = true
	if _, err := o.job.Output(path); err != nil && o.err == nil {
		o.err = err
	}
}

func (o *eventSink) onEvent(ev sidecar.Event) {
	switch ev.Kind {
	case "progress":
		o.job.Progress(ev.Pct, ev.Msg)
	case "log":
		stream := core.StreamStdout
		if ev.Level == "warning" || ev.Level == "error" {
			stream = core.StreamStderr
		}
		o.job.Log(stream, ev.Line)
	case "output":
		o.register(ev.Path)
	}
}

// summary is the final job message.
func summary(r Result) string {
	if r.SubjectCoverage < 0.005 {
		return "No clear subject found"
	}
	return fmt.Sprintf("Subject covers %d%% · %d×%d", int(r.SubjectCoverage*100+0.5), r.Width, r.Height)
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
	spec := models[o.Model]
	params := map[string]any{
		"input":     input,
		"outputDir": job.OutputDir,
		"baseName":  core.StemName(input),
		"model": map[string]any{
			"file": spec.File, "sha256": spec.SHA256, "url": spec.URL, "kind": string(spec.Kind),
		},
		"modelDir":   filepath.Join(m.modelsDir, "bg"),
		"output":     string(o.Output),
		"color":      o.Color,
		"crop":       o.Crop,
		"padding":    o.Padding,
		"cleanEdges": o.CleanEdges,
		"refine":     o.Refine,
	}
	sink := &eventSink{job: job, seen: map[string]bool{}}
	raw, err := m.sc.Call(ctx, "bgremove.run", params, sink.onEvent)
	if err != nil {
		return err
	}
	var res Result
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	res.Model = o.Model // the engine reports the model file; the UI wants the preset
	sink.register(res.Output)
	if sink.err != nil {
		return sink.err
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, summary(res))
	return nil
}
