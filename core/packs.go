package core

import "context"

// ModelProvider is implemented by modules whose presets download model files
// (SPEC.md §7.8). The pack installer finds providers through the registry.
type ModelProvider interface {
	// ModelPresent is a cheap file check (no hashing).
	ModelPresent(preset string) bool
	// FetchModel downloads preset (no-op when present), sha-verified where pinned.
	FetchModel(ctx context.Context, job *JobContext, preset string) error
	RemoveModel(preset string) error
}

// Tool pack wire types (SPEC.md §7.9).

// PackState summarises a pack.
type PackState string

const (
	PackInstalled   PackState = "installed"
	PackPartial     PackState = "partial"
	PackMissing     PackState = "missing"
	PackInstalling  PackState = "installing"
	PackOutdated    PackState = "outdated"
	PackUnsupported PackState = "unsupported"
)

// PackComponentKind says how a component is installed.
type PackComponentKind string

const (
	ComponentDep   PackComponentKind = "dep"
	ComponentModel PackComponentKind = "model"
)

// PackComponentState is one component's install state.
type PackComponentState string

const (
	ComponentMissing     PackComponentState = "missing"
	ComponentInstalled   PackComponentState = "installed"
	ComponentSystem      PackComponentState = "system" // found on PATH; costs nothing, never removed
	ComponentOutdated    PackComponentState = "outdated"
	ComponentUnsupported PackComponentState = "unsupported"
)

// PackComponentStatus is one component of a pack.
type PackComponentStatus struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Href          string             `json:"href"`
	License       string             `json:"license"`
	Kind          PackComponentKind  `json:"kind"`
	State         PackComponentState `json:"state"`
	DownloadBytes int64              `json:"downloadBytes"` // for this OS; 0 when present
	DiskBytes     int64              `json:"diskBytes"`     // for this OS; 0 when present
	Packs         []string           `json:"packs"`         // every pack containing it, catalog order
}

// PackUnlock is a tool a pack unlocks.
type PackUnlock struct {
	ModuleID string   `json:"moduleId"`
	Name     string   `json:"name"`
	Icon     string   `json:"icon"`
	Needs    []string `json:"needs"` // component IDs this tool needs (Install what this tool needs)
}

// PackStatus is one pack as the UI sees it.
type PackStatus struct {
	ID                string                `json:"id"`
	Name              string                `json:"name"`
	Icon              string                `json:"icon"`
	Description       string                `json:"description"`
	State             PackState             `json:"state"`
	UnsupportedReason string                `json:"unsupportedReason"`
	Components        []PackComponentStatus `json:"components"`
	Unlocks           []PackUnlock          `json:"unlocks"`
	JobID             string                `json:"jobId"` // running or queued install job, "" = none
}

// PacksChanged is the payload of packs:changed.
type PacksChanged struct {
	Packs []PackStatus `json:"packs"`
}

// DiskInfo is free space on the volume holding Path.
type DiskInfo struct {
	Path  string `json:"path"`
	Free  int64  `json:"free"`
	Total int64  `json:"total"`
}

// ToolsDirInfo describes the tools folder (SPEC.md §7.3).
type ToolsDirInfo struct {
	Path      string `json:"path"`
	IsDefault bool   `json:"isDefault"` // the support dir itself
	FromEnv   bool   `json:"fromEnv"`   // set by TOOLBOX_TOOLS_DIR; can't be changed in the UI
	Available bool   `json:"available"` // the folder exists
}

// PackInstallResult is what Install returns. Restart means the app is about
// to relaunch to use a new tools folder; the install continues after it.
type PackInstallResult struct {
	Jobs    []Job `json:"jobs"`
	Restart bool  `json:"restart"`
}

// PackKept is a component Remove keeps because another installed pack uses it.
type PackKept struct {
	Component string   `json:"component"` // display name
	UsedBy    []string `json:"usedBy"`    // pack names
}

// PackRemovePreview says what removing a pack frees.
type PackRemovePreview struct {
	FreedBytes int64      `json:"freedBytes"`
	Kept       []PackKept `json:"kept"`
}
