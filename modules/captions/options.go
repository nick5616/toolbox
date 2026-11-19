package captions

// Options and batch types (SPEC.md §4–5). FROZEN in Wave 0: they are in the
// TS bindings.

// Action is what a captions job does.
type Action string

const (
	ActionCaption    Action = "caption"    // write captions for the inputs (a new batch)
	ActionRegenerate Action = "regenerate" // redo one item of an existing batch (Batch + Index)
	ActionWrite      Action = "write"      // write fields into copies (Batch)
	ActionRename     Action = "rename"     // rename copies (Batch)
)

// Preset picks which fields are written.
type Preset string

const (
	PresetPosting    Preset = "posting"    // caption, hashtags, alt
	PresetAccessible Preset = "accessible" // alt, description
	PresetCatalogue  Preset = "catalogue"  // title, description, keywords
	PresetRename     Preset = "rename"     // name
	PresetEverything Preset = "everything" // all fields
)

// Field is one kind of text.
type Field string

const (
	FieldAlt         Field = "alt"
	FieldDescription Field = "description"
	FieldCaption     Field = "caption"
	FieldHashtags    Field = "hashtags"
	FieldTitle       Field = "title"
	FieldKeywords    Field = "keywords"
	FieldName        Field = "name"
)

// AllFields in display order.
func AllFields() []Field {
	return []Field{FieldAlt, FieldCaption, FieldHashtags, FieldTitle, FieldDescription, FieldKeywords, FieldName}
}

// PresetFields lists a preset's fields in display order.
func PresetFields(p Preset) []Field {
	switch p {
	case PresetAccessible:
		return []Field{FieldAlt, FieldDescription}
	case PresetCatalogue:
		return []Field{FieldTitle, FieldDescription, FieldKeywords}
	case PresetRename:
		return []Field{FieldName}
	case PresetEverything:
		return AllFields()
	default:
		return []Field{FieldCaption, FieldHashtags, FieldAlt}
	}
}

// Tone of captions.
type Tone string

const (
	TonePlain        Tone = "plain"
	ToneWarm         Tone = "warm"
	TonePlayful      Tone = "playful"
	ToneProfessional Tone = "professional"
	TonePoetic       Tone = "poetic"
)

// Length of captions and descriptions.
type Length string

const (
	LengthShort  Length = "short"
	LengthMedium Length = "medium"
	LengthLong   Length = "long"
)

// NamePattern shapes generated file names.
type NamePattern string

const (
	NameOnly   NamePattern = "name"        // {name}
	NameDate   NamePattern = "date-name"   // {date} {name} (the file's date taken/modified, yyyy-mm-dd)
	NameNumber NamePattern = "number-name" // {n} {name} (01, 02, … in input order)
)

// Then is what a pipeline step does after writing captions.
type Then string

const (
	ThenNothing      Then = "nothing"
	ThenWriteCopies  Then = "writeCopies"
	ThenRenameCopies Then = "renameCopies"
)

// Limits.
const (
	MaxInputs      = 200
	MaxContext     = 2000 // characters of batch context
	MaxNote        = 500  // characters of a per-file note
	MaxHashtags    = 15
	AltPreferred   = 125
	AltHardCap     = 250
	TitleMax       = 70
	NameMax        = 60
	CaptionMax     = 2200 // Instagram's limit (modules/posts/limits.go)
	HintChars      = 1500
	VideoFrames    = 6
	ImageMaxPixels = 896 // long side sent to the model
)

// Options are a captions job's (and step's) options.
type Options struct {
	Action  Action            `json:"action"`
	Preset  Preset            `json:"preset"`
	Context string            `json:"context"` // batch-wide context; a template in steps
	Notes   map[string]string `json:"notes"`   // per input path

	Tone        Tone        `json:"tone"`
	Length      Length      `json:"length"`
	Language    string      `json:"language"` // "" = English (the app language); else a language name, e.g. "Portuguese"
	Emoji       bool        `json:"emoji"`
	Hashtags    int         `json:"hashtags"` // 0–15
	NamePattern NamePattern `json:"namePattern"`
	Kebab       bool        `json:"kebab"`    // file names in kebab-case
	UseHints    bool        `json:"useHints"` // Smart search labels + text as grounding
	ReadText    bool        `json:"readText"` // mention words visible in the picture
	Model       string      `json:"model"`    // "" = automatic (VisionGenerator.Vision)

	// ActionRegenerate / ActionWrite / ActionRename.
	Batch      string `json:"batch"`      // the batch folder
	Index      int    `json:"index"`      // regenerate: the item; -1 = every item
	KeepEdited bool   `json:"keepEdited"` // regenerate: keep fields the user edited
	Seed       int64  `json:"seed"`       // 0 = derived from the file

	// ActionWrite.
	Write WriteOptions `json:"write"`
	Then  Then         `json:"then"` // steps only
}

// WriteOptions choose what "Write into copies" writes.
type WriteOptions struct {
	Alt          bool  `json:"alt"`          // XMP-iptcCore:AltTextAccessibility
	Description  bool  `json:"description"`  // XMP-iptcCore:ExtDescrAccessibility
	Caption      bool  `json:"caption"`      // XMP-dc:Description, EXIF:ImageDescription, IPTC:Caption-Abstract
	CaptionFrom  Field `json:"captionFrom"`  // FieldCaption or FieldDescription
	Title        bool  `json:"title"`        // XMP-dc:Title
	Keywords     bool  `json:"keywords"`     // XMP-dc:Subject + IPTC:Keywords
	KeepLocation bool  `json:"keepLocation"` // default false: GPS is stripped on the copies
}

// DefaultOptions are the tool's starting options.
func DefaultOptions() Options {
	return Options{
		Action: ActionCaption, Preset: PresetPosting, Notes: map[string]string{},
		Tone: ToneWarm, Length: LengthMedium, Hashtags: 5, NamePattern: NameOnly,
		UseHints: true, ReadText: true, Index: -1, KeepEdited: true,
		Write: WriteOptions{Alt: true, Description: true, Caption: true, CaptionFrom: FieldCaption, Title: true, Keywords: true},
		Then:  ThenNothing,
	}
}

// Fields are the texts written for one file.
type Fields struct {
	Alt         string   `json:"alt"`
	Description string   `json:"description"`
	Caption     string   `json:"caption"`
	Hashtags    []string `json:"hashtags"` // with the leading #
	Title       string   `json:"title"`
	Keywords    []string `json:"keywords"`
	Name        string   `json:"name"` // without the extension
}

// Item states.
const (
	ItemPending = "pending"
	ItemDone    = "done"
	ItemFailed  = "failed"
)

// Item is one file of a batch.
type Item struct {
	Input  string         `json:"input"`
	Note   string         `json:"note"`
	Fields Fields         `json:"fields"`
	Edited map[Field]bool `json:"edited"`
	State  string         `json:"state"`
	Reason string         `json:"reason"`
	Seed   int64          `json:"seed"`
}

// BatchVersion is captions.json's format version.
const BatchVersion = 1

// Batch is captions.json: the full record of one batch.
type Batch struct {
	Version int     `json:"version"`
	Name    string  `json:"name"`
	Dir     string  `json:"dir"` // absolute; not trusted from the file (set on read)
	Created int64   `json:"created"`
	Model   string  `json:"model"`
	Options Options `json:"options"`
	Items   []Item  `json:"items"`
}

// BatchInfo is one row of Past batches.
type BatchInfo struct {
	Dir     string `json:"dir"`
	Name    string `json:"name"`
	Created int64  `json:"created"`
	Count   int    `json:"count"`
	Failed  int    `json:"failed"`
	Cover   string `json:"cover"` // the first input that still exists
}

// EventItem is emitted as each item of a batch finishes (ItemEvent).
const EventItem = "captions:item"

// ItemEvent is the captions:item payload: one item finished.
type ItemEvent struct {
	JobID string `json:"jobId"`
	Dir   string `json:"dir"`
	Index int    `json:"index"`
	Item  Item   `json:"item"`
}

// Status is what the tool's gate needs.
type Status struct {
	Model       string `json:"model"`       // the model that will read pictures; "" = none
	ModelLabel  string `json:"modelLabel"`  // shown name
	Problem     string `json:"problem"`     // why there's no model (the gate's message)
	ExifTool    bool   `json:"exifTool"`    // "Write into copies" for images
	FFmpeg      bool   `json:"ffmpeg"`      // videos
	SearchHints bool   `json:"searchHints"` // Smart search is installed
}
