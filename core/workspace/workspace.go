// Package workspace resolves which workspace Toolbox opens and where its data
// lives (Phase 21 SPEC Part A). A workspace is a folder with its own library
// (<root>/Library) and its own support dir (<root>/.toolbox); every workspace
// shares one tools folder. Personal is the pre-Phase-21 layout and never
// moves. No Wails, no modules.
//
// FROZEN after Wave 0: Kind, Info, Boot, CreateRequest, TidyPlan, the env and
// file names below, and the Resolve/Presenter signatures.
package workspace

import (
	"os"

	"toolbox/core"
)

// Kind is a workspace's kind.
type Kind string

const (
	KindPersonal Kind = "personal"
	KindStandard Kind = "standard"
	KindDemo     Kind = "demo"
	KindSandbox  Kind = "sandbox" // launched by TOOLBOX_SUPPORT_DIR or TOOLBOX_WORKSPACE
)

// PersonalID is the fixed ID of the Personal workspace.
const PersonalID = "personal"

// Environment overrides (SPEC §A3).
const (
	EnvWorkspace         = "TOOLBOX_WORKSPACE"          // a workspace root; sandboxed
	EnvWorkspaceBaseline = "TOOLBOX_WORKSPACE_BASELINE" // baseline for a new env workspace
	EnvWorkspaceKind     = "TOOLBOX_WORKSPACE_KIND"     // kind for a new env workspace
	EnvWorkspaceName     = "TOOLBOX_WORKSPACE_NAME"     // name for a new env workspace
	EnvNoHotkeys         = "TOOLBOX_NO_HOTKEYS"         // "1": register no global hotkeys
)

// File and folder names (SPEC §A2).
const (
	ListFile      = "workspaces.json"        // in the global support dir
	SupportFolder = ".toolbox"               // <root>/.toolbox = the workspace's support dir
	LibraryFolder = "Library"                // <root>/Library = the workspace's library
	InfoFile      = "workspace.json"         // <root>/.toolbox/workspace.json
	ManifestFile  = "baseline-manifest.json" // <root>/.toolbox/baseline-manifest.json
	ToolsLockFile = ".toolbox-tools.lock"    // <tools>/.toolbox-tools.lock (SPEC §A6b)
	ArgWorkspace  = "--workspace"            // command-line: --workspace <root|id>
)

// DefaultKeep are the library folders Tidy never touches.
var DefaultKeep = []string{"Demo Footage", "Extras"}

// Info describes one workspace.
type Info struct {
	ID            string   `json:"id"`   // "personal" | 12 hex chars
	Name          string   `json:"name"` // 1..40 chars; unique (case-insensitive)
	Kind          Kind     `json:"kind"`
	Root          string   `json:"root"`          // "" for personal
	Baseline      string   `json:"baseline"`      // absolute; "" = none
	Present       bool     `json:"present"`       // hide personal details (SPEC §A5)
	Keep          []string `json:"keep"`          // library-relative folders Tidy never touches
	Exclude       []string `json:"exclude"`       // baseline-relative globs the seed skips
	StripLocation bool     `json:"stripLocation"` // seed/restore strip GPS from photo/video copies
	Created       int64    `json:"created"`       // unix ms
	Current       bool     `json:"current"`
	Missing       bool     `json:"missing"` // root not found
}

// Boot is what main.go opens.
type Boot struct {
	Info        Info
	Paths       core.Paths // SupportDir = <root>/.toolbox (personal: the global support dir); ToolsDir = the global tools folder
	GlobalDir   string     // the global support dir (holds workspaces.json); "" when sandboxed by TOOLBOX_SUPPORT_DIR
	LibraryDir  string     // <root>/Library; "" for personal (settings decide, as before)
	Sandboxed   bool       // TOOLBOX_SUPPORT_DIR or TOOLBOX_WORKSPACE
	SeedPending bool       // a baseline copy must run on this boot
	Notice      string     // shown once after start ("Demo's folder isn't there"); "" = none
}

// CreateRequest is WorkspacesService.Create's input.
type CreateRequest struct {
	Name     string `json:"name"`
	Root     string `json:"root"`
	Kind     Kind   `json:"kind"` // standard | demo
	Baseline string `json:"baseline"`
	Present  bool   `json:"present"`
}

// TidyPlan is WorkspacesService.TidyPreview's answer.
type TidyPlan struct {
	Files  int      `json:"files"`
	Bytes  int64    `json:"bytes"`
	Sample []string `json:"sample"` // ≤ 20 display paths
	Jobs   int      `json:"jobs"`   // running/queued jobs that block tidy
}

// ManifestEntry is one baseline file in baseline-manifest.json.
type ManifestEntry struct {
	Rel       string `json:"rel"` // "/" separators
	SrcSha256 string `json:"srcSha256"`
	Size      int64  `json:"size"`   // of the copy
	Sha256    string `json:"sha256"` // of the copy
}

// Manifest is baseline-manifest.json.
type Manifest struct {
	Files []ManifestEntry `json:"files"`
}

// Resolve picks the workspace to open from the environment, args and
// workspaces.json (SPEC §A3). Wave 0: the pre-Phase-21 behaviour (sandbox
// support dir or Personal); W1 implements the full order.
func Resolve(args []string) (Boot, error) {
	paths, err := core.ResolvePaths()
	if err != nil {
		return Boot{}, err
	}
	sandboxed := os.Getenv(core.EnvSupportDir) != ""
	info := Info{ID: PersonalID, Name: "Personal", Kind: KindPersonal, Current: true}
	global := paths.SupportDir
	if sandboxed {
		info = Info{ID: "sandbox", Name: "Dev sandbox", Kind: KindSandbox, Root: paths.SupportDir, Current: true}
		global = ""
	}
	return Boot{Info: info, Paths: paths, GlobalDir: global, Sandboxed: sandboxed}, nil
}

// Presenter rewrites paths for display when Present is on (SPEC §A5): inside
// the workspace root → "<Name>/…", inside home → "~/…".
type Presenter struct {
	On   bool   `json:"on"`
	Root string `json:"root"` // the workspace root (personal: "")
	Name string `json:"name"`
	Home string `json:"home"`
}

// Path returns p as the UI should show it. Wave 0: unchanged.
func (pr Presenter) Path(p string) string { return p }

// Text rewrites every occurrence of the root and home in s. Wave 0: unchanged.
func (pr Presenter) Text(s string) string { return s }
