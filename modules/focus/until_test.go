package focus

import (
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/focus"
)

func TestUntilTimeAlreadyPassed(t *testing.T) {
	untilOpts := func(at string) []byte {
		return opts(t, func(o *StepOptions) { o.Mode = ModeUntil; o.At = at })
	}

	t.Run("no session, tomorrow too far: a clear message", func(t *testing.T) {
		m, _, _ := setup(t) // 16:00
		for _, at := range []string{"09:00", "16:00", "12:00"} {
			_, err := m.PrepareStep(t.Context(), req(untilOpts(at)))
			ae := core.AsAppError(err)
			if ae == nil || ae.Code != core.CodeValidation || !strings.Contains(ae.Message, at+" has passed today and tomorrow's is more than 12 h away") {
				t.Errorf("%s: err = %v", at, err)
			}
			if ae != nil && strings.Contains(ae.Message, "12 hours at most") {
				t.Errorf("%s: the engine's message leaked: %v", at, err)
			}
		}
	})

	t.Run("no session, ahead but too far", func(t *testing.T) {
		m, _, _ := setup(t)
		m.now = func() time.Time { return time.Date(2026, 11, 5, 3, 0, 0, 0, time.Local) }
		_, err := m.PrepareStep(t.Context(), req(untilOpts("23:00")))
		if ae := core.AsAppError(err); ae == nil || !strings.Contains(ae.Message, "23:00 is more than 12 h away") {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("session on, time passed today: reached, nothing extended", func(t *testing.T) {
		m, eng, _ := setup(t)
		end := t0.Add(30 * time.Minute).UnixMilli()
		eng.state.Session = &focus.Session{ID: "old", Profile: focus.Profile{Name: "Other"}, StartedAt: t0.UnixMilli(), EndsAt: end}
		files := []core.RunFile{{Path: "a.txt"}}
		jobs, err := m.PrepareStep(t.Context(), req(untilOpts("09:00"), files...))
		if err != nil || len(jobs) != 1 {
			t.Fatalf("jobs=%v err=%v", jobs, err)
		}
		res, err := runJob(t, m, jobs[0])
		if err != nil {
			t.Fatal(err)
		}
		if len(eng.extended) != 0 || len(eng.begun) != 0 || eng.state.Session.EndsAt != end {
			t.Fatalf("session touched: extended=%v begun=%v", eng.extended, eng.begun)
		}
		if len(res.Files) != 1 || res.Files[0].Path != "a.txt" {
			t.Errorf("files = %+v", res.Files)
		}
		if res.Vars["focus_profile"] != "Other" {
			t.Errorf("vars = %v", res.Vars)
		}
	})

	t.Run("session on, time still ahead today: extends", func(t *testing.T) {
		m, eng, _ := setup(t)
		eng.state.Session = &focus.Session{ID: "old", Profile: focus.Profile{Name: "Other"}, StartedAt: t0.UnixMilli(), EndsAt: t0.Add(10 * time.Minute).UnixMilli()}
		jobs, err := m.PrepareStep(t.Context(), req(untilOpts("17:30")))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := runJob(t, m, jobs[0]); err != nil {
			t.Fatal(err)
		}
		if len(eng.extended) != 1 || eng.extended[0] != time.Date(2026, 11, 5, 17, 30, 0, 0, time.Local).UnixMilli() {
			t.Fatalf("extended = %v", eng.extended)
		}
	})
}
