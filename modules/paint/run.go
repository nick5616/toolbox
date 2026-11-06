package paint

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
)

// isStepOptions tells a pipeline step job from an export job: step options
// carry "action", export options carry "projectId" and "format".
func isStepOptions(raw json.RawMessage) bool {
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) != nil {
		return false
	}
	_, ok := probe["action"]
	return ok
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if isStepOptions(options) {
		return m.validateStepJob(inputs, options)
	}
	if len(inputs) != 0 {
		return core.ValidationError("An export takes no input files", nil)
	}
	_, _, err := m.decodeExport(context.Background(), options)
	return err
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	if isStepOptions(job.Options) {
		return m.runStep(ctx, job)
	}
	return m.runExport(ctx, job)
}

// validateStepJob checks a step job's options, project and input files.
func (m *Module) validateStepJob(inputs []string, options json.RawMessage) error {
	o, err := decodeStep(options)
	if err != nil {
		return err
	}
	if len(inputs) == 0 {
		return core.ValidationError("Choose at least one picture", nil)
	}
	for _, in := range inputs {
		if !slices.Contains(media.ImageExtensions(), strings.ToLower(filepath.Ext(in))) {
			return core.ValidationError(filepath.Base(in)+" isn't a picture", nil)
		}
		if fi, err := os.Stat(in); err != nil || fi.IsDir() {
			return core.Errorf(core.CodeNotFound, "%s doesn't exist", filepath.Base(in))
		}
	}
	return m.checkStepSources(context.Background(), o)
}

// checkStepSources checks that the project, layer and mask a step names exist.
func (m *Module) checkStepSources(ctx context.Context, o StepOptions) error {
	if o.Project != "" {
		doc, err := m.load(ctx, o.Project)
		if err != nil {
			return core.Errorf(core.CodeNotFound, "That painting no longer exists").WithCause(err)
		}
		if o.Action == StepDissolve && o.Layer != "" && !slices.ContainsFunc(doc.Layers, func(l PaintLayer) bool { return l.ID == o.Layer }) {
			return core.ValidationError("That layer no longer exists in the painting", map[string]string{"layer": "Missing"})
		}
	}
	if o.Action == StepDissolve && o.Layer == "" {
		if o.Mask == "" {
			return core.ValidationError("Choose a layer or a saved mask to dissolve with", nil)
		}
		if m.cfg.SavedMask == nil {
			return core.Errorf(core.CodeInternal, "Saved masks aren't available")
		}
		if _, err := m.cfg.SavedMask(o.Mask); err != nil {
			return err
		}
	}
	return nil
}
