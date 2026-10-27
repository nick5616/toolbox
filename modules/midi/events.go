package midi

import (
	"toolbox/core"
	"toolbox/core/sidecar"
)

// outputs maps sidecar events onto a job and registers each output path once.
type outputs struct {
	job  *core.JobContext
	seen map[string]bool
	err  error // first output registration failure
}

func newOutputs(job *core.JobContext) *outputs {
	return &outputs{job: job, seen: map[string]bool{}}
}

// register adds path to the library unless it was already registered.
func (o *outputs) register(path string) {
	if path == "" || o.seen[path] {
		return
	}
	o.seen[path] = true
	if _, err := o.job.Output(path); err != nil && o.err == nil {
		o.err = err
	}
}

// onEvent is the sidecar.Caller event callback.
func (o *outputs) onEvent(ev sidecar.Event) {
	switch ev.Kind {
	case "progress":
		o.job.Progress(ev.Pct, ev.Msg)
	case "log":
		stream := core.StreamStdout
		if ev.Level == "warning" || ev.Level == "error" {
			stream = core.StreamStderr
		}
		o.job.Log(stream, ev.Line)
	case "output":
		o.register(ev.Path)
	}
}
