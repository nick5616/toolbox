package pipelines

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"toolbox/core"
)

// The core.Chainable methods of the built-in steps (SPEC.md §6.1, §7).

// StepDefaults implements core.Chainable.
func (s *step) StepDefaults() any {
	switch s.action {
	case ActionRename:
		return DefaultRename()
	case ActionChat:
		return DefaultChat()
	case ActionRun:
		return DefaultRun()
	case ActionTable:
		return DefaultTable()
	case ActionZip:
		return DefaultZip()
	default:
		return DefaultCopy()
	}
}

// decodeStep decodes step options strictly over the defaults.
func decodeStep[T any](raw json.RawMessage, def T) (T, error) {
	v := def
	if len(bytes.TrimSpace(raw)) == 0 {
		return v, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		return def, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return v, nil
}

func ellipsize(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

// DescribeStep implements core.Chainable.
func (s *step) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	anyFile := core.Accepts{Extensions: []string{}, Any: true}
	switch s.action {
	case ActionRename:
		o, err := decodeStep(options, DefaultRename())
		if err != nil {
			return core.StepInfo{}, err
		}
		if strings.TrimSpace(o.Template) == "" {
			return core.StepInfo{}, core.ValidationError("Type the new name, e.g. {name}", map[string]string{"template": "Type the new name"})
		}
		return core.StepInfo{Accepts: anyFile, Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
			Templates: []string{"/template"}, Warnings: []string{}, Summary: "Rename to " + ellipsize(o.Template, 60)}, nil
	case ActionChat:
		return s.describeChat(options)
	case ActionRun:
		return s.describeRun(options)
	case ActionTable:
		return s.describeTable(options)
	case ActionZip:
		o, err := decodeStep(options, DefaultZip())
		if err != nil {
			return core.StepInfo{}, err
		}
		if strings.TrimSpace(o.Name) == "" {
			return core.StepInfo{}, core.ValidationError("Type a name for the zip file", map[string]string{"name": "Type a name"})
		}
		summary := "One zip per item"
		if o.Together {
			summary = "One zip for the run"
		}
		return core.StepInfo{Accepts: anyFile, Together: o.Together,
			Produces: []core.StepProduct{{Role: "zip", Label: "Zip", Kind: core.KindOther, Exts: []string{".zip"}}},
			Vars:     []core.StepVar{}, Secrets: []core.StepSecret{},
			Templates: []string{"/name"}, Warnings: []string{}, Summary: summary}, nil
	default:
		o, err := decodeStep(options, DefaultCopy())
		if err != nil {
			return core.StepInfo{}, err
		}
		if err := s.m.checkFolder(o.Folder, true); err != nil {
			return core.StepInfo{}, err
		}
		for _, seg := range strings.FieldsFunc(o.Subfolder, func(r rune) bool { return r == '/' || r == '\\' }) {
			if strings.TrimSpace(seg) == ".." {
				return core.StepInfo{}, core.ValidationError("The subfolder can't go up a level", map[string]string{"subfolder": "Remove .."})
			}
		}
		return core.StepInfo{Accepts: anyFile, Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
			Templates: []string{"/subfolder"}, Warnings: []string{}, Summary: "Copy to " + o.Folder}, nil
	}
}

func (s *step) describeChat(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options, DefaultChat())
	if err != nil {
		return core.StepInfo{}, err
	}
	job := ChatJob{Mode: o.Mode, System: o.System, Prompt: o.Prompt, Fields: o.Fields, Format: o.Format, Temperature: o.Temperature}
	if err := validateChatJob(job); err != nil {
		return core.StepInfo{}, err
	}
	info := core.StepInfo{Accepts: core.Accepts{Extensions: textExts}, NoFiles: true, Secrets: []core.StepSecret{},
		Templates: []string{"/prompt", "/system"}, Warnings: []string{}}
	if o.Mode == ChatWrite {
		if strings.TrimSpace(o.OutputName) == "" {
			return core.StepInfo{}, core.ValidationError("Type a name for the notes file", map[string]string{"outputName": "Type a name"})
		}
		info.Templates = append(info.Templates, "/outputName")
		ext, label := ".md", "Markdown"
		if o.Format == FormatTXT {
			ext, label = ".txt", "Text"
		}
		info.Produces = []core.StepProduct{{Role: "text", Label: "Text", Kind: core.KindDocument, Exts: []string{ext}}}
		info.Vars = []core.StepVar{{Name: "reply", Label: "Chat reply"}}
		info.Summary = "Write notes (" + label + ")"
	} else {
		info.Produces = []core.StepProduct{}
		if o.SaveJSON {
			info.Produces = append(info.Produces, core.StepProduct{Role: "json", Label: "JSON", Kind: core.KindDocument, Exts: []string{".json"}})
		}
		info.Vars = make([]core.StepVar, len(o.Fields))
		for i, f := range o.Fields {
			info.Vars[i] = core.StepVar{Name: f.Name, Label: f.Label}
		}
		noun := "fields"
		if len(o.Fields) == 1 {
			noun = "field"
		}
		info.Summary = fmt.Sprintf("Extract %d %s", len(o.Fields), noun)
	}
	if s.m.tg == nil {
		info.Warnings = append(info.Warnings, "Local Chat isn't available")
	} else if _, err := s.m.tg.Ready(); err != nil {
		msg := err.Error()
		var ae *core.AppError
		if errors.As(err, &ae) {
			msg = ae.Message
			if ae.Hint != "" {
				msg += " · " + ae.Hint
			}
		}
		info.Warnings = append(info.Warnings, msg)
	}
	return info, nil
}

func (s *step) describeTable(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options, DefaultTable())
	if err != nil {
		return core.StepInfo{}, err
	}
	if len(o.Columns) < 1 || len(o.Columns) > maxTableCols {
		return core.StepInfo{}, core.ValidationError(fmt.Sprintf("A table has 1 to %d columns", maxTableCols), nil)
	}
	if strings.TrimSpace(o.Name) == "" {
		return core.StepInfo{}, core.ValidationError("Type a name for the table file", map[string]string{"name": "Type a name"})
	}
	templates := []string{"/name"}
	for i, c := range o.Columns {
		if strings.TrimSpace(c.Header) == "" {
			return core.StepInfo{}, core.ValidationError(fmt.Sprintf("Column %d needs a heading", i+1), nil)
		}
		templates = append(templates, fmt.Sprintf("/columns/%d/value", i))
	}
	return core.StepInfo{Accepts: core.Accepts{Extensions: []string{}}, NoFiles: true, Together: true,
		Produces: []core.StepProduct{{Role: "table", Label: "Table", Kind: core.KindDocument, Exts: []string{".csv"}}},
		Vars:     []core.StepVar{}, Secrets: []core.StepSecret{},
		Templates: templates, Warnings: []string{}, Summary: fmt.Sprintf("CSV · %d columns", len(o.Columns))}, nil
}

// ---- PrepareStep ----------------------------------------------------------

// PrepareStep implements core.Chainable.
func (s *step) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	if _, err := s.DescribeStep(req.Options); err != nil {
		return nil, err
	}
	switch s.action {
	case ActionRename:
		o, _ := decodeStep(req.Options, DefaultRename())
		return s.prepareRename(req, o)
	case ActionChat:
		o, _ := decodeStep(req.Options, DefaultChat())
		return s.prepareChat(req, o)
	case ActionRun:
		return s.prepareRun(ctx, req)
	case ActionTable:
		o, _ := decodeStep(req.Options, DefaultTable())
		return s.prepareTable(req, o)
	case ActionZip:
		o, _ := decodeStep(req.Options, DefaultZip())
		return s.prepareZip(req, o)
	default:
		o, _ := decodeStep(req.Options, DefaultCopy())
		return s.prepareCopy(req, o)
	}
}

func (s *step) prepareRename(req core.StepRequest, o RenameStep) ([]core.StepJob, error) {
	files := req.Item.Files
	if len(files) == 0 {
		return nil, core.ValidationError("There are no files to rename", nil)
	}
	ops := make([]RenameOp, 0, len(files))
	for _, f := range files {
		name, _ := core.ExpandVars(o.Template, req.Item.Vars, core.FileVars(f))
		ops = append(ops, RenameOp{
			Path: f.Path, Name: name, Move: f.OutputID != "", Role: f.Role, RoleLabel: f.RoleLabel, OutputID: f.OutputID,
		})
	}
	var jobs []core.StepJob
	for chunk := range slices.Chunk(ops, maxOpsPerJob) {
		inputs := make([]string, len(chunk))
		for i, op := range chunk {
			inputs[i] = op.Path
		}
		jobs = append(jobs, core.StepJob{Inputs: inputs, Options: Options{Action: ActionRename, Pipeline: req.Pipeline, Rename: slices.Clone(chunk)}})
	}
	return jobs, nil
}

func (s *step) prepareChat(req core.StepRequest, o ChatStep) ([]core.StepJob, error) {
	used := core.TemplateVars(o.Prompt)
	for _, n := range core.TemplateVars(o.System) {
		if !slices.Contains(used, n) {
			used = append(used, n)
		}
	}
	vars := map[string]string{}
	for _, n := range used {
		if n == "file" {
			continue
		}
		if v, ok := req.Item.Vars[n]; ok {
			vars[n], _ = core.CapVar(v)
		}
	}
	inputs := []string{}
	if slices.Contains(used, "file") {
		var texts []string
		for _, f := range req.Item.Files {
			if !slices.Contains(textExts, strings.ToLower(filepath.Ext(f.Path))) {
				continue
			}
			t, err := readTextFile(f.Path)
			if err != nil {
				return nil, err
			}
			if t != "" {
				texts = append(texts, t)
			}
			inputs = append(inputs, f.Path)
		}
		vars["file"], _ = core.CapVar(strings.Join(texts, "\n\n"))
	}
	c := ChatJob{
		Mode: o.Mode, System: o.System, Prompt: o.Prompt, Vars: vars, Fields: []ChatField{}, Format: o.Format,
		SaveJSON: o.SaveJSON, Temperature: o.Temperature, Label: req.Pipeline,
	}
	if o.Mode == ChatWrite {
		c.OutputName, _ = core.ExpandVars(o.OutputName, req.Item.Vars)
	} else {
		c.Fields = append(c.Fields, o.Fields...)
		c.OutputName = req.Item.Vars["item"]
		if c.OutputName == "" {
			c.OutputName = req.Item.Label
		}
	}
	return []core.StepJob{{Inputs: inputs, Options: Options{Action: ActionChat, Pipeline: req.Pipeline, Chat: &c}}}, nil
}

// runBuiltins are the variables a table name may use: the run's own.
func runBuiltins(req core.StepRequest, vars map[string]string) map[string]string {
	started := time.Now()
	if req.Started > 0 {
		started = time.UnixMilli(req.Started)
	}
	m := map[string]string{
		"pipeline": req.Pipeline,
		"date":     started.Format("2006-01-02"),
		"time":     started.Format("15-04"),
	}
	for _, k := range []string{"pipeline", "date", "time"} {
		if v, ok := vars[k]; ok && v != "" {
			m[k] = v
		}
	}
	return m
}

func itemsOf(req core.StepRequest) []core.StepItem {
	if len(req.Items) > 0 {
		return req.Items
	}
	return []core.StepItem{req.Item}
}

func (s *step) prepareTable(req core.StepRequest, o TableStep) ([]core.StepJob, error) {
	items := itemsOf(req)
	header := make([]string, len(o.Columns))
	for i, c := range o.Columns {
		header[i] = c.Header
	}
	rows := make([][]string, 0, len(items))
	for _, it := range items {
		row := make([]string, len(o.Columns))
		for i, c := range o.Columns {
			row[i], _ = core.ExpandVars(c.Value, it.Vars)
		}
		rows = append(rows, row)
	}
	name, _ := core.ExpandVars(o.Name, runBuiltins(req, items[0].Vars))
	return []core.StepJob{{Inputs: []string{}, Options: Options{Action: ActionTable, Pipeline: req.Pipeline, Table: &TableJob{Name: name, Header: header, Rows: rows}}}}, nil
}

func (s *step) prepareZip(req core.StepRequest, o ZipStep) ([]core.StepJob, error) {
	items := []core.StepItem{req.Item}
	vars := req.Item.Vars
	if o.Together {
		items = itemsOf(req)
		if len(vars) == 0 {
			vars = items[0].Vars
		}
	}
	var files []string
	for _, it := range items {
		for _, f := range it.Files {
			if !slices.Contains(files, f.Path) {
				files = append(files, f.Path)
			}
		}
	}
	if len(files) == 0 {
		return nil, core.ValidationError("There are no files to zip", nil)
	}
	name, _ := core.ExpandVars(o.Name, runBuiltins(req, vars), vars)
	return []core.StepJob{{Inputs: slices.Clone(files), Options: Options{Action: ActionZip, Pipeline: req.Pipeline, Zip: &ZipJob{Name: name, Files: files}}}}, nil
}

func (s *step) prepareCopy(req core.StepRequest, o CopyStep) ([]core.StepJob, error) {
	if err := s.m.checkFolder(o.Folder, true); err != nil {
		return nil, err
	}
	files := req.Item.Files
	if len(files) == 0 {
		return nil, core.ValidationError("There are no files to copy", nil)
	}
	sub, _ := core.ExpandVars(o.Subfolder, req.Item.Vars)
	dest := subfolderPath(o.Folder, sub)
	var jobs []core.StepJob
	for chunk := range slices.Chunk(files, maxOpsPerJob) {
		cj := CopyJob{Folder: dest, Files: make([]string, len(chunk)), Carry: make([]CarriedFile, len(chunk))}
		for i, f := range chunk {
			cj.Files[i] = f.Path
			cj.Carry[i] = CarriedFile{Role: f.Role, RoleLabel: f.RoleLabel, OutputID: f.OutputID}
		}
		jobs = append(jobs, core.StepJob{Inputs: slices.Clone(cj.Files), Options: Options{Action: ActionCopy, Pipeline: req.Pipeline, Copy: &cj}})
	}
	return jobs, nil
}

// ---- StepOutputs ----------------------------------------------------------

// StepOutputs implements core.Chainable. Every built-in job records a result
// listing its files and variables (moved or copied files aren't job outputs).
func (s *step) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	if strings.TrimSpace(job.ResultJSON) == "" {
		return res, nil
	}
	var jr jobResult
	if err := json.Unmarshal([]byte(job.ResultJSON), &jr); err != nil {
		return res, fmt.Errorf("reading the result of job %s: %w", job.ID, err)
	}
	if jr.Files != nil {
		res.Files = jr.Files
	}
	for k, v := range jr.Vars {
		res.Vars[k] = v
	}
	if s.action == ActionChat {
		for _, f := range res.Files {
			if f.Role != "text" {
				continue
			}
			reply, err := readReply(f.Path)
			if err != nil {
				return res, err
			}
			res.Vars["reply"] = reply
			break
		}
	}
	return res, nil
}

// readReply reads a saved chat reply (≤ 256 KiB).
func readReply(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("reading the chat reply: %w", err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxTextFileBytes))
	if err != nil {
		return "", fmt.Errorf("reading the chat reply: %w", err)
	}
	return strings.TrimSpace(strings.ToValidUTF8(string(b), "")), nil
}
