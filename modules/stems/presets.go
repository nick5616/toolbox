package stems

import "toolbox/core"

// presetSpec maps a preset to its audio-separator model (SPEC.md §6.1).
type presetSpec struct {
	Label         string
	Model         string
	DownloadBytes int64
	Stems         []string
	Speed         string
}

var presets = map[Preset]presetSpec{
	PresetVocalsFast: {"Vocals + instrumental · fast", "UVR-MDX-NET-Inst_HQ_3.onnx", 67_000_000, []string{"Vocals", "Instrumental"}, "fast"},
	PresetVocalsBest: {"Vocals + instrumental · best", "vocals_mel_band_roformer.ckpt", 913_000_000, []string{"Vocals", "Instrumental"}, "best"},
	PresetFourFast:   {"4 stems · fast", "htdemucs.yaml", 84_000_000, []string{"Vocals", "Drums", "Bass", "Other"}, "fast"},
	PresetFourBest:   {"4 stems · best", "htdemucs_ft.yaml", 337_000_000, []string{"Vocals", "Drums", "Bass", "Other"}, "best"},
}

// presetOrder is the UI order.
var presetOrder = []Preset{PresetFourFast, PresetFourBest, PresetVocalsFast, PresetVocalsBest}

// PresetInfos lists presets for the UI.
func PresetInfos() []core.PresetInfo {
	out := make([]core.PresetInfo, 0, len(presetOrder))
	for _, id := range presetOrder {
		p := presets[id]
		out = append(out, core.PresetInfo{
			ID: string(id), Label: p.Label, Kind: core.KindAudio,
			AcceptsKinds:  []core.OutputKind{core.KindAudio, core.KindVideo},
			DownloadBytes: p.DownloadBytes, Stems: append([]string(nil), p.Stems...), Speed: p.Speed,
		})
	}
	return out
}
