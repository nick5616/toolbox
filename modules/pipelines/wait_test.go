package pipelines

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

func waitReq(o WaitStep, until int64, skip bool) core.StepRequest {
	b, _ := json.Marshal(o)
	return core.StepRequest{Options: b, Until: until, SkipWait: skip}
}

func waitErr(t *testing.T, jobs []core.StepJob, err error) (time.Time, string) {
	t.Helper()
	if len(jobs) != 0 {
		t.Fatalf("jobs = %v", jobs)
	}
	until, ok := core.WaitingUntil(err)
	if !ok {
		t.Fatalf("err = %v, want a waiting-until error", err)
	}
	return until, core.AsAppError(err).Message
}

func TestWaitForKeepsItsDeadline(t *testing.T) {
	now := time.Date(2026, 5, 4, 9, 0, 0, 0, time.Local)
	w := &waitStep{now: func() time.Time { return now }}
	o := WaitStep{Mode: WaitFor, Minutes: 25}

	jobs, err := w.PrepareStep(context.Background(), waitReq(o, 0, false))
	until, msg := waitErr(t, jobs, err)
	if want := now.Add(25 * time.Minute); !until.Equal(want) {
		t.Fatalf("until = %v, want %v", until, want)
	}
	if msg != "Waiting until 09:25" {
		t.Fatalf("message = %q", msg)
	}

	// Ten minutes later (a restart, say) the stored deadline decides.
	now = now.Add(10 * time.Minute)
	jobs, err = w.PrepareStep(context.Background(), waitReq(o, until.UnixMilli(), false))
	again, _ := waitErr(t, jobs, err)
	if !again.Equal(until) {
		t.Fatalf("deadline moved: %v -> %v", until, again)
	}

	// At the deadline the step is done: zero jobs, no error.
	now = until
	jobs, err = w.PrepareStep(context.Background(), waitReq(o, until.UnixMilli(), false))
	if err != nil || len(jobs) != 0 {
		t.Fatalf("done = %v, %v", jobs, err)
	}
}

func TestWaitNoteAndSkip(t *testing.T) {
	now := time.Date(2026, 5, 4, 9, 0, 0, 0, time.Local)
	w := &waitStep{now: func() time.Time { return now }}
	o := WaitStep{Mode: WaitFor, Minutes: 5, Note: "  Stretch  "}
	jobs, err := w.PrepareStep(context.Background(), waitReq(o, 0, false))
	if _, msg := waitErr(t, jobs, err); msg != "Stretch" {
		t.Fatalf("message = %q", msg)
	}
	jobs, err = w.PrepareStep(context.Background(), waitReq(o, 0, true))
	if err != nil || len(jobs) != 0 {
		t.Fatalf("skip = %v, %v", jobs, err)
	}
}

func TestWaitUntilPicksTomorrowWhenPassed(t *testing.T) {
	loc := time.Local
	at := func(d, h, m int) time.Time { return time.Date(2026, 5, d, h, m, 0, 0, loc) }
	for _, c := range []struct {
		now, want time.Time
		msg       string
	}{
		{at(4, 9, 0), at(4, 17, 30), "Waiting until 17:30"},
		{at(4, 17, 30), at(4, 17, 30), ""}, // exactly now: done
		{at(4, 17, 31), at(5, 17, 30), "Waiting until 17:30"},
		{at(31, 23, 0), time.Date(2026, 6, 1, 17, 30, 0, 0, loc), "Waiting until 17:30"},
	} {
		now := c.now
		w := &waitStep{now: func() time.Time { return now }}
		jobs, err := w.PrepareStep(context.Background(), waitReq(WaitStep{Mode: WaitUntil, At: "17:30"}, 0, false))
		if c.msg == "" {
			if err != nil || len(jobs) != 0 {
				t.Errorf("%v: want done, got %v %v", c.now, jobs, err)
			}
			continue
		}
		until, msg := waitErr(t, jobs, err)
		if !until.Equal(c.want) || msg != c.msg {
			t.Errorf("%v: until = %v (%q), want %v", c.now, until, msg, c.want)
		}
	}
}

func TestWaitDescribe(t *testing.T) {
	w := &waitStep{}
	desc := func(o WaitStep) (core.StepInfo, error) {
		b, _ := json.Marshal(o)
		return w.DescribeStep(b)
	}
	info, err := desc(WaitStep{Mode: WaitFor, Minutes: 25})
	if err != nil || info.Summary != "25 min" || !info.NoFiles || !info.Accepts.Any || !info.Accepts.URLs {
		t.Fatalf("for: %+v %v", info, err)
	}
	info, err = desc(WaitStep{Mode: WaitUntil, At: "7:05"})
	if err != nil || info.Summary != "until 07:05" {
		t.Fatalf("until: %+v %v", info, err)
	}
	if info, err = w.DescribeStep(nil); err != nil || info.Summary != "25 min" {
		t.Fatalf("defaults: %+v %v", info, err)
	}
	for name, o := range map[string]WaitStep{
		"zero minutes": {Mode: WaitFor, Minutes: 0},
		"too long":     {Mode: WaitFor, Minutes: 1441},
		"bad time":     {Mode: WaitUntil, At: "25:00"},
		"no colon":     {Mode: WaitUntil, At: "1730"},
		"bad mode":     {Mode: "sometime", Minutes: 5},
		"long note":    {Mode: WaitFor, Minutes: 5, Note: strings.Repeat("x", 201)},
	} {
		if _, err := desc(o); err == nil || core.AsAppError(err).Code != core.CodeValidation {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := w.DescribeStep(json.RawMessage(`{"bogus":1}`)); err == nil {
		t.Error("unknown field must fail")
	}
	// A bad value is also refused at prepare time (a bind may have set it).
	if _, err := w.PrepareStep(context.Background(), waitReq(WaitStep{Mode: WaitFor, Minutes: 0}, 0, false)); err == nil {
		t.Error("prepare must refuse 0 minutes")
	}
}
