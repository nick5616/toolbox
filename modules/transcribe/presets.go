package transcribe

import "toolbox/core"

// modelSpec maps a model to its faster-whisper (CTranslate2) repo.
type modelSpec struct {
	Label         string
	Repo          string // Hugging Face repo ID
	DownloadBytes int64
	Speed         string // "fast" | "balanced" | "best"
}

var models = map[Model]modelSpec{
	ModelBase:  {"Base", "Systran/faster-whisper-base", 142_000_000, "fast"},
	ModelSmall: {"Small", "Systran/faster-whisper-small", 464_000_000, "balanced"},
	ModelTurbo: {"Large v3 Turbo", "mobiuslabsgmbh/faster-whisper-large-v3-turbo", 1_620_000_000, "best"},
}

// modelOrder is the UI order.
var modelOrder = []Model{ModelBase, ModelSmall, ModelTurbo}

// PresetInfos lists the models for the UI (ID = Model).
func PresetInfos() []core.PresetInfo {
	out := make([]core.PresetInfo, 0, len(modelOrder))
	for _, id := range modelOrder {
		m := models[id]
		out = append(out, core.PresetInfo{
			ID: string(id), Label: m.Label, Kind: core.KindDocument,
			AcceptsKinds:  []core.OutputKind{core.KindAudio, core.KindVideo},
			DownloadBytes: m.DownloadBytes, Speed: m.Speed,
		})
	}
	return out
}
