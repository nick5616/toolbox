package stems

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// Module is a core.ModelProvider (SPEC.md §7.8): presets download their
// audio-separator model into <models>/audio-separator/.
var _ core.ModelProvider = (*Module)(nil)

// SetModelsDir tells the module where models live. The pack service calls it
// (it knows the tools folder), so Register's signature stays unchanged.
func (m *Module) SetModelsDir(dir string) { m.modelsDir = dir }

func (m *Module) separatorDir() string { return filepath.Join(m.modelsDir, "audio-separator") }

var demucsSig = regexp.MustCompile(`['"]([0-9a-f]{8})['"]`)

// modelFiles returns the files making up a model and whether they all exist.
// Demucs models are a small .yaml naming checkpoints ("models: ['955717e8']")
// stored as <signature>-<hash>.th; other models are a single file.
func modelFiles(dir, model string) (files []string, complete bool) {
	main := filepath.Join(dir, model)
	if _, err := os.Stat(main); err != nil {
		return nil, false
	}
	files = []string{main}
	if !strings.HasSuffix(model, ".yaml") {
		return files, true
	}
	b, err := os.ReadFile(main)
	if err != nil {
		return files, false
	}
	var sigs []string
	for _, mt := range demucsSig.FindAllStringSubmatch(string(b), -1) {
		sigs = append(sigs, mt[1])
	}
	if len(sigs) == 0 {
		return files, false
	}
	for _, sig := range sigs {
		matches, _ := filepath.Glob(filepath.Join(dir, sig+"*.th"))
		if len(matches) == 0 {
			return files, false
		}
		files = append(files, matches...)
	}
	return files, true
}

// ModelPresent implements core.ModelProvider.
func (m *Module) ModelPresent(preset string) bool {
	p, ok := presets[Preset(preset)]
	if !ok || m.modelsDir == "" {
		return false
	}
	_, complete := modelFiles(m.separatorDir(), p.Model)
	return complete
}

// FetchModel implements core.ModelProvider via the engine's stems.prefetch.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	p, ok := presets[Preset(preset)]
	if !ok {
		return core.ValidationError("Unknown stem model", map[string]string{"preset": preset})
	}
	if m.ModelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	sink := newOutputs(job)
	_, err := m.sc.Call(ctx, "stems.prefetch", map[string]any{"model": p.Model}, sink.onEvent)
	if err != nil {
		return err
	}
	return nil
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error {
	p, ok := presets[Preset(preset)]
	if !ok || m.modelsDir == "" {
		return nil
	}
	files, _ := modelFiles(m.separatorDir(), p.Model)
	for _, f := range files {
		if err := os.Remove(f); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("removing %s: %w", filepath.Base(f), err)
		}
	}
	return nil
}
