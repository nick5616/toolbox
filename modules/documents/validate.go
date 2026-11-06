package documents

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
)

const ocrHint = "Pandoc can't read PDFs. Use OCR to get the text, then convert that."

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	fields := optionFields(opts)
	to, ok := lookupFormat(opts.To)

	if len(inputs) == 0 {
		fields["inputs"] = "Add at least one file"
	}
	for i, in := range inputs {
		key := fmt.Sprintf("inputs.%d", i)
		ext := strings.ToLower(filepath.Ext(in))
		switch ext {
		case ".pdf":
			fields[key] = ocrHint
			continue
		case ".pptx":
			fields[key] = "PowerPoint files can't be read, only written"
			continue
		}
		if err := core.ValidateFileInputs([]string{in}, Accepts()); err != nil {
			if ae := core.AsAppError(err); ae != nil {
				for _, v := range ae.Fields {
					fields[key] = v
				}
			}
			continue
		}
		if src, found := inputFormat(ext); found && ok && src.Format == to.Format {
			fields[key] = fmt.Sprintf("This is already a %s file", to.Label)
		}
	}

	if len(fields) > 0 {
		e := core.ValidationError("Check the highlighted fields", fields)
		for _, v := range fields {
			if v == ocrHint {
				e = core.ValidationError(ocrHint, fields).WithHint("Open OCR, then send its text here.")
				break
			}
		}
		return e
	}
	return nil
}

// optionFields checks the option values (not the files) and returns the
// problem per field.
func optionFields(opts Options) map[string]string {
	fields := map[string]string{}
	if _, ok := lookupFormat(opts.To); !ok {
		fields["to"] = "Choose a format"
	}
	if opts.PageSize != "a4" && opts.PageSize != "letter" {
		fields["pageSize"] = "Choose A4 or Letter"
	}
	if opts.MarginMm < 10 || opts.MarginMm > 50 {
		fields["marginMm"] = "Margins must be between 10 and 50 mm"
	}
	if opts.FontSizePt < 9 || opts.FontSizePt > 16 {
		fields["fontSizePt"] = "Font size must be between 9 and 16 pt"
	}
	if opts.MainFont != "" && !media.ValidFont(opts.MainFont) {
		fields["mainFont"] = "Choose a font from the list"
	}
	if opts.ReferenceDoc != "" {
		if fi, err := os.Stat(opts.ReferenceDoc); err != nil || !filepath.IsAbs(opts.ReferenceDoc) || !fi.Mode().IsRegular() {
			fields["referenceDoc"] = "Style file not found"
		}
	}
	return fields
}

// checkOptions is optionFields as an error.
func checkOptions(opts Options) error {
	fields := optionFields(opts)
	if len(fields) == 0 {
		return nil
	}
	return plainProblem(core.ValidationError("Check the highlighted fields", fields))
}
