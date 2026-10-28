package exif

// Action is what an EXIF job does. Every action writes a new file.
type Action string

const (
	ActionStripLocation Action = "strip-location"
	ActionStripAll      Action = "strip-all"
	ActionEdit          Action = "edit"
)

// Editable field names (Options.Fields keys), in UI order.
const (
	FieldTitle            = "Title"
	FieldDescription      = "Description"
	FieldArtist           = "Artist"
	FieldCopyright        = "Copyright"
	FieldKeywords         = "Keywords"         // comma-separated
	FieldDateTimeOriginal = "DateTimeOriginal" // "YYYY:MM:DD HH:MM:SS"
)

// EditableFields lists the editable fields in UI order.
func EditableFields() []string {
	return []string{FieldTitle, FieldDescription, FieldArtist, FieldCopyright, FieldKeywords, FieldDateTimeOriginal}
}

// Options are the per-submission options of an EXIF job.
type Options struct {
	Action Action `json:"action"`
	// KeepOrientation (strip-all): re-add Orientation and the ICC profile.
	KeepOrientation bool `json:"keepOrientation"`
	// Fields (edit): subset of EditableFields(); "" removes the tag.
	Fields map[string]string `json:"fields"`
}

// DefaultOptions: remove location.
func DefaultOptions() Options {
	return Options{Action: ActionStripLocation, KeepOrientation: true, Fields: map[string]string{}}
}

// Result is stored as the job's ResultJSON.
type Result struct {
	Action      Action `json:"action"`
	RemovedTags int    `json:"removedTags"` // before/after tag count difference (≥ 0)
	Output      string `json:"output"`      // absolute path of the new file
}

// MetadataView is a file's metadata for the inspector.
type MetadataView struct {
	Path        string      `json:"path"`
	Name        string      `json:"name"`
	SizeBytes   int64       `json:"sizeBytes"`
	Make        string      `json:"make"`
	Model       string      `json:"model"`
	DateTaken   string      `json:"dateTaken"` // as ExifTool prints it, "" if none
	Groups      []MetaGroup `json:"groups"`    // ordered (SPEC.md §6.2)
	HasLocation bool        `json:"hasLocation"`
	Location    *GeoPoint   `json:"location"`
	Editable    bool        `json:"editable"` // false for RAW and formats ExifTool can't write
	// Current values of the editable fields (for the edit dialog).
	Fields map[string]string `json:"fields"`
}

// MetaGroup is one ExifTool group (e.g. "IFD0", "GPS", "XMP-dc").
type MetaGroup struct {
	Name      string      `json:"name"`
	Collapsed bool        `json:"collapsed"` // MakerNotes etc. start collapsed
	Fields    []MetaField `json:"fields"`
}

// MetaField is one tag. Value is stringified; binary blobs read
// "(binary, N bytes)".
type MetaField struct {
	Tag   string `json:"tag"`
	Label string `json:"label"`
	Value string `json:"value"`
}

// GeoPoint is a decimal-degree location.
type GeoPoint struct {
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	Altitude    float64 `json:"altitude"`
	HasAltitude bool    `json:"hasAltitude"`
}
