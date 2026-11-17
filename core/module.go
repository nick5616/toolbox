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
	// Quiet modules' jobs never toast on completion, drop out of the job
	// tray's finished list and register no library outputs (Phase 19: the
	// hidden "paint-ai" module runs one job per AI stroke).
	Quiet bool `json:"quiet,omitempty"`
	// JobLess modules have a UI but never run jobs (e.g. Clipboard History);
	// Jobs.Submit rejects them.
	JobLess bool `json:"jobLess"`

	// SplitInputs makes Submit create one job per input.
	SplitInputs bool `json:"-"`
	// MaxConcurrent caps running jobs of this module; 0 = global limit only.
	MaxConcurrent int `json:"-"`
	// Immediate jobs start at once, outside the global parallel-job limit
	// (Local File Transfer's receive jobs: a sender is waiting on the other end).
	Immediate bool `json:"-"`
	// Interactive jobs are short and a user is waiting on them (preview
	// copies, clip prepare, cheap pipeline steps). They start ahead of queued
	// non-interactive jobs and may use one slot beyond the global limit;
	// MaxConcurrent still applies.
	Interactive bool `json:"-"`
	// MaxInputs caps inputs per submission; 0 = no limit.
	MaxInputs int `json:"maxInputs"`
	// NotAStep keeps a module out of the pipeline step catalogue (creator
	// tools whose work is an interactive project).
	NotAStep bool `json:"-"`

	// Composition (Phase 10, SPEC.md §3). Base is the tool this one is a
	// variant of: the same core with a composition layered on top (Edit
	// Studio is Video Editor + the music layer). The sidebar lists a variant
	// under its base. "" = a baseline tool.
	Base string `json:"base"`
	// Parts are the other tools this one is built from (constituents), in
	// display order. The tool header lists them; each can be opened inline
	// or popped out into its own window. Never includes Base.
	Parts []string `json:"parts"`
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

// InteractiveJobs is implemented by modules where only some jobs are ones a
// user is waiting on (Edit Studio's clip prepare, not its renders). Such jobs
// are scheduled like Descriptor.Interactive ones. Called with the queue lock
// held: it must be quick and must not call back into Jobs.
type InteractiveJobs interface {
	IsInteractive(options json.RawMessage) bool
}
