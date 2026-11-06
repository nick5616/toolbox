package devutils

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (Phase 14): Checksums and Encode. Dev Utilities
// takes no drops (its descriptor accepts nothing) but, as a step, reads any
// file: the catalogue takes a Chainable module's Accepts from DescribeStep.

var _ core.Chainable = (*Module)(nil)

// StepOptions are what the user edits on a Dev Utilities step.
type StepOptions struct {
	Action     string   `json:"action"`     // ActionChecksums | ActionEncode
	Format     string   `json:"format"`     // checksums: FormatSidecar | FormatCSV
	Algorithms []string `json:"algorithms"` // checksums: any of AllAlgorithms(); default sha256, sha1, md5
	Encoding   string   `json:"encoding"`   // encode: EncodingBase64 | EncodingHex
	Name       string   `json:"name"`       // checksums: file name, takes {vars}; "" = the file's name, or "checksums"
}

// DefaultStepOptions: SHA-256, SHA-1 and MD5 in .sha256/.sha1/.md5 files.
func DefaultStepOptions() StepOptions {
	return StepOptions{Action: ActionChecksums, Format: FormatSidecar, Algorithms: []string{AlgoSHA256, AlgoSHA1, AlgoMD5}, Encoding: EncodingBase64}
}

func decodeStep(raw json.RawMessage) (StepOptions, error) {
	o := DefaultStepOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return o, nil
}

func (o StepOptions) job() Options {
	j := Options{Action: o.Action, Format: o.Format, Algorithms: slices.Clone(o.Algorithms), Encoding: o.Encoding, Name: o.Name}
	if o.Action == ActionEncode {
		j.Algorithms = nil
	}
	return j
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	info := core.StepInfo{
		Accepts: core.Accepts{Extensions: []string{}, Any: true},
		Vars:    []core.StepVar{}, Secrets: []core.StepSecret{}, Templates: []string{}, Warnings: []string{},
	}
	if err := checkActionOptions(o.job(), nil); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	switch o.Action {
	case ActionChecksums:
		ext, label := ".sha256", "Checksums"
		if o.Format == FormatCSV {
			ext = ".csv"
		} else if len(o.Algorithms) > 0 {
			ext = "." + o.Algorithms[0]
		}
		info.Produces = []core.StepProduct{{Role: "checksums", Label: label, Kind: core.KindOther, Exts: []string{ext}, Many: o.Format != FormatCSV && len(o.Algorithms) > 1}}
		info.Templates = []string{"/name"}
		for _, a := range o.Algorithms {
			info.Vars = append(info.Vars, core.StepVar{Name: a, Label: strings.ToUpper(a) + " of the file", Type: core.ValueText})
		}
		names := make([]string, len(o.Algorithms))
		for i, a := range o.Algorithms {
			names[i] = strings.ToUpper(a)
		}
		info.Summary = strings.Join(names, " · ")
		if o.Format == FormatCSV {
			info.Summary += " · CSV"
		}
	case ActionEncode:
		ext, label := ".base64.txt", "Base64"
		if o.Encoding == EncodingHex {
			ext, label = ".hex.txt", "Hex"
		}
		info.Produces = []core.StepProduct{{Role: "encoded", Label: label, Kind: core.KindDocument, Exts: []string{ext}}}
		info.Summary = label + " · files up to 10 MiB"
	default:
		return core.StepInfo{}, core.ValidationError("Choose Checksums or Encode", map[string]string{"action": "Choose Checksums or Encode"})
	}
	return info, nil
}

// plainProblem turns a field-validation error into one whose message is the
// field's message.
func plainProblem(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	for _, msg := range ae.Fields {
		return core.ValidationError(msg, ae.Fields)
	}
	return err
}

// PrepareStep implements core.Chainable: the item's files in one job per
// maxInputs; an encoded file over the size cap fails the step with its name.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if _, err := m.DescribeStep(req.Options); err != nil {
		return nil, err
	}
	if len(req.Item.Files) == 0 {
		return nil, core.ValidationError("There are no files to process", nil)
	}
	paths := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		if o.Action == ActionEncode {
			if err := checkEncodable(f.Path); err != nil {
				return nil, err
			}
		} else if st, err := os.Stat(f.Path); err != nil || !st.Mode().IsRegular() {
			return nil, core.ValidationError(filepath.Base(f.Path)+" can't be read", nil)
		}
		paths = append(paths, f.Path)
	}
	name := ""
	if o.Action == ActionChecksums && strings.TrimSpace(o.Name) != "" {
		name, _ = core.ExpandVars(o.Name, req.Item.Vars, core.FileVars(req.Item.Files[0]))
	}
	var jobs []core.StepJob
	for chunk := range slices.Chunk(paths, maxInputs) {
		j := o.job()
		j.Name = name
		jobs = append(jobs, core.StepJob{Inputs: slices.Clone(chunk), Options: j})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable: the written files with their role,
// and, for one checksummed file, its digests as variables.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	var o Options
	if job.OptionsJSON != "" {
		if err := json.Unmarshal([]byte(job.OptionsJSON), &o); err != nil {
			return res, fmt.Errorf("read dev utilities job options: %w", err)
		}
	}
	role, label := "checksums", "Checksums"
	if o.Action == ActionEncode {
		role, label = "encoded", "Encoded text"
	}
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: out.Kind, Role: role, RoleLabel: label, OutputID: out.ID})
	}
	if o.Action == ActionChecksums && strings.TrimSpace(job.ResultJSON) != "" {
		var r Result
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err == nil && len(r.Files) == 1 {
			for a, h := range r.Files[0].Hashes {
				if core.VarName.MatchString(a) {
					res.Vars[a] = h
				}
			}
		}
	}
	return res, nil
}
