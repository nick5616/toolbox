package pipeline

import (
	"encoding/json"

	"toolbox/core"
)

// Describe checks a pipeline (SPEC.md §8.8). Wave 0 resolves step types and
// asks each adapter to describe its options; WP-PR1 adds every other rule.
func (r *Runner) Describe(p core.Pipeline) core.PipelineCheck {
	check := core.PipelineCheck{
		Steps:    make([]core.StepCheck, 0, len(p.Steps)),
		Accepts:  core.Accepts{Extensions: []string{}},
		Problems: []string{},
		Secrets:  []core.SecretAsk{},
		Missing:  []string{},
	}
	for _, s := range p.Steps {
		sc := core.StepCheck{StepID: s.ID, Problems: []string{}, Vars: []core.StepVar{}}
		t, a, ok := r.stepType(s.Type)
		switch {
		case !ok:
			sc.Problems = append(sc.Problems, "This step's tool isn't available")
		case a != nil && !s.Manual:
			info, err := a.DescribeStep(json.RawMessage(s.OptionsJSON))
			if err != nil {
				sc.Problems = append(sc.Problems, core.AsAppError(err).Message)
			}
			sc.Info = info
		default:
			sc.Info = core.StepInfo{Accepts: t.Accepts}
		}
		check.Steps = append(check.Steps, sc)
	}
	return check
}
