package upscale

// gpuModel is the upscayl-bin model and flags for a preset at a scale
// (SPEC §5.1): -n Name -z ModelScale -s OutScale.
type gpuModel struct {
	Name       string
	ModelScale int
}

// cpuModel is the PyTorch model the AI engine runs (SPEC §13.3, verified sha256).
type cpuModel struct {
	File          string
	SHA256        string
	URL           string
	DownloadBytes int64
	SecondsPerMP  float64 // CPU estimate per input megapixel at 4× (this dev box)
}

type modelSpec struct {
	Label string
	Hint  string
	GPU   map[int]gpuModel // scale → model
	CPU   cpuModel
}

const esrgan = "https://github.com/xinntao/Real-ESRGAN/releases/download/"

var models = map[Model]modelSpec{
	ModelPhoto: {
		Label: "Photo", Hint: "Best for photos",
		GPU: map[int]gpuModel{2: {"realesrgan-x4plus", 4}, 4: {"realesrgan-x4plus", 4}},
		CPU: cpuModel{"RealESRGAN_x4plus.pth", "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
			esrgan + "v0.1.0/RealESRGAN_x4plus.pth", 67_040_989, 120},
	},
	ModelIllustration: {
		Label: "Illustration", Hint: "Line art, anime, screenshots & text",
		GPU: map[int]gpuModel{2: {"realesrgan-x4plus-anime", 4}, 4: {"realesrgan-x4plus-anime", 4}},
		CPU: cpuModel{"RealESRGAN_x4plus_anime_6B.pth", "f872d837d3c90ed2e05227bed711af5671a6fd1c9f7d7e91c911a61f155e99da",
			esrgan + "v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth", 17_938_799, 36},
	},
	ModelFast: {
		Label: "Fast", Hint: "Quickest, softer",
		GPU: map[int]gpuModel{2: {"realesr-animevideov3-x2", 2}, 4: {"realesr-animevideov3-x4", 4}},
		CPU: cpuModel{"realesr-animevideov3.pth", "b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d",
			esrgan + "v0.2.5.0/realesr-animevideov3.pth", 2_504_012, 4},
	},
}

// modelOrder is the UI order.
var modelOrder = []Model{ModelPhoto, ModelIllustration, ModelFast}

// ModelInfo describes a preset for the UI.
type ModelInfo struct {
	ID                  Model   `json:"id"`
	Label               string  `json:"label"`
	Hint                string  `json:"hint"`
	CPUDownloadBytes    int64   `json:"cpuDownloadBytes"`
	CPUSecondsPerMPixel float64 `json:"cpuSecondsPerMPixel"`
}

// ModelInfos lists the presets in UI order.
func ModelInfos() []ModelInfo {
	out := make([]ModelInfo, 0, len(modelOrder))
	for _, id := range modelOrder {
		m := models[id]
		out = append(out, ModelInfo{ID: id, Label: m.Label, Hint: m.Hint,
			CPUDownloadBytes: m.CPU.DownloadBytes, CPUSecondsPerMPixel: m.CPU.SecondsPerMP})
	}
	return out
}
