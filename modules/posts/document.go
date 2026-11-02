package posts

// The post document (SPEC.md Part B §B7.1–B7.2). FROZEN (Wave B0).

type Post struct {
	Version      int     `json:"version"`      // 1
	Format       string  `json:"format"`       // "carousel" | "reel" | "story"
	Aspect       string  `json:"aspect"`       // carousel: "4:5" | "1:1" | "3:4" | "1.91:1"; reel/story: "9:16"
	Slides       []Slide `json:"slides"`       // carousel/story 1–20; reel exactly 1 video
	Caption      string  `json:"caption"`      // ≤ 2,200 chars
	KeepLocation bool    `json:"keepLocation"` // default false: strip EXIF/XMP/location from photos and metadata from videos

	// The source pool (SPEC.md §B13): slides are allocated from it.
	Folder     string   `json:"folder"`     // the source folder ("" = none)
	Subfolders bool     `json:"subfolders"` // include files in subfolders (any depth)
	Extra      []string `json:"extra"`      // sources added one by one (outside the folder or from the Library)
	Hidden     []string `json:"hidden"`     // folder files removed from the pool (never deleted from disk)
}

// SourceFile is one file of a post's source pool (SPEC.md §B13.3).
type SourceFile struct {
	Path      string   `json:"path"`
	Name      string   `json:"name"`
	Rel       string   `json:"rel"`  // path relative to the folder ("" for extras)
	Kind      string   `json:"kind"` // "photo" | "clip"
	SizeBytes int64    `json:"sizeBytes"`
	ModTime   int64    `json:"modTime"` // Unix ms
	TakenAt   int64    `json:"takenAt"` // EXIF date (JPEG) or ModTime
	UsedIn    []string `json:"usedIn"`  // slide IDs using it directly or inside a linked composition / video project
	Missing   bool     `json:"missing"` // an Extra that no longer exists
}

type Slide struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`      // "photo" | "clip" | "composition" | "video"
	Path      string  `json:"path"`      // photo/clip
	ProjectID string  `json:"projectId"` // composition/video
	PanX      float64 `json:"panX"`      // framing at the post's shape: -1..1
	PanY      float64 `json:"panY"`
	Zoom      float64 `json:"zoom"`     // 1..4
	Rotation  int     `json:"rotation"` // 0 | 90 | 180 | 270 (on top of EXIF/metadata orientation)
	InMs      int64   `json:"inMs"`     // clip
	OutMs     int64   `json:"outMs"`    // clip; carousel/story ≤ 60 s, reel ≤ 180 s
	Mute      bool    `json:"mute"`
	AltText   string  `json:"altText"` // ≤ 1,000 chars
}

type Issue struct {
	Level   string `json:"level"`   // "error" | "warning" | "note"
	SlideID string `json:"slideId"` // "" = the whole post
	Message string `json:"message"`
}
