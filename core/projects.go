package core

import "context"

// Creator-tool projects (SPEC.md Part B §B4): posts, compositions and video
// projects are typed documents stored as JSON in one table.

// ProjectKind is the type of a project document.
type ProjectKind string

const (
	ProjectPost        ProjectKind = "post"
	ProjectComposition ProjectKind = "composition"
	ProjectVideo       ProjectKind = "video"
	ProjectEdit        ProjectKind = "edit"  // Edit Studio (Phase 9)
	ProjectPaint       ProjectKind = "paint" // Paint+ (Phase 19)
)

// MaxProjectBytes caps a project document's JSON.
const MaxProjectBytes = 4 << 20

// ProjectInfo is a project as listed.
type ProjectInfo struct {
	ID        string      `json:"id"`
	Kind      ProjectKind `json:"kind"`
	Name      string      `json:"name"`
	Thumb     string      `json:"thumb"`   // <support>/projects/<id>/thumb.jpg ("" if none)
	Items     int         `json:"items"`   // slides / layers / clips
	Missing   int         `json:"missing"` // source files that no longer exist
	UpdatedAt int64       `json:"updatedAt"`
	// Flags are per-kind facts for listings (Phase 10). Edit projects:
	// "music" (has a song), "music-edit" (the song is analysed: an Edit
	// Studio project). Never nil on the wire.
	Flags []string `json:"flags"`
}

// StoredProject is one row of the projects table.
type StoredProject struct {
	ID        string
	Kind      ProjectKind
	Name      string
	Data      string // the document as JSON
	CreatedAt int64
	UpdatedAt int64
}

// ProjectStore persists project documents.
type ProjectStore interface {
	// ListProjects returns a kind's projects, most recently updated first.
	ListProjects(ctx context.Context, kind ProjectKind) ([]StoredProject, error)
	// GetProject returns an *AppError with CodeNotFound for unknown IDs.
	GetProject(ctx context.Context, id string) (StoredProject, error)
	// PutProject inserts or replaces p.
	PutProject(ctx context.Context, p StoredProject) error
	DeleteProject(ctx context.Context, id string) error
}
