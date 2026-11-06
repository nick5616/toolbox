package scenes

import (
	"encoding/json"
	"math"

	"toolbox/core"
	"toolbox/core/media"
)

// Accepts lists the input extensions (video only).
func Accepts() []string { return media.VideoExtensions() }

func fieldErr(msg, field string) error {
	return core.ValidationError(msg, map[string]string{field: msg})
}

// checkOptions validates everything that doesn't need the file.
func checkOptions(o Options) error {
	if math.IsNaN(o.Threshold) || o.Threshold < MinThreshold || o.Threshold > MaxThreshold {
		return fieldErr("Sensitivity must be between 0.05 and 0.9", "threshold")
	}
	if math.IsNaN(o.MinSceneSecs) || o.MinSceneSecs < MinSceneSecs || o.MinSceneSecs > MaxSceneSecs {
		return fieldErr("The shortest scene must be between 0.2 and 60 seconds", "minSceneSecs")
	}
	switch o.Output {
	case OutputClips, OutputStills, OutputBoth:
	default:
		return fieldErr("Choose clips, stills or both", "output")
	}
	switch o.Keep {
	case KeepAll:
	case KeepLongest, KeepActive:
		if o.KeepN < 1 || o.KeepN > MaxKeepN {
			return fieldErr("Keep between 1 and 200 scenes", "keepN")
		}
	default:
		return fieldErr("Choose which scenes to keep", "keep")
	}
	return nil
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) != 1 {
		return core.ValidationError("Choose one video to split", nil)
	}
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return checkOptions(opts)
}
