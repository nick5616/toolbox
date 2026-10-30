package visualizer

// The mood reader (SPEC.md §0.3, §4.1): paraphrase-multilingual-MiniLM-L12-v2,
// quantised per CPU, plus its tokenizer. Downloads are sha-verified by the
// engine's viz.prefetch.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// PresetMood is the ModelProvider preset of the mood reader.
const PresetMood = "mood"

type modelFile struct {
	File   string
	SHA256 string
	URL    string
	Bytes  int64
}

const moodRev = "https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/e8f8c211226b894fcb81acc59f3b34ba3efd5f42/"

var (
	moodModelAVX2 = modelFile{"model_quint8_avx2.onnx",
		"98a01d88b7de996cdea58c32ca71208c09968d143798814b2ea09d3439dc334f",
		moodRev + "onnx/model_quint8_avx2.onnx", 118_453_870}
	moodModelARM64 = modelFile{"model_qint8_arm64.onnx",
		"783fea82d71a58179b830a4dbd2d58447e640609e98eedf9ffa12622d375a672",
		moodRev + "onnx/model_qint8_arm64.onnx", 118_412_398}
	moodTokenizer = modelFile{"tokenizer.json",
		"2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8",
		moodRev + "tokenizer.json", 9_081_518}
)

// moodFiles are the files of the mood reader for an OS/CPU: the model, then
// the tokenizer.
func moodFiles(goos, goarch string) []modelFile {
	if goos == "darwin" && goarch == "arm64" {
		return []modelFile{moodModelARM64, moodTokenizer}
	}
	return []modelFile{moodModelAVX2, moodTokenizer}
}

func (m *Module) moodDir() string { return filepath.Join(m.modelsDir, "mood") }

// moodModel returns the model and tokenizer paths when both exist.
func (m *Module) moodModel() (model, tokenizer string, ok bool) {
	if !m.modelPresent(PresetMood) {
		return "", "", false
	}
	fs := moodFiles(runtime.GOOS, runtime.GOARCH)
	return filepath.Join(m.moodDir(), fs[0].File), filepath.Join(m.moodDir(), fs[1].File), true
}

func (m *Module) modelPresent(preset string) bool {
	if preset != PresetMood || m.modelsDir == "" {
		return false
	}
	for _, f := range moodFiles(runtime.GOOS, runtime.GOARCH) {
		fi, err := os.Stat(filepath.Join(m.moodDir(), f.File))
		if err != nil || !fi.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func (m *Module) fetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	if preset != PresetMood {
		return core.ValidationError("Unknown model", map[string]string{"preset": preset})
	}
	if m.modelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	files := []map[string]any{}
	for _, f := range moodFiles(runtime.GOOS, runtime.GOARCH) {
		files = append(files, map[string]any{"file": f.File, "sha256": f.SHA256, "url": f.URL})
	}
	_, err := m.sc.Call(ctx, "viz.prefetch", map[string]any{"files": files, "modelDir": m.moodDir()}, func(e sidecar.Event) {
		if e.Kind == "progress" {
			job.Progress(e.Pct, e.Msg)
		}
	})
	return err
}

func (m *Module) removeModel(preset string) error {
	if preset != PresetMood || m.modelsDir == "" {
		return nil
	}
	if err := os.RemoveAll(m.moodDir()); err != nil {
		return fmt.Errorf("removing the mood reader: %w", err)
	}
	return nil
}
