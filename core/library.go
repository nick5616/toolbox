package core

// Library browser contracts (Phase 19, SPEC.md §3). LibraryService in api/
// serves them; L1 implements, L2 renders.

// LibrarySort orders a library query.
type LibrarySort string

const (
	SortNewest LibrarySort = "newest"
	SortOldest LibrarySort = "oldest"
	SortName   LibrarySort = "name"
	SortSize   LibrarySort = "size"
)

// LibraryQuery pages through outputs with server-side filters. It
// supersedes OutputQuery for the Library view (Recent stays for tools).
type LibraryQuery struct {
	ModuleID string       `json:"moduleId"` // "" = every tool
	Search   string       `json:"search"`   // name contains, case-insensitive
	Kinds    []OutputKind `json:"kinds"`    // empty = every kind
	Exts     []string     `json:"exts"`     // file extensions, with or without the dot, any case; empty = every extension
	Since    int64        `json:"since"`    // Unix ms, 0 = no bound
	Until    int64        `json:"until"`    // Unix ms, 0 = no bound
	Sort     LibrarySort  `json:"sort"`     // "" = newest
	Folder   string       `json:"folder"`   // library-relative folder ("" = everywhere); direct children only
	Limit    int          `json:"limit"`    // default 100, max 500
	Cursor   string       `json:"cursor"`   // opaque; "" = first page
}

// LibraryFolder is one folder of the library tree.
type LibraryFolder struct {
	Rel        string          `json:"rel"`        // library-relative, "/"-separated; "" = the root
	Name       string          `json:"name"`       // last path element ("Toolbox" for the root)
	Path       string          `json:"path"`       // absolute
	Files      int             `json:"files"`      // every file directly inside
	Registered int             `json:"registered"` // of which are library outputs
	NewestMod  int64           `json:"newestMod"`  // Unix ms of the newest file directly inside, 0 = empty
	ModuleIDs  []string        `json:"moduleIds"`  // tools whose OutputSubdir is this folder (or that wrote into it)
	Children   []LibraryFolder `json:"children"`   // depth ≤ 6
}

// LibraryEntry is one file or folder inside a library folder.
type LibraryEntry struct {
	Name      string     `json:"name"`
	Path      string     `json:"path"`
	Rel       string     `json:"rel"`
	IsDir     bool       `json:"isDir"`
	SizeBytes int64      `json:"sizeBytes"`
	ModTime   int64      `json:"modTime"` // Unix ms
	Kind      OutputKind `json:"kind"`    // by extension (folders: "other")
	Output    *Output    `json:"output"`  // the registered output at this path, nil = not from a job
}

// LibraryListing is a folder's entries.
type LibraryListing struct {
	Entries   []LibraryEntry `json:"entries"`
	Truncated bool           `json:"truncated"` // more than the limit
}

// OutputDetail is everything the Library's detail panel shows for one file.
type OutputDetail struct {
	Output   Output   `json:"output"`   // for an unregistered file: ID "" and fields from the file
	JobTitle string   `json:"jobTitle"` // "" when the job is gone
	Options  string   `json:"options"`  // the job's options JSON ("" when unknown)
	Summary  string   `json:"summary"`  // a one-line settings summary when the module offers one
	MadeFrom []string `json:"madeFrom"` // input paths
	MadeInto []Output `json:"madeInto"` // outputs whose lineage includes this path
	Chain    []Output `json:"chain"`    // single-input same-tool chain through this file, oldest first (≤ 200); empty if none
	ChainAt  int      `json:"chainAt"`  // this file's index in Chain
	Width    int      `json:"width"`    // images (0 = unknown)
	Height   int      `json:"height"`
	Unknown  bool     `json:"unknown"` // no lineage recorded ("Origin unknown")
}

// LibraryProject is a creator-tool project shown under "Other places".
type LibraryProject struct {
	ID        string      `json:"id"`
	Kind      ProjectKind `json:"kind"`
	ModuleID  string      `json:"moduleId"` // the tool that opens it
	Name      string      `json:"name"`
	Thumb     string      `json:"thumb"`  // path, "" if none
	Render    string      `json:"render"` // path, "" if none
	UpdatedAt int64       `json:"updatedAt"`
}

// LibrarySavedMask is a saved Object Eraser mask.
type LibrarySavedMask struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	CreatedAt int64  `json:"createdAt"`
}

// LibraryPlaces are things the user made that live outside the library folder.
type LibraryPlaces struct {
	Projects   []LibraryProject   `json:"projects"`
	SavedMasks []LibrarySavedMask `json:"savedMasks"`
}

// TrashResult reports a move to the Recycle Bin / Trash.
type TrashResult struct {
	Trashed []string          `json:"trashed"` // paths moved to the trash
	Failed  map[string]string `json:"failed"`  // path → reason
}
