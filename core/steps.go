package core

import (
	"context"
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"
)

// Chainable is implemented by modules that can run as automatic pipeline
// steps (SPEC.md §6). Implementations live in modules/<id>/pipeline.go.
type Chainable interface {
	// StepDefaults returns the options a new step starts with (JSON-marshalable).
	StepDefaults() any
	// DescribeStep checks options without inputs and says what the step
	// takes and makes. Return ValidationError for bad options.
	DescribeStep(options json.RawMessage) (StepInfo, error)
	// PrepareStep turns one item's files (or, when Together, every merged
	// item's) into job submissions for this module. It may probe the files.
	// ErrWaiting(...) means "not yet": the runner retries every 5 s;
	// ErrWaitingUntil(...) retries at its deadline (Phase 18).
	PrepareStep(ctx context.Context, req StepRequest) ([]StepJob, error)
	// StepOutputs reads a finished (done) job back: its files with roles,
	// and its variables. It may read the output files (≤ 1 MiB of text).
	StepOutputs(job Job) (StepResult, error)
}

// StepRequest is what PrepareStep receives.
type StepRequest struct {
	RunID    string
	StepID   string
	Pipeline string            // the pipeline's name
	Options  json.RawMessage   // the step's options, unexpanded
	Item     StepItem          // each-item steps
	Items    []StepItem        // together steps: every merged item, in order (SPEC.md §4.2 rule 5)
	Secrets  map[string]string // this step's secrets by key
	Started  int64             // the run's start (for {date}/{time})
	// Until is the cell's stored deadline from an earlier ErrWaitingUntil
	// (Unix ms), 0 the first time; a step uses it to keep a deadline fixed
	// across retries and restarts (Phase 18).
	Until int64
	// SkipWait is set when the user pressed Continue now on a time wait; the
	// step decides what that means (Phase 18).
	SkipWait bool
}

// StepItem is one item's view for PrepareStep.
type StepItem struct {
	Index int
	Label string
	Files []RunFile         // already filtered and accepted
	Vars  map[string]string // built-ins + every earlier step's
}

// StepJob is one job submission made by PrepareStep.
type StepJob struct {
	Inputs  []string
	Options any // marshalled to the job's options
}

// StepResult is what StepOutputs reads back from a finished job.
type StepResult struct {
	Files []RunFile // Role/RoleLabel set; Kind may be "" (filled from the extension)
	Vars  map[string]string
}

// Variable limits (SPEC.md §4.3).
const (
	MaxVarBytes     = 256 * 1024
	MaxItemVarBytes = 1024 * 1024
)

// VarName is the syntax of a variable name.
var VarName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// scanTemplate walks tpl, calling lit for literal text and ref for each
// {name}. "{{" and "}}" are literal braces; a "{" that doesn't start a valid
// reference is literal.
func scanTemplate(tpl string, lit func(string), ref func(string)) {
	for i := 0; i < len(tpl); {
		c := tpl[i]
		switch {
		case c == '{' && i+1 < len(tpl) && tpl[i+1] == '{':
			lit("{")
			i += 2
		case c == '}' && i+1 < len(tpl) && tpl[i+1] == '}':
			lit("}")
			i += 2
		case c == '{':
			end := strings.IndexByte(tpl[i+1:], '}')
			if end >= 0 && VarName.MatchString(tpl[i+1:i+1+end]) {
				ref(tpl[i+1 : i+1+end])
				i += end + 2
				continue
			}
			lit("{")
			i++
		default:
			j := i + 1
			for j < len(tpl) && tpl[j] != '{' && tpl[j] != '}' {
				j++
			}
			lit(tpl[i:j])
			i = j
		}
	}
}

// ExpandVars replaces {name} with the value from the last map defining it;
// unknown names become "" and are returned in missing (once each, in order of
// first use). "{{"/"}}" are braces.
func ExpandVars(tpl string, maps ...map[string]string) (out string, missing []string) {
	var b strings.Builder
	scanTemplate(tpl, func(s string) { b.WriteString(s) }, func(name string) {
		for i := len(maps) - 1; i >= 0; i-- {
			if v, ok := maps[i][name]; ok {
				b.WriteString(v)
				return
			}
		}
		for _, m := range missing {
			if m == name {
				return
			}
		}
		missing = append(missing, name)
	})
	return b.String(), missing
}

// TemplateVars returns the variable names used in tpl, once each, in order.
func TemplateVars(tpl string) []string {
	names := []string{}
	scanTemplate(tpl, func(string) {}, func(name string) {
		for _, n := range names {
			if n == name {
				return
			}
		}
		names = append(names, name)
	})
	return names
}

// FileVars are the per-file built-ins: name, ext and role.
func FileVars(f RunFile) map[string]string {
	name := f.Name
	if name == "" {
		name = filepath.Base(f.Path)
	}
	ext := filepath.Ext(name)
	return map[string]string{
		"name": strings.TrimSuffix(name, ext),
		"ext":  strings.TrimPrefix(ext, "."),
		"role": f.RoleLabel,
	}
}

// CapVar truncates a variable value to MaxVarBytes on a UTF-8 boundary and
// reports whether it was cut.
func CapVar(v string) (string, bool) {
	if len(v) <= MaxVarBytes {
		return v, false
	}
	cut := MaxVarBytes
	for cut > 0 && !utf8Start(v[cut]) {
		cut--
	}
	return v[:cut], true
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
