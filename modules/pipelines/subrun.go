package pipelines

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"toolbox/core"
)

// "Run another pipeline" (Phase 14). The sub-run is started and followed
// while the step is prepared (PrepareStep runs off the runner's loop and is
// cancelled with the cell), so it never holds a job slot its own steps need.
// The job that follows only reports the files the sub-run kept.

func (s *step) describeRun(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options, DefaultRun())
	if err != nil {
		return core.StepInfo{}, err
	}
	if strings.TrimSpace(o.PipelineID) == "" {
		return core.StepInfo{}, core.ValidationError("Choose a pipeline to run", map[string]string{"pipelineId": "Choose a pipeline"})
	}
	if s.m.runner == nil {
		return core.StepInfo{}, core.Errorf(core.CodeInternal, "Pipelines aren't available")
	}
	p, err := s.m.runner.Get(o.PipelineID)
	if err != nil {
		return core.StepInfo{}, core.ValidationError("That pipeline doesn't exist any more", map[string]string{"pipelineId": "Choose another pipeline"})
	}
	return core.StepInfo{
		Accepts:  core.Accepts{Extensions: []string{}, URLs: true, Any: true},
		Produces: []core.StepProduct{{Kind: core.KindOther, Exts: []string{}, Many: true}},
		Vars:     []core.StepVar{}, Secrets: []core.StepSecret{}, Templates: []string{}, Warnings: []string{},
		Summary: "Run " + ellipsize(p.Name, 60),
	}, nil
}

func (s *step) prepareRun(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, _ := decodeStep(req.Options, DefaultRun())
	files := req.Item.Files
	if len(files) == 0 {
		return nil, core.ValidationError("There are no files to run the pipeline on", nil)
	}
	inputs := make([]string, len(files))
	for i, f := range files {
		inputs[i] = f.Path
	}
	p, err := s.m.runner.Get(o.PipelineID)
	if err != nil {
		return nil, core.ValidationError("That pipeline doesn't exist any more", nil)
	}
	run, err := s.m.runner.StartRun(core.RunRequest{PipelineID: o.PipelineID, Inputs: inputs}, "pipeline")
	if err != nil {
		return nil, err
	}
	poll := s.m.subPoll
	if poll <= 0 {
		poll = 500 * time.Millisecond
	}
	t := time.NewTicker(poll)
	defer t.Stop()
	for {
		cur, err := s.m.runner.Run(run.ID)
		if err != nil {
			return nil, err
		}
		switch cur.Status {
		case core.RunDone:
			kept := keptFiles(cur)
			ins := make([]string, 0, len(kept))
			for _, f := range kept {
				ins = append(ins, f.Path)
			}
			return []core.StepJob{{Inputs: ins, Options: Options{Action: ActionRun, Pipeline: req.Pipeline, Run: &RunJob{Name: p.Name, Files: kept}}}}, nil
		case core.RunFailed, core.RunPartial, core.RunCancelled:
			return nil, subRunError(p.Name, cur)
		}
		select {
		case <-ctx.Done():
			_ = s.m.runner.Cancel(run.ID)
			return nil, ctx.Err()
		case <-t.C:
		}
	}
}

// subRunError says why a sub-run didn't finish, with its first failure.
func subRunError(name string, run core.PipelineRun) error {
	why := "didn't finish"
	switch run.Status {
	case core.RunCancelled:
		why = "was cancelled"
	case core.RunFailed, core.RunPartial:
		why = "had failures"
	}
	for _, it := range run.Items {
		for _, c := range it.Cells {
			if c.Status == core.CellFailed && c.Error != "" {
				return core.Errorf(core.CodeValidation, "%s %s: %s", name, why, c.Error).WithHint("Open the pipeline's run to see the details")
			}
		}
	}
	if run.Error != "" {
		return core.Errorf(core.CodeValidation, "%s %s: %s", name, why, run.Error)
	}
	return core.Errorf(core.CodeValidation, "%s %s", name, why).WithHint("Open the pipeline's run to see the details")
}

// keptFiles are what a finished sub-run hands back: the files of every step
// marked "keep"; when none is, the files its last step made. Duplicates and
// links are dropped; the files are no longer the sub-run's temporary ones.
func keptFiles(run core.PipelineRun) []core.RunFile {
	keep := map[int]bool{}
	for i, st := range run.Steps {
		if st.Keep {
			keep[i] = true
		}
	}
	if len(keep) == 0 && len(run.Steps) > 0 {
		keep[len(run.Steps)-1] = true
	}
	seen := map[string]bool{}
	out := []core.RunFile{}
	for _, it := range run.Items {
		for si, c := range it.Cells {
			if !keep[si] || c.Status != core.CellDone {
				continue
			}
			for _, f := range c.Files {
				if f.Path == "" || seen[f.Path] {
					continue
				}
				seen[f.Path] = true
				f.Temporary, f.Missing = false, false
				out = append(out, f)
			}
		}
	}
	return out
}

// Validate side of the run action.
func validateRunJob(r *RunJob) error {
	if r == nil {
		return core.ValidationError("The step has no settings", nil)
	}
	return nil
}

func (m *Module) runSub(ctx context.Context, job *core.JobContext, o Options) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	job.SetTitle(fmt.Sprintf("Ran %s", o.Run.Name))
	files := o.Run.Files
	if files == nil {
		files = []core.RunFile{}
	}
	job.Progress(1, fmt.Sprintf("%d files from %s", len(files), o.Run.Name))
	return job.SetResult(jobResult{Files: files})
}
