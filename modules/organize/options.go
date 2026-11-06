package organize

// GroupBy is how files are sorted into folders.
type GroupBy string

const (
	GroupDate    GroupBy = "date"    // by date taken
	GroupType    GroupBy = "type"    // Photos / Videos / Audio / Documents / Other
	GroupCamera  GroupBy = "camera"  // by camera make and model
	GroupPattern GroupBy = "pattern" // by Options.Pattern
)

// DupMode is how duplicates are found.
type DupMode string

const (
	DupOff     DupMode = "off"
	DupExact   DupMode = "exact"   // same size and SHA-256
	DupSimilar DupMode = "similar" // exact, plus look-alike photos (perceptual hash)
)

// DupAction is what happens to the copies that are not the best of their group.
type DupAction string

const (
	ActionFolder DupAction = "folder" // copy into "Duplicates/"
	ActionSkip   DupAction = "skip"   // leave them out (still listed in the report)
)

// Options are the Organizer's per-submission options.
type Options struct {
	GroupBy GroupBy `json:"groupBy"`
	// Pattern is used when GroupBy is "pattern": folders separated by "/" with
	// {yyyy} {mm} {dd} {type} {camera} {ext}.
	Pattern    string    `json:"pattern"`
	Duplicates DupMode   `json:"duplicates"`
	Similarity int       `json:"similarity"` // 70..99 (percent alike); similar mode only
	DupAction  DupAction `json:"dupAction"`
	// Destination is an absolute folder to put the run folder in; "" = the library's Organized folder.
	Destination string `json:"destination"`
	// RunName names the run folder; "" = "Organized <date time>".
	RunName string `json:"runName"`
}

// Pattern presets.
const (
	DatePattern   = "{yyyy}/{yyyy}-{mm}"
	TypePattern   = "{type}"
	CameraPattern = "{camera}"
	// DefaultPattern is the starting point for a custom pattern.
	DefaultPattern = "{yyyy}/{mm}/{type}"
)

// Limits and fixed names.
const (
	MaxFiles        = 100_000
	MinSimilarity   = 70
	MaxSimilarity   = 99
	DuplicatesDir   = "Duplicates"
	ReportName      = "report.csv"
	maxPatternDepth = 6
)

// DefaultOptions: by date taken, exact duplicates set aside.
func DefaultOptions() Options {
	return Options{GroupBy: GroupDate, Pattern: DefaultPattern, Duplicates: DupExact, Similarity: 90, DupAction: ActionFolder}
}

// patternFor is the folder pattern the grouping means.
func patternFor(o Options) string {
	switch o.GroupBy {
	case GroupType:
		return TypePattern
	case GroupCamera:
		return CameraPattern
	case GroupPattern:
		return o.Pattern
	}
	return DatePattern
}

// maxDistance is the largest Hamming distance (of 64 bits) that still counts as alike.
func maxDistance(similarity int) int {
	return (100 - min(max(similarity, MinSimilarity), MaxSimilarity)) * 64 / 100
}
