package bgremove

import (
	"path/filepath"

	"toolbox/core"
)

// ModelKind selects the pre/post-processing in the engine.
type ModelKind string

const (
	KindBiRefNet ModelKind = "birefnet"
	KindISNet    ModelKind = "isnet"
)

// modelSpec is one downloadable ONNX model (SPEC §0, verified sha256).
type modelSpec struct {
	Label         string
	File          string
	SHA256        string
	URL           string
	Kind          ModelKind
	DownloadBytes int64
	Speed         string // "fast" | "balanced" | "best"
}

const modelBase = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/"

var models = map[Model]modelSpec{
	ModelFast: {"Fast", "isnet-general-use.onnx",
		"60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
		modelBase + "isnet-general-use.onnx", KindISNet, 178_648_008, "fast"},
	ModelBalanced: {"Balanced", "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
		"5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
		modelBase + "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx", KindBiRefNet, 224_005_088, "balanced"},
	ModelBest: {"Best", "BiRefNet-general-epoch_244.onnx",
		"58f621f00f5d756097615970a88a791584600dcf7c45b18a0a6267535a1ebd3c",
		modelBase + "BiRefNet-general-epoch_244.onnx", KindBiRefNet, 972_666_916, "best"},
}

// modelOrder is the UI order.
var modelOrder = []Model{ModelFast, ModelBalanced, ModelBest}

// PresetInfos lists the models for the UI (ID = Model).
func PresetInfos() []core.PresetInfo {
	out := make([]core.PresetInfo, 0, len(modelOrder))
	for _, id := range modelOrder {
		m := models[id]
		out = append(out, core.PresetInfo{
			ID: string(id), Label: m.Label, Kind: core.KindImage, Ext: ".png",
			AcceptsKinds:  []core.OutputKind{core.KindImage},
			DownloadBytes: m.DownloadBytes, Speed: m.Speed,
		})
	}
	return out
}

// ModelSpec is a pinned background-removal model, exported for Edit Studio's
// photo cut-outs (which call bgremove.run with output "mask").
type ModelSpec struct {
	File   string
	SHA256 string
	URL    string
	Kind   string
}

// SpecFor returns the pinned model of a preset ("fast" | "balanced" | "best").
func SpecFor(preset string) (ModelSpec, bool) {
	m, ok := models[Model(preset)]
	if !ok {
		return ModelSpec{}, false
	}
	return ModelSpec{File: m.File, SHA256: m.SHA256, URL: m.URL, Kind: string(m.Kind)}, true
}

// ModelDir is where background-removal models live under the models folder.
func ModelDir(modelsDir string) string { return filepath.Join(modelsDir, "bg") }
