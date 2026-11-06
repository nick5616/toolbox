package tts

// The pinned Kokoro files (Phase 15 T1). The engine's tts.speak never
// downloads; FetchModel goes through tts.prefetch, which verifies the sha256.
// Model: Kokoro-82M v1.0, int8-quantised ONNX export by kokoro-onnx (Apache-2.0).

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// PresetKokoro is the ModelProvider preset holding the model and the voices.
const PresetKokoro = "kokoro"

type modelFile struct {
	File   string
	URL    string
	SHA256 string
	Bytes  int64
}

const releaseBase = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"

// kokoroFiles are downloaded in this order; both are needed.
var kokoroFiles = []modelFile{
	{
		File: "kokoro-v1.0.int8.onnx", URL: releaseBase + "kokoro-v1.0.int8.onnx",
		SHA256: "6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb", Bytes: 92_361_271,
	},
	{
		File: "voices-v1.0.bin", URL: releaseBase + "voices-v1.0.bin",
		SHA256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d", Bytes: 28_214_398,
	},
}

// TotalModelBytes is the download size of the Kokoro component.
func TotalModelBytes() int64 {
	var n int64
	for _, f := range kokoroFiles {
		n += f.Bytes
	}
	return n
}

// modelDir is <models>/tts.
func (m *Module) modelDir() string { return filepath.Join(m.modelsDir, "tts") }

func (m *Module) modelPath(f modelFile) string { return filepath.Join(m.modelDir(), f.File) }

func (m *Module) modelPresent(preset string) bool {
	if preset != PresetKokoro || m.modelsDir == "" {
		return false
	}
	for _, f := range kokoroFiles {
		fi, err := os.Stat(m.modelPath(f))
		if err != nil || !fi.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func (m *Module) fetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	if preset != PresetKokoro {
		return core.ValidationError("Unknown Text to Speech model", map[string]string{"preset": preset})
	}
	if m.modelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	var total, done float64
	for _, f := range kokoroFiles {
		total += float64(f.Bytes)
	}
	for _, f := range kokoroFiles {
		if _, err := os.Stat(m.modelPath(f)); err == nil {
			done += float64(f.Bytes)
			continue
		}
		sink := &eventSink{job: job, seen: map[string]bool{}, base: done / total, span: float64(f.Bytes) / total}
		_, err := m.sc.Call(ctx, "tts.prefetch", map[string]any{
			"model":    map[string]any{"file": f.File, "sha256": f.SHA256, "url": f.URL},
			"modelDir": m.modelDir(),
		}, sink.onEvent)
		if err != nil {
			return err
		}
		done += float64(f.Bytes)
	}
	return nil
}

func (m *Module) removeModel(preset string) error {
	if preset != PresetKokoro || m.modelsDir == "" {
		return nil
	}
	for _, f := range kokoroFiles {
		if err := os.Remove(m.modelPath(f)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("removing the Kokoro voices: %w", err)
		}
	}
	return nil
}

// requireModel fails with a dependency error when the voices aren't installed.
func (m *Module) requireModel() error {
	if m.modelPresent(PresetKokoro) {
		return nil
	}
	return core.Errorf(core.CodeDependencyMissing, "The Kokoro voices aren't installed").
		WithHint("Install the Speech tool pack in Settings")
}
