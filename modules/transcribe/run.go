package transcribe

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/sidecar"
)

func validateOptions(o Options) error {
	fields := map[string]string{}
	if _, ok := models[o.Model]; !ok {
		fields["model"] = "Choose a valid model"
	}
	if o.Task != TaskTranscribe && o.Task != TaskTranslate {
		fields["task"] = "Choose transcribe or translate"
	}
	if o.Language != "" && !slices.ContainsFunc(Languages(), func(l Language) bool { return l.Code == o.Language }) {
		fields["language"] = "Choose a listed language or auto-detect"
	}
	all := AllFormats()
	if len(o.Formats) == 0 {
		fields["formats"] = "Choose at least one output format"
	} else {
		seen := map[string]bool{}
		for _, f := range o.Formats {
			if !slices.Contains(all, f) {
				fields["formats"] = "Unknown output format: " + f
				break
			}
			if seen[f] {
				fields["formats"] = "Each output format can be chosen once"
				break
			}
			seen[f] = true
		}
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

// languageName returns the display name for a code, or the upper-cased code.
func languageName(code string) string {
	for _, l := range Languages() {
		if l.Code == code {
			return l.Name
		}
	}
	return strings.ToUpper(code)
}

// clock formats seconds as m:ss, or h:mm:ss from one hour up.
func clock(sec float64) string {
	t := int(sec)
	if t < 0 {
		t = 0
	}
	h, m, s := t/3600, t%3600/60, t%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

func summary(r Result) string {
	noun := "segments"
	if r.Segments == 1 {
		noun = "segment"
	}
	return fmt.Sprintf("%s · %s · %d %s", languageName(r.Language), clock(r.DurationSec), r.Segments, noun)
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
	var language any // nil = auto-detect
	if o.Language != "" {
		language = o.Language
	}
	params := map[string]any{
		"input":     input,
		"outputDir": job.OutputDir,
		"baseName":  core.StemName(input),
		"model":     models[o.Model].Repo,
		"modelDir":  filepath.Join(m.modelsDir, "whisper", string(o.Model)),
		"language":  language,
		"task":      string(o.Task),
		"formats":   o.Formats,
		"vad":       o.VAD,
	}
	outs := newOutputs(job)
	raw, err := m.sc.Call(ctx, "transcribe.run", params, outs.onEvent)
	if err != nil {
		return err
	}
	var res Result
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The audio engine returned an unreadable result").WithCause(err)
	}
	for _, p := range res.Outputs {
		outs.register(p)
	}
	if outs.err != nil {
		return outs.err
	}
	if res.Outputs == nil {
		res.Outputs = []string{}
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, summary(res))
	return nil
}
