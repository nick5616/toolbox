package pipeline

import (
	"encoding/json"
	"strings"

	"toolbox/core"
)

// "Run another pipeline" (Phase 14): a built-in step that runs a saved
// pipeline as a sub-run. The step's work lives in modules/pipelines; the
// cycle rules live here because they need every saved pipeline.

const (
	// RunPipelineType is the step type of "Run another pipeline", the Pipelines
	// tool's own step: like every tool's, its ID is the tool's ID.
	RunPipelineType = "pipelines"
	// LocalChatType is Local Chat's own step type (the tool's module ID). The
	// old built-in "pipelines.chat" is an alias of it.
	LocalChatType = "llm-chat"
	// LegacyChatType is the old ID of Local Chat's step.
	LegacyChatType = "pipelines.chat"
)

// subrunTarget returns the pipeline a "Run another pipeline" step runs.
func subrunTarget(s core.PipelineStep) string {
	if s.Type != RunPipelineType {
		return ""
	}
	var o struct {
		PipelineID string `json:"pipelineId"`
	}
	if json.Unmarshal([]byte(s.OptionsJSON), &o) != nil {
		return ""
	}
	return strings.TrimSpace(o.PipelineID)
}

// subrunRefs lists the pipelines p runs as sub-runs.
func subrunRefs(p core.Pipeline) []string {
	var out []string
	for _, s := range p.Steps {
		if t := subrunTarget(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// cycleThrough returns the names of the loop p → … → p when p (as it will be
// saved) runs, directly or through other pipelines, itself; nil when there is
// none. all is every saved pipeline; p replaces its own saved version. A
// pipeline without an ID can't be referenced, so it can't be in a cycle.
func cycleThrough(p core.Pipeline, all []core.Pipeline) []string {
	if p.ID == "" {
		return nil
	}
	byID := map[string]core.Pipeline{p.ID: p}
	for _, o := range all {
		if o.ID != p.ID {
			byID[o.ID] = o
		}
	}
	visited := map[string]bool{}
	var walk func(id string, path []string) []string
	walk = func(id string, path []string) []string {
		q, ok := byID[id]
		if !ok {
			return nil
		}
		path = append(path, q.Name)
		if id == p.ID {
			return path
		}
		if visited[id] {
			return nil
		}
		visited[id] = true
		for _, ref := range subrunRefs(q) {
			if got := walk(ref, path); got != nil {
				return got
			}
		}
		return nil
	}
	for _, ref := range subrunRefs(p) {
		if got := walk(ref, []string{p.Name}); got != nil {
			return got
		}
	}
	return nil
}

// Cycle reports the loop p would make by running other pipelines ("A → B →
// A"), or "" when it makes none.
func (r *Runner) Cycle(p core.Pipeline) string {
	return strings.Join(cycleThrough(p, r.snapshotPipes()), " → ")
}
