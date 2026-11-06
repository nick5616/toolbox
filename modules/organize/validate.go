package organize

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
)

// optionFields checks the option values (not the inputs).
func optionFields(o Options) map[string]string {
	fields := map[string]string{}
	switch o.GroupBy {
	case GroupDate, GroupType, GroupCamera:
	case GroupPattern:
		if err := validatePattern(o.Pattern); err != nil {
			if ae := core.AsAppError(err); ae != nil {
				fields["pattern"] = ae.Message
			}
		}
	default:
		fields["groupBy"] = "Choose how to group the files"
	}
	switch o.Duplicates {
	case DupOff, DupExact:
	case DupSimilar:
		if o.Similarity < MinSimilarity || o.Similarity > MaxSimilarity {
			fields["similarity"] = fmt.Sprintf("Similarity must be between %d and %d", MinSimilarity, MaxSimilarity)
		}
	default:
		fields["duplicates"] = "Choose how to find duplicates"
	}
	switch o.DupAction {
	case ActionFolder, ActionSkip:
	default:
		fields["dupAction"] = "Choose what to do with duplicates"
	}
	if o.Destination != "" && !filepath.IsAbs(o.Destination) {
		fields["destination"] = "Choose a folder"
	}
	if o.RunName != "" && sanitizeComponent(o.RunName) != o.RunName {
		fields["runName"] = `The name can't contain \ / : * ? " < > |`
	}
	return fields
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	fields := optionFields(opts)
	if len(inputs) == 0 {
		fields["inputs"] = "Add at least one file or folder"
	}
	for i, in := range inputs {
		key := fmt.Sprintf("inputs.%d", i)
		switch {
		case !filepath.IsAbs(in):
			fields[key] = "File not found"
		default:
			if _, err := os.Stat(in); err != nil {
				fields[key] = "File or folder not found"
			}
		}
	}
	if len(fields) > 0 {
		return core.ValidationError("Check the highlighted fields", fields)
	}
	if opts.Destination != "" {
		if err := checkRoot(opts.Destination, inputs); err != nil {
			return err
		}
	}
	return nil
}
