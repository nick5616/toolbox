package ocr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2): one submission with every file of the
// item; the module splits it into one job per file.

var _ core.Chainable = (*Module)(nil)

// maxReadBytes is how much of the text output is read into a variable.
const maxReadBytes = 1 << 20

// decodeStep decodes step options strictly over the defaults, then fills
// anything left empty (the module's own withDefaults).
func decodeStep(raw json.RawMessage) (Options, error) {
	o := DefaultOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return withDefaults(o), nil
}

func plainProblem(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	keys := make([]string, 0, len(ae.Fields))
	for k := range ae.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return core.ValidationError(ae.Fields[keys[0]], ae.Fields)
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// makesText reports whether any input type gets a .txt output.
func makesText(o Options) bool {
	return o.ImageOutput == ImageText || o.PDFOutput == PDFText || o.PDFOutput == PDFBoth
}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := validateOptions(o); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	text := core.StepProduct{Role: "text", Label: "Text", Kind: core.KindDocument, Exts: []string{".txt"}}
	var products []core.StepProduct
	if o.ImageOutput == ImageJSON {
		products = append(products, core.StepProduct{Role: "json", Label: "Text with positions", Kind: core.KindDocument, Exts: []string{".json"}})
	}
	if makesText(o) {
		products = append(products, text)
	}
	if o.PDFOutput == PDFSearchable || o.PDFOutput == PDFBoth {
		products = append(products, core.StepProduct{Role: "pdf", Label: "Searchable PDF", Kind: core.KindDocument, Exts: []string{".pdf"}})
	}
	vars := []core.StepVar{}
	if makesText(o) {
		vars = append(vars, core.StepVar{Name: "text", Label: "Recognised text", Type: core.ValueText})
	}

	pdf := map[PDFOutput]string{PDFSearchable: "searchable PDF", PDFText: "text", PDFBoth: "searchable PDF + text"}[o.PDFOutput]
	img := map[ImageOutput]string{ImageText: "text", ImageJSON: "text + positions"}[o.ImageOutput]
	lang := string(o.Language)
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: products,
		Vars:     vars,
		Summary:  strings.ToUpper(lang[:1]) + lang[1:] + " · PDFs: " + pdf + " · images: " + img,
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	inputs := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		inputs = append(inputs, f.Path)
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("There's no file to read", nil)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal ocr options: %w", err)
	}
	if err := m.Validate(inputs, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	textPath := ""
	for _, out := range job.Outputs {
		f := core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID}
		switch strings.ToLower(filepath.Ext(out.Path)) {
		case ".pdf":
			f.Role, f.RoleLabel = "pdf", "Searchable PDF"
		case ".txt":
			f.Role, f.RoleLabel = "text", "Text"
			if textPath == "" {
				textPath = out.Path
			}
		case ".json":
			f.Role, f.RoleLabel = "json", "Text with positions"
		}
		res.Files = append(res.Files, f)
	}
	if textPath != "" {
		if txt, ok := readText(textPath); ok {
			res.Vars["text"], _ = core.CapVar(strings.TrimSpace(txt))
		}
	}
	return res, nil
}

// readText reads at most 1 MiB of a file.
func readText(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxReadBytes))
	if err != nil {
		return "", false
	}
	return string(b), true
}
