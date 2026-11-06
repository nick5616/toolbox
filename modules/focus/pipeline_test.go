package focus

import (
	"encoding/json"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/focus"
)

var t0 = time.Date(2026, 11, 5, 16, 0, 0, 0, time.Local)

func setup(t *testing.T) (*Module, *fakeEngine, *int) {
	t.Helper()
	eng := newFake(t0)
	woke := 0
	m := &Module{eng: eng, wake: func() { woke++ }, now: func() time.Time { return t0 }}
	return m, eng, &woke
}

func opts(t *testing.T, mod func(*StepOptions)) json.RawMessage {
	t.Helper()
	o := DefaultStepOptions()
	o.ProfileID = "p1"
	if mod != nil {
		mod(&o)
	}
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func req(raw json.RawMessage, files ...core.RunFile) core.StepRequest {
	return core.StepRequest{RunID: "run1", StepID: "step1", Options: raw, Item: core.StepItem{Files: files}}
}

func TestDescribeStep(t *testing.T) {
	m, eng, _ := setup(t)
	tests := []struct {
		name    string
		mod     func(*StepOptions)
		problem string
		summary string
		vars    int
	}{
		{"ok", nil, "", "Focus · Studio · 50 min · firm", 3},
		{"no profile", func(o *StepOptions) { o.ProfileID = "" }, "Pick a profile", "Focus · no profile · 50 min · firm", 3},
		{"gone profile", func(o *StepOptions) { o.ProfileID = "zzz" }, "That profile doesn't exist any more", "", 3},
		{"minutes", func(o *StepOptions) { o.Minutes = 721 }, "Focus for 1 to 720 minutes", "", 3},
		{"until ok", func(o *StepOptions) { o.Mode = ModeUntil; o.At = "17:30" }, "", "Focus · Studio · until 17:30 · firm", 3},
		{"until bad", func(o *StepOptions) { o.Mode = ModeUntil; o.At = "25:00" }, "Enter a time like 17:30", "", 3},
		{"strength", func(o *StepOptions) { o.Strength = "iron" }, "Pick soft, firm or strict", "", 3},
		{"ifactive", func(o *StepOptions) { o.IfActive = "x" }, "Pick what to do when a session is already on", "", 3},
		{"too many extras", func(o *StepOptions) { o.Extra = make([]focus.AllowRule, focus.MaxExtra+1) }, "At most 20 extra apps", "", 3},
		{"wait", func(o *StepOptions) { o.Action = ActionWait }, "", "Wait until focus ends", 0},
		{"end", func(o *StepOptions) { o.Action = ActionEnd }, "", "End the focus session", 0},
		{"bad action", func(o *StepOptions) { o.Action = "pause" }, "Pick start, wait or end", "", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := m.DescribeStep(opts(t, tc.mod))
			if tc.problem == "" && err != nil {
				t.Fatalf("unexpected problem: %v", err)
			}
			if tc.problem != "" {
				if err == nil || core.AsAppError(err).Message != tc.problem {
					t.Fatalf("problem = %v, want %q", err, tc.problem)
				}
			}
			if tc.summary != "" && info.Summary != tc.summary {
				t.Errorf("summary = %q, want %q", info.Summary, tc.summary)
			}
			if len(info.Vars) != tc.vars {
				t.Errorf("vars = %d, want %d", len(info.Vars), tc.vars)
			}
			if !info.NoFiles || !info.Accepts.Any || !info.Accepts.URLs {
				t.Errorf("accepts/noFiles wrong: %+v", info)
			}
		})
	}

	t.Run("unsupported", func(t *testing.T) {
		eng.state.Supported = false
		defer func() { eng.state.Supported = true }()
		_, err := m.DescribeStep(opts(t, nil))
		if err == nil || core.AsAppError(err).Message != unsupportedMsg {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("unknown field", func(t *testing.T) {
		if _, err := m.DescribeStep(json.RawMessage(`{"nope":1}`)); err == nil {
			t.Fatal("want error")
		}
	})
}

func TestStartIdleSubmitsJobAndSetsVars(t *testing.T) {
	m, eng, woke := setup(t)
	files := []core.RunFile{{Path: `C:\in\a.txt`, Name: "a.txt", Role: "main"}}
	jobs, err := m.PrepareStep(t.Context(), req(opts(t, nil), files...))
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs=%v err=%v", jobs, err)
	}
	res, err := runJob(t, m, jobs[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(eng.begun) != 1 || eng.begun[0].Minutes != 50 || eng.begun[0].RunID != "run1" || eng.begun[0].StepID != "step1" || eng.begun[0].Strength != focus.StrengthFirm {
		t.Fatalf("begun = %+v", eng.begun)
	}
	want := map[string]string{"focus_ends": "16:50", "focus_minutes": "50", "focus_profile": "Studio"}
	for k, v := range want {
		if res.Vars[k] != v {
			t.Errorf("%s = %q, want %q", k, res.Vars[k], v)
		}
	}
	if len(res.Files) != 1 || res.Files[0].Path != files[0].Path || res.Files[0].Role != "main" {
		t.Errorf("files not passed through with roles: %+v", res.Files)
	}
	if *woke != 1 {
		t.Errorf("wake called %d times", *woke)
	}
}

func TestStartUntilPicksNextOccurrence(t *testing.T) {
	m, eng, _ := setup(t)
	for _, tc := range []struct {
		at   string
		want time.Time
	}{
		{"17:30", time.Date(2026, 11, 5, 17, 30, 0, 0, time.Local)},
		{"03:00", time.Date(2026, 11, 6, 3, 0, 0, 0, time.Local)}, // passed today, 11 h away tomorrow
	} {
		eng.begun = nil
		raw := opts(t, func(o *StepOptions) { o.Mode = ModeUntil; o.At = tc.at })
		jobs, err := m.PrepareStep(t.Context(), req(raw))
		if err != nil {
			t.Fatal(err)
		}
		var jo JobOptions
		b, _ := json.Marshal(jobs[0].Options)
		_ = json.Unmarshal(b, &jo)
		if jo.Start.Until != tc.want.UnixMilli() || jo.Start.Minutes != 0 {
			t.Errorf("%s: until=%d minutes=%d, want %d", tc.at, jo.Start.Until, jo.Start.Minutes, tc.want.UnixMilli())
		}
	}
}

func TestStartWhileActive(t *testing.T) {
	later := func(min int) int64 { return t0.Add(time.Duration(min) * time.Minute).UnixMilli() }
	active := func(eng *fakeEngine, endMin int) {
		eng.state.Session = &focus.Session{ID: "old", Profile: focus.Profile{Name: "Other"}, Strength: focus.StrengthSoft, EndsAt: later(endMin)}
	}

	t.Run("extend lengthens", func(t *testing.T) {
		m, eng, _ := setup(t)
		active(eng, 20)
		jobs, err := m.PrepareStep(t.Context(), req(opts(t, nil)))
		if err != nil || len(jobs) != 1 {
			t.Fatalf("jobs=%v err=%v", jobs, err)
		}
		res, err := runJob(t, m, jobs[0])
		if err != nil {
			t.Fatal(err)
		}
		if len(eng.begun) != 0 || len(eng.extended) != 1 || eng.extended[0] != later(50) {
			t.Fatalf("begun=%v extended=%v", eng.begun, eng.extended)
		}
		if eng.state.Session.Strength != focus.StrengthSoft {
			t.Error("strength changed")
		}
		if res.Vars["focus_profile"] != "Other" || res.Vars["focus_ends"] != "16:50" {
			t.Errorf("vars = %v", res.Vars)
		}
	})

	t.Run("extend never shortens", func(t *testing.T) {
		m, eng, _ := setup(t)
		active(eng, 120)
		jobs, err := m.PrepareStep(t.Context(), req(opts(t, nil)))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := runJob(t, m, jobs[0]); err != nil {
			t.Fatal(err)
		}
		if len(eng.extended) != 0 {
			t.Fatalf("extended %v although the session already ends later", eng.extended)
		}
		if eng.state.Session.EndsAt != later(120) {
			t.Error("end moved")
		}
	})

	t.Run("race: active appears after prepare", func(t *testing.T) {
		m, eng, _ := setup(t)
		jobs, _ := m.PrepareStep(t.Context(), req(opts(t, nil)))
		active(eng, 5) // a session started in between
		if _, err := runJob(t, m, jobs[0]); err != nil {
			t.Fatal(err)
		}
		if len(eng.extended) != 1 {
			t.Fatalf("extended = %v", eng.extended)
		}
	})

	t.Run("wait waits until EndsAt", func(t *testing.T) {
		m, eng, _ := setup(t)
		active(eng, 20)
		raw := opts(t, func(o *StepOptions) { o.IfActive = IfActiveWait })
		jobs, err := m.PrepareStep(t.Context(), req(raw))
		if jobs != nil || err == nil {
			t.Fatalf("jobs=%v err=%v", jobs, err)
		}
		if core.AsAppError(err).Code != core.CodeWaiting {
			t.Fatalf("code = %v", core.AsAppError(err).Code)
		}
		until, ok := core.WaitingUntil(err)
		if !ok || until.UnixMilli() != later(20) {
			t.Errorf("until = %v ok=%v", until, ok)
		}
	})

	t.Run("wait + Continue now behaves like extend", func(t *testing.T) {
		m, eng, _ := setup(t)
		active(eng, 20)
		raw := opts(t, func(o *StepOptions) { o.IfActive = IfActiveWait })
		r := req(raw)
		r.SkipWait = true
		jobs, err := m.PrepareStep(t.Context(), r)
		if err != nil || len(jobs) != 1 {
			t.Fatalf("jobs=%v err=%v", jobs, err)
		}
		if _, err := runJob(t, m, jobs[0]); err != nil {
			t.Fatal(err)
		}
		if len(eng.extended) != 1 {
			t.Errorf("extended = %v", eng.extended)
		}
	})

	t.Run("fail", func(t *testing.T) {
		m, eng, _ := setup(t)
		active(eng, 20)
		raw := opts(t, func(o *StepOptions) { o.IfActive = IfActiveFail })
		_, err := m.PrepareStep(t.Context(), req(raw))
		if err == nil || core.AsAppError(err).Code != focus.CodeActive {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestWaitStep(t *testing.T) {
	waitRaw := opts(t, func(o *StepOptions) { o.Action = ActionWait })

	t.Run("waits until EndsAt", func(t *testing.T) {
		m, eng, _ := setup(t)
		ends := t0.Add(90 * time.Minute)
		eng.state.Session = &focus.Session{EndsAt: ends.UnixMilli()}
		jobs, err := m.PrepareStep(t.Context(), req(waitRaw))
		if jobs != nil || err == nil {
			t.Fatalf("jobs=%v err=%v", jobs, err)
		}
		until, ok := core.WaitingUntil(err)
		if !ok || !until.Equal(ends) {
			t.Errorf("until = %v", until)
		}
		if got, want := core.AsAppError(err).Message, "Focus until "+ends.Format("15:04"); got != want {
			t.Errorf("message = %q, want %q", got, want)
		}
	})

	t.Run("an extension moves the deadline", func(t *testing.T) {
		m, eng, _ := setup(t)
		eng.state.Session = &focus.Session{EndsAt: t0.Add(time.Hour).UnixMilli()}
		_, e1 := m.PrepareStep(t.Context(), req(waitRaw))
		eng.state.Session.EndsAt = t0.Add(2 * time.Hour).UnixMilli()
		_, e2 := m.PrepareStep(t.Context(), req(waitRaw))
		u1, _ := core.WaitingUntil(e1)
		u2, _ := core.WaitingUntil(e2)
		if !u2.After(u1) {
			t.Errorf("%v then %v", u1, u2)
		}
	})

	t.Run("done when the session ended", func(t *testing.T) {
		m, _, _ := setup(t)
		jobs, err := m.PrepareStep(t.Context(), req(waitRaw))
		if err != nil || len(jobs) != 0 {
			t.Fatalf("jobs=%v err=%v", jobs, err)
		}
	})

	t.Run("Continue now never ends the session", func(t *testing.T) {
		m, eng, _ := setup(t)
		eng.state.Session = &focus.Session{EndsAt: t0.Add(time.Hour).UnixMilli()}
		r := req(waitRaw)
		r.SkipWait = true
		jobs, err := m.PrepareStep(t.Context(), r)
		if err != nil || len(jobs) != 0 {
			t.Fatalf("jobs=%v err=%v", jobs, err)
		}
		if eng.state.Session == nil || len(eng.calls) != 0 {
			t.Errorf("session touched: %v", eng.calls)
		}
	})
}

func TestEndStep(t *testing.T) {
	endRaw := opts(t, func(o *StepOptions) { o.Action = ActionEnd })
	files := []core.RunFile{{Path: "a.txt"}, {Path: "b.txt", Role: "x"}}

	t.Run("ends for this run", func(t *testing.T) {
		m, eng, woke := setup(t)
		eng.state.Session = &focus.Session{EndsAt: t0.Add(time.Hour).UnixMilli()}
		jobs, err := m.PrepareStep(t.Context(), req(endRaw, files...))
		if err != nil || len(jobs) != 1 {
			t.Fatalf("jobs=%v err=%v", jobs, err)
		}
		res, err := runJob(t, m, jobs[0])
		if err != nil {
			t.Fatal(err)
		}
		if len(eng.endedFor) != 1 || eng.endedFor[0] != "run1" || eng.state.Session != nil {
			t.Errorf("endedFor=%v", eng.endedFor)
		}
		if len(res.Files) != 2 || res.Files[1].Role != "x" {
			t.Errorf("files = %+v", res.Files)
		}
		if *woke != 1 {
			t.Errorf("woke = %d", *woke)
		}
	})

	t.Run("not yours is the engine's error", func(t *testing.T) {
		m, eng, _ := setup(t)
		eng.state.Session = &focus.Session{}
		eng.endErr = core.Errorf(focus.CodeNotYours, "Another focus session is on")
		jobs, _ := m.PrepareStep(t.Context(), req(endRaw))
		if _, err := runJob(t, m, jobs[0]); err == nil || core.AsAppError(err).Code != focus.CodeNotYours {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("no session is fine", func(t *testing.T) {
		m, _, _ := setup(t)
		jobs, _ := m.PrepareStep(t.Context(), req(endRaw))
		if _, err := runJob(t, m, jobs[0]); err != nil {
			t.Fatal(err)
		}
	})
}

func TestStepOutputsFallsBackToInputs(t *testing.T) {
	m, _, _ := setup(t)
	res, err := m.StepOutputs(core.Job{Inputs: []string{"a", "b"}})
	if err != nil || len(res.Files) != 2 || res.Files[0].Path != "a" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestNextAt(t *testing.T) {
	// A DST night in Los Angeles: 2026-11-01 repeats 01:00-02:00.
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Skip("no tzdata")
	}
	now := time.Date(2026, 11, 1, 23, 0, 0, 0, la)
	got, ok := nextAt(now, "07:30")
	if !ok || got.Hour() != 7 || got.Day() != 2 {
		t.Errorf("got %v ok=%v", got, ok)
	}
	if _, ok := nextAt(now, "7:5"); ok {
		t.Error("7:5 should be refused")
	}
}
