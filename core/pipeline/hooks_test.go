package pipeline

import (
	"context"
	"testing"
	"time"

	"toolbox/core"
)

func TestDescribeAcceptsFileAndFilesVars(t *testing.T) {
	e := newEnv(t, 2, &timerStep{})
	e.start()
	mk := func(arg string) core.Pipeline {
		p := timerPipeline("vars")
		p.Steps[0].OptionsJSON = `{"args":["` + arg + `"]}`
		return p
	}
	if chk := e.r.Describe(mk("{file} {files} {name}")); !chk.Ready {
		t.Fatalf("problems = %v %v", chk.Problems, chk.Steps[0].Problems)
	}
	if chk := e.r.Describe(mk("{nope}")); chk.Ready {
		t.Fatal("an unknown variable must still be a problem")
	}
}

func TestRunFinishedHookMayCallBackIntoTheRunner(t *testing.T) {
	e := newEnv(t, 2, &timerStep{})
	r := e.newRunner()
	got := make(chan core.PipelineRun, 1)
	r.OnRunFinished(func(run core.PipelineRun) {
		cur, err := r.Run(run.ID) // would deadlock on the loop goroutine
		if err == nil {
			got <- cur
		}
	})
	must(t, r.Start(context.Background()))
	t.Cleanup(r.Stop)
	e.r = r
	p := e.save(timerPipeline("reenter"))
	run := startNoFiles(t, e, p)
	select {
	case cur := <-got:
		eq(t, "id", cur.ID, run.ID)
	case <-time.After(10 * time.Second):
		t.Fatal("hook never completed")
	}
}
