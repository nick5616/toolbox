package converter

import (
	"encoding/json"
	"fmt"

	"toolbox/core"
)

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	fields := map[string]string{}
	p, ok := lookup(opts.Preset)
	if !ok {
		fields["preset"] = "Choose a format"
	}
	switch opts.MaxHeight {
	case HeightKeep, Height2160, Height1440, Height1080, Height720, Height480:
	default:
		fields["maxHeight"] = "Choose a valid maximum height"
	}
	if ok {
		for i, in := range inputs {
			kind := core.KindForPath(in)
			if !kindAccepted(p, kind) {
				fields[fmt.Sprintf("inputs.%d", i)] = fmt.Sprintf("%s can't take a %s file", p.Label, kind)
			}
		}
	}
	if len(fields) > 0 {
		return core.ValidationError("Check the highlighted fields", fields)
	}
	return nil
}

func kindAccepted(p presetSpec, k core.OutputKind) bool {
	for _, a := range p.Accepts {
		if a == k {
			return true
		}
	}
	return false
}
