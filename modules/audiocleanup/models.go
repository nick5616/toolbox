package audiocleanup

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// modelFile is one extracted .onnx file of the DeepFilterNet3 bundle.
type modelFile struct {
	Name   string
	Bytes  int64
	SHA256 string
}

// dfn3Model pins the DeepFilterNet3 tarball (SPEC.md §0.4); the engine
// verifies the tarball and then each extracted file.
var dfn3Model = struct {
	File, URL, SHA256 string
	Bytes             int64
	Files             []modelFile
}{
	File:   "DeepFilterNet3_onnx.tar.gz",
	URL:    "https://raw.githubusercontent.com/Rikorose/DeepFilterNet/d375b2d8309e0935d165700c91da9de862a99c31/models/DeepFilterNet3_onnx.tar.gz",
	SHA256: "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616",
	Bytes:  7983136,
	Files: []modelFile{
		{"enc.onnx", 1954042, "7c5399d3da8a50ebef1c1a0ae421b33376aa5e45d0e92df16da7e83c9c131916"},
		{"erb_dec.onnx", 3292397, "ab669a1d10afe20911728b33053a452071042317a90581092b325da7b2f9d895"},
		{"df_dec.onnx", 3340803, "23114ce3b0f6464b763ee62f7bb8aab6b2a129a21eabd5bcfe59413db05f278a"},
	},
}

// voiceModelDir is <models>/denoise/dfn3.
func (m *Module) voiceModelDir() string { return filepath.Join(m.modelsDir, "denoise", "dfn3") }

func (m *Module) modelPresent(preset string) bool {
	if preset != PresetVoice || m.modelsDir == "" {
		return false
	}
	for _, f := range dfn3Model.Files {
		fi, err := os.Stat(filepath.Join(m.voiceModelDir(), f.Name))
		if err != nil || !fi.Mode().IsRegular() || fi.Size() != f.Bytes {
			return false
		}
	}
	return true
}

// fetchModel downloads the model through the engine's denoise.prefetch.
func (m *Module) fetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	if preset != PresetVoice {
		return core.ValidationError("Unknown voice isolation model", map[string]string{"preset": preset})
	}
	if m.modelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	files := make([]map[string]any, 0, len(dfn3Model.Files))
	for _, f := range dfn3Model.Files {
		files = append(files, map[string]any{"name": f.Name, "sha256": f.SHA256})
	}
	_, err := m.sc.Call(ctx, "denoise.prefetch", map[string]any{
		"model":    map[string]any{"file": dfn3Model.File, "sha256": dfn3Model.SHA256, "url": dfn3Model.URL},
		"modelDir": m.voiceModelDir(),
		"files":    files,
	}, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			job.Progress(ev.Pct, ev.Msg)
		case "log":
			job.Log(core.StreamStdout, ev.Line)
		}
	})
	return err
}

// removeModel deletes the three model files.
func (m *Module) removeModel(preset string) error {
	if preset != PresetVoice || m.modelsDir == "" {
		return nil
	}
	for _, f := range dfn3Model.Files {
		if err := os.Remove(filepath.Join(m.voiceModelDir(), f.Name)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("removing the voice isolation model: %w", err)
		}
	}
	return nil
}
