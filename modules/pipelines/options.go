package pipelines

import "toolbox/core/pipeline"

// Built-in step and job options (SPEC.md §7).

type Action string

const (
	ActionRename Action = "rename"
	ActionChat   Action = "chat"
	ActionTable  Action = "table"
	ActionZip    Action = "zip"
	ActionCopy   Action = "copy"
)

// Options are the job options (made by PrepareStep; everything expanded).
type Options struct {
	Action   Action     `json:"action"`
	Pipeline string     `json:"pipeline"` // folder name under Pipelines/
	Rename   []RenameOp `json:"rename"`
	Chat     *ChatJob   `json:"chat"`
	Table    *TableJob  `json:"table"`
	Zip      *ZipJob    `json:"zip"`
	Copy     *CopyJob   `json:"copy"`
}

type RenameOp struct {
	Path string `json:"path"`
	Name string `json:"name"` // new base name, no extension
	Move bool   `json:"move"` // true: a file this run made (renamed in place); false: copied into Pipelines/<name>/
	Role string `json:"role"` // carried through
}

type ChatJob struct {
	Mode        string            `json:"mode"`       // "write" | "extract"
	System      string            `json:"system"`     // ≤ 4,000
	Prompt      string            `json:"prompt"`     // the template, unexpanded (expansion happens in Run, for chunking)
	Vars        map[string]string `json:"vars"`       // only the variables the prompt uses
	Fields      []ChatField       `json:"fields"`     // extract
	OutputName  string            `json:"outputName"` // write: expanded base name
	Format      string            `json:"format"`     // write: "md" | "txt"
	SaveJSON    bool              `json:"saveJson"`   // extract: also write <name>.json
	Temperature float64           `json:"temperature"`
}

type ChatField struct {
	Name  string `json:"name"`  // variable name, [a-z][a-z0-9_]{0,31}
	Label string `json:"label"` // shown and given to the model ("Merchant")
	Type  string `json:"type"`  // "text" | "number" | "date"
}

type TableJob struct {
	Name   string     `json:"name"` // base name
	Header []string   `json:"header"`
	Rows   [][]string `json:"rows"`
}

type ZipJob struct {
	Name  string   `json:"name"`
	Files []string `json:"files"`
}

type CopyJob struct {
	Folder string   `json:"folder"` // absolute, chosen by the user
	Files  []string `json:"files"`
}

// StepOptions are what the user edits, one struct per built-in type.
type RenameStep struct {
	Template string `json:"template"` // default "{name}"; takes {vars}
}

type ChatStep struct {
	Mode        string      `json:"mode"` // "write" | "extract"
	System      string      `json:"system"`
	Prompt      string      `json:"prompt"`     // takes {vars}; ≤ 8,000 chars
	Fields      []ChatField `json:"fields"`     // extract: 1–12
	OutputName  string      `json:"outputName"` // write: default "{item} (notes)"; takes {vars}
	Format      string      `json:"format"`     // write: md | txt
	SaveJSON    bool        `json:"saveJson"`
	Temperature float64     `json:"temperature"` // 0–1.5, default 0.3
}

type TableColumn struct {
	Header string `json:"header"`
	Value  string `json:"value"` // takes {vars}
}

type TableStep struct {
	Name    string        `json:"name"`    // default "{pipeline} {date}"; takes the run's built-ins only
	Columns []TableColumn `json:"columns"` // 1–30
}

type ZipStep struct {
	Together bool   `json:"together"` // one zip for the whole run (else one per item)
	Name     string `json:"name"`     // default "{item}" / "{pipeline} {date}"; takes {vars}
}

type CopyStep struct {
	Folder    string `json:"folder"`    // absolute, chosen with the folder picker
	Subfolder string `json:"subfolder"` // takes {vars}; "" = none, e.g. "{pipeline}/{date}"
}

// Step type IDs of the built-ins.
const (
	TypeRename = "pipelines.rename"
	TypeChat   = "pipelines.chat"
	TypeTable  = "pipelines.table"
	TypeZip    = "pipelines.zip"
	TypeCopy   = "pipelines.copy"
	TypeCheck  = pipeline.CheckType
)

// Chat modes and formats.
const (
	ChatWrite   = "write"
	ChatExtract = "extract"
	FormatMD    = "md"
	FormatTXT   = "txt"
)

// DefaultRename etc. are the options a new built-in step starts with.
func DefaultRename() RenameStep { return RenameStep{Template: "{name}"} }

func DefaultChat() ChatStep {
	return ChatStep{Mode: ChatWrite, Prompt: "", Fields: []ChatField{}, OutputName: "{item} (notes)", Format: FormatMD, Temperature: 0.3}
}

func DefaultTable() TableStep {
	return TableStep{Name: "{pipeline} {date}", Columns: []TableColumn{{Header: "File", Value: "{item}"}}}
}

func DefaultZip() ZipStep { return ZipStep{Together: true, Name: "{pipeline} {date}"} }

func DefaultCopy() CopyStep { return CopyStep{Folder: "", Subfolder: ""} }
