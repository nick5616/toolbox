package redact

// The pinned detector models (SPEC.md §0.4). The engine's run handlers never
// download; FetchModel goes through redact.prefetch, which verifies the sha256.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

type modelSpec struct {
	Label  string
	File   string
	URL    string
	SHA256 string
	Bytes  int64
}

var models = map[string]modelSpec{
	PresetFaces: {
		Label: "Face detection (YuNet)",
		File:  "face_detection_yunet_2023mar.onnx",
		URL:   "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
		// 232,589 bytes
		SHA256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
		Bytes:  232_589,
	},
	PresetPlates: {
		Label: "Number-plate detection (YOLOv9-t)",
		File:  "yolo-v9-t-640-license-plates-end2end.onnx",
		URL:   "https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-640-license-plates-end2end.onnx",
		// 7,835,770 bytes
		SHA256: "c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076",
		Bytes:  7_835_770,
	},
}

// modelDir is <models>/redact.
func (m *Module) modelDir() string { return filepath.Join(m.modelsDir, "redact") }

func (m *Module) modelPath(spec modelSpec) string { return filepath.Join(m.modelDir(), spec.File) }

func (m *Module) modelPresent(preset string) bool {
	spec, ok := models[preset]
	if !ok || m.modelsDir == "" {
		return false
	}
	fi, err := os.Stat(m.modelPath(spec))
	return err == nil && fi.Mode().IsRegular()
}

func (m *Module) fetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	spec, ok := models[preset]
	if !ok {
		return core.ValidationError("Unknown Redact model", map[string]string{"preset": preset})
	}
	if m.modelPresent(preset) {
		return nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	sink := &eventSink{job: job, seen: map[string]bool{}, span: 1}
	_, err := m.sc.Call(ctx, "redact.prefetch", map[string]any{
		"model":    map[string]any{"file": spec.File, "sha256": spec.SHA256, "url": spec.URL},
		"modelDir": m.modelDir(),
	}, sink.onEvent)
	return err
}

func (m *Module) removeModel(preset string) error {
	spec, ok := models[preset]
	if !ok || m.modelsDir == "" {
		return nil
	}
	if err := os.Remove(m.modelPath(spec)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing the %s model: %w", spec.Label, err)
	}
	return nil
}

// requireModels fails with a dependency error naming what is missing.
func (m *Module) requireModels(faces, plates bool) error {
	switch {
	case faces && !m.modelPresent(PresetFaces):
		return core.Errorf(core.CodeDependencyMissing, "The face detection model isn't installed").
			WithHint("Install the Image tool pack in Settings")
	case plates && !m.modelPresent(PresetPlates):
		return core.Errorf(core.CodeDependencyMissing, "The number-plate detection model isn't installed").
			WithHint("Install the Image tool pack in Settings")
	}
	return nil
}
