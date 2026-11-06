package pipeline

import (
	"strings"
	"testing"

	"toolbox/core"
)

func TestScheduleBlockedMessage(t *testing.T) {
	long := strings.Repeat("word ", 40)
	cases := []struct {
		name  string
		check core.PipelineCheck
		want  string
	}{
		{"step problem wins", core.PipelineCheck{
			Steps:    []core.StepCheck{{}, {Problems: []string{"x"}}},
			Problems: []string{"Pick at least one day and one time"},
		}, "Fix the problems in step 2"},
		{"schedule-level problem", core.PipelineCheck{
			Problems: []string{"Pick at least one day and one time"},
		}, "Pick at least one day and one time"},
		{"pipeline-level problem is shortened", core.PipelineCheck{Problems: []string{long}}, ""},
		{"missing tools", core.PipelineCheck{Missing: []string{"ffmpeg"}}, "Install what this pipeline needs first"},
		{"nothing known", core.PipelineCheck{}, "Fix the problems first"},
	}
	for _, c := range cases {
		got := scheduleBlockedMessage(c.check)
		if c.name == "pipeline-level problem is shortened" {
			if n := len([]rune(got)); n > maxScheduleMsg || !strings.HasSuffix(got, "…") || !strings.HasPrefix(got, "word word") {
				t.Errorf("%s: %q (%d runes)", c.name, got, n)
			}
			continue
		}
		if got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestScheduleStateUsesProblemText(t *testing.T) {
	r := &Runner{}
	p := core.Pipeline{Schedule: core.ScheduleTrigger{Enabled: true}}
	st := r.scheduleState(p, core.PipelineCheck{
		Problems: []string{"A scheduled run starts with no files, but step 2 reads the run's files"},
	})
	if st.Active || !strings.HasPrefix(st.Message, "A scheduled run starts with no files") {
		t.Fatalf("state = %+v", st)
	}
}
