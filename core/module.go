package core

import (
	"context"
	"encoding/json"
)

// Category groups modules in the UI.
type Category string

const (
	CategoryMedia    Category = "media"
	CategoryAudio    Category = "audio"
	CategoryImage    Category = "image"
	CategoryDocument Category = "document"
	CategoryAI       Category = "ai"
	CategoryUtility  Category = "utility"
)

// ModuleStatus says whether a module can run jobs.
type ModuleStatus string

const (
	StatusReady      ModuleStatus = "ready"
	StatusComingSoon ModuleStatus = "coming_soon"
)

// Accepts declares what inputs a module takes.
type Accepts struct {
	// Extensions are lowercase with a leading dot, e.g. ".mp3".
	Extensions []string `json:"extensions"`
	// URLs is true when the module takes http(s) links.
	URLs bool `json:"urls"`
	// Any is true when the module takes files of every type (e.g. Vault).
	// Such modules are listed after specific matches.
	Any bool `json:"any"`
}

// Descriptor is the serializable description of a module. The UI renders
// sidebars, palettes and drop matches purely from descriptors.
type Descriptor struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Tagline      string       `json:"tagline"`
	Description  string       `json:"description"`
	Icon         string       `json:"icon"` // lucide icon name, kebab-case
	Category     Category     `json:"category"`
	Status       ModuleStatus `json:"status"`
	Accepts      Accepts      `json:"accepts"`
	Requires     []string     `json:"requires"`     // dep IDs needed to run
	Recommends   []string     `json:"recommends"`   // dep IDs that improve results
	OutputSubdir string       `json:"outputSubdir"` // relative to the library dir; "" = no outputs
	Order        int          `json:"order"`
	Hidden       bool         `json:"hidden"` // system modules: not listed, not matched
	// JobLess modules have a UI but never run jobs (e.g. Clipboard History);
	// Jobs.Submit rejects them.
	JobLess bool `json:"jobLess"`

	// SplitInputs makes Submit create one job per input.
	SplitInputs bool `json:"-"`
	// MaxConcurrent caps running jobs of this module; 0 = global limit only.
	MaxConcurrent int `json:"-"`
	// MaxInputs caps inputs per submission; 0 = no limit.
	MaxInputs int `json:"maxInputs"`
}

// ErrJobLess is returned by Jobs.Submit (and by job-less modules' Validate)
// for modules that don't run jobs.
var ErrJobLess = ValidationError("This tool doesn't run jobs", nil)

// Module is implemented by every tool. See CLAUDE.md "How to add a module".
type Module interface {
	Descriptor() Descriptor
	// Validate runs synchronously at submit time with the already-split
	// inputs. Return ValidationError(...) for bad input.
	Validate(inputs []string, options json.RawMessage) error
	// Run does the work, honouring ctx cancellation promptly, and reports
	// through job.
	Run(ctx context.Context, job *JobContext) error
}
