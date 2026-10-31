package pipelines

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// textExts are the files the chat step reads (SPEC.md §7.3).
var textExts = []string{".txt", ".md", ".srt", ".vtt", ".json", ".csv"}

type builtinType struct {
	t core.StepType
	a core.Chainable
}

// builtins lists the built-in step types in menu order (SPEC.md §11.3).
func (m *Module) builtins() []builtinType {
	anyFile := core.Accepts{Extensions: []string{}, Any: true}
	mk := func(id, name, icon, desc string, acc core.Accepts, defaults any, a core.Chainable) builtinType {
		b, _ := json.Marshal(defaults)
		return builtinType{
			t: core.StepType{ID: id, ModuleID: ModuleID, Name: name, Icon: icon, Category: core.CategoryUtility,
				Description: desc, Auto: a != nil, Builtin: true, Accepts: acc, DefaultsJSON: string(b)},
			a: a,
		}
	}
	check := mk(TypeCheck, "Check", "eye", "Pause so you can look at the files and drop any you don't want", anyFile, struct{}{}, nil)
	check.t.ModuleID = ""
	check.t.Manual = true
	return []builtinType{
		check,
		mk(TypeRename, "Rename files", "text-cursor-input", "Name files with a pattern, e.g. {name} · {bpm} BPM", anyFile, DefaultRename(), &step{m: m, action: ActionRename}),
		mk(TypeChat, "Ask Local Chat", "message-square", "Write notes or pull out fields with the local chat model", core.Accepts{Extensions: textExts}, DefaultChat(), &step{m: m, action: ActionChat}),
		mk(TypeTable, "Make a table", "table", "One CSV row per file, from its variables", core.Accepts{Extensions: []string{}}, DefaultTable(), &step{m: m, action: ActionTable}),
		mk(TypeZip, "Zip", "file-archive", "Pack the files into a zip", anyFile, DefaultZip(), &step{m: m, action: ActionZip}),
		mk(TypeCopy, "Copy to folder", "folder-output", "Copy the files to a folder of your choice", anyFile, DefaultCopy(), &step{m: m, action: ActionCopy}),
	}
}

// step is the adapter of one built-in action.
type step struct {
	m      *Module
	action Action
}

// StepDefaults implements core.Chainable.
func (s *step) StepDefaults() any {
	switch s.action {
	case ActionRename:
		return DefaultRename()
	case ActionChat:
		return DefaultChat()
	case ActionTable:
		return DefaultTable()
	case ActionZip:
		return DefaultZip()
	default:
		return DefaultCopy()
	}
}

// DescribeStep implements core.Chainable. Wave 0: static info only.
func (s *step) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	anyFile := core.Accepts{Extensions: []string{}, Any: true}
	switch s.action {
	case ActionRename:
		return core.StepInfo{Accepts: anyFile, Produces: []core.StepProduct{{Many: true}}, Templates: []string{"/template"}, Summary: "Rename files"}, nil
	case ActionChat:
		return core.StepInfo{Accepts: core.Accepts{Extensions: textExts}, NoFiles: true,
			Produces:  []core.StepProduct{{Role: "text", Label: "Text", Kind: core.KindDocument, Exts: []string{".md", ".txt"}}},
			Vars:      []core.StepVar{{Name: "reply", Label: "Chat reply"}},
			Templates: []string{"/prompt", "/system", "/outputName"}, Summary: "Ask Local Chat"}, nil
	case ActionTable:
		return core.StepInfo{Accepts: core.Accepts{Extensions: []string{}}, NoFiles: true, Together: true,
			Produces: []core.StepProduct{{Role: "table", Label: "Table", Kind: core.KindDocument, Exts: []string{".csv"}}},
			Summary:  "Make a table"}, nil
	case ActionZip:
		return core.StepInfo{Accepts: anyFile, Together: true,
			Produces:  []core.StepProduct{{Role: "zip", Label: "Zip", Kind: core.KindOther, Exts: []string{".zip"}}},
			Templates: []string{"/name"}, Summary: "Zip"}, nil
	default:
		return core.StepInfo{Accepts: anyFile, Produces: []core.StepProduct{{Many: true}}, Templates: []string{"/subfolder"}, Summary: "Copy to folder"}, nil
	}
}

// PrepareStep implements core.Chainable.
func (s *step) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	return nil, core.NotImplemented("Pipeline steps") // WP-BI1
}

// StepOutputs implements core.Chainable.
func (s *step) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{}, core.NotImplemented("Pipeline steps") // WP-BI1
}
