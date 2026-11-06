package gif

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

// checkOptions validates the fields the chosen mode uses.
func checkOptions(o Options) error {
	switch o.Mode {
	case ModeGIF, ModeWebP:
		if math.IsNaN(o.StartSec) || o.StartSec < 0 || o.StartSec > 36000 {
			return fieldErr("The start must be between 0 and 36,000 seconds", "startSec")
		}
		if math.IsNaN(o.LengthSec) || o.LengthSec < MinLengthSec || o.LengthSec > MaxLengthSec {
			return fieldErr("A GIF can be 0.5 to 30 seconds long; trim a shorter part", "lengthSec")
		}
		if o.FPS < MinFPS || o.FPS > MaxFPS {
			return fieldErr("Frames per second must be between 1 and 30", "fps")
		}
		if o.Width < MinWidth || o.Width > MaxWidth {
			return fieldErr("Width must be between 120 and 1280 pixels", "width")
		}
	case ModeSheet:
		if o.Columns < 1 || o.Columns > MaxGrid {
			return fieldErr("Columns must be between 1 and 10", "columns")
		}
		if o.Rows < 1 || o.Rows > MaxGrid {
			return fieldErr("Rows must be between 1 and 10", "rows")
		}
		if o.Columns*o.Rows > MaxTiles {
			return fieldErr("A contact sheet can hold up to 100 frames", "rows")
		}
		if o.CellWidth < MinCellWidth || o.CellWidth > MaxCellWidth {
			return fieldErr("Frame width must be between 120 and 1280 pixels", "cellWidth")
		}
	default:
		return fieldErr("Choose GIF, WebP or contact sheet", "mode")
	}
	return nil
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) != 1 {
		return core.ValidationError("Choose one video", nil)
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
