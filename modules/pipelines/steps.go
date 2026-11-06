package pipelines

import (
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
	// Local Chat's step is the tool's own (type llm-chat); its jobs run here
	// because the chat module is job-less. "pipelines.chat" stays an alias.
	chat := mk(TypeChat, "Local Chat", "message-square", "Write notes or pull out fields with the local chat model", core.Accepts{Extensions: textExts}, DefaultChat(), &step{m: m, action: ActionChat})
	chat.t.Category = core.CategoryAI
	return []builtinType{
		check,
		mk(TypeRename, "Rename files", "text-cursor-input", "Name files with a pattern, e.g. {name} · {bpm} BPM", anyFile, DefaultRename(), &step{m: m, action: ActionRename}),
		chat,
		mk(TypeTable, "Make a table", "table", "One CSV row per file, from its variables", core.Accepts{Extensions: []string{}}, DefaultTable(), &step{m: m, action: ActionTable}),
		mk(TypeZip, "Zip", "file-archive", "Pack the files into a zip", anyFile, DefaultZip(), &step{m: m, action: ActionZip}),
		mk(TypeCopy, "Copy to folder", "folder-output", "Copy the files to a folder of your choice", anyFile, DefaultCopy(), &step{m: m, action: ActionCopy}),
		mk(TypeWait, "Wait", "timer", "Pause the run for a while or until a time of day", core.Accepts{Extensions: []string{}, URLs: true, Any: true}, DefaultWait(), &waitStep{m: m}),
		mk(TypeOpen, "Open in app", "app-window", "Open a program, with or without the files, and close it later", core.Accepts{Extensions: []string{}, URLs: true, Any: true}, DefaultOpen(), &openStep{m: m}),
		mk(TypeRun, "Run another pipeline", "workflow", "Run a saved pipeline on these files and carry on with what it keeps", core.Accepts{Extensions: []string{}, URLs: true, Any: true}, DefaultRun(), &step{m: m, action: ActionRun}),
	}
}

// step is the adapter of one built-in action.
type step struct {
	m      *Module
	action Action
}
