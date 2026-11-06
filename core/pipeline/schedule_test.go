package pipeline

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"toolbox/core"
)

func laLoc(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Skipf("no tz database: %v", err)
	}
	return loc
}

func allDays() []int { return []int{0, 1, 2, 3, 4, 5, 6} }

func TestParseClock(t *testing.T) {
	for _, c := range []struct {
		in   string
		h, m int
		ok   bool
	}{
		{"09:30", 9, 30, true}, {"9:30", 9, 30, true}, {"00:00", 0, 0, true}, {"23:59", 23, 59, true},
		{"24:00", 0, 0, false}, {"12:60", 0, 0, false}, {"12:5", 0, 0, false}, {"", 0, 0, false},
		{"ab:cd", 0, 0, false}, {"1230", 0, 0, false}, {"+1:30", 0, 0, false}, {"-1:30", 0, 0, false},
	} {
		h, m, ok := parseClock(c.in)
		if ok != c.ok || (ok && (h != c.h || m != c.m)) {
			t.Errorf("parseClock(%q) = %d,%d,%v", c.in, h, m, ok)
		}
	}
}

func TestNormalizeSchedule(t *testing.T) {
	good := core.ScheduleTrigger{Enabled: true, Days: []int{5, 1, 1}, Times: []string{"9:30", "09:30", "08:00"}, CatchUpMin: 30}
	if err := normalizeSchedule(&good); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(good.Days, []int{1, 5}) || !reflect.DeepEqual(good.Times, []string{"08:00", "09:30"}) {
		t.Fatalf("normalized = %+v", good)
	}
	var thirteen []string
	for h := 0; h < 13; h++ {
		thirteen = append(thirteen, time.Date(2026, 1, 1, h, 0, 0, 0, time.UTC).Format("15:04"))
	}
	for name, s := range map[string]core.ScheduleTrigger{
		"no days":     {Enabled: true, Times: []string{"09:00"}},
		"no times":    {Enabled: true, Days: []int{1}},
		"bad day":     {Days: []int{7}, Times: []string{"09:00"}},
		"neg day":     {Days: []int{-1}, Times: []string{"09:00"}},
		"bad time":    {Times: []string{"25:00"}, Days: []int{1}},
		"13 times":    {Times: thirteen, Days: []int{1}},
		"catch-up":    {Days: []int{1}, Times: []string{"09:00"}, CatchUpMin: 721},
		"neg catchup": {Days: []int{1}, Times: []string{"09:00"}, CatchUpMin: -1},
	} {
		s := s
		err := normalizeSchedule(&s)
		if err == nil {
			t.Errorf("%s: want an error", name)
			continue
		}
		if ae := core.AsAppError(err); ae.Code != core.CodeValidation || ae.Fields["schedule"] == "" {
			t.Errorf("%s: err = %+v", name, ae)
		}
	}
	// A disabled schedule keeps its values and needs no day or time.
	off := core.ScheduleTrigger{Days: []int{2}, Times: []string{"10:00"}}
	if err := normalizeSchedule(&off); err != nil || !reflect.DeepEqual(off.Days, []int{2}) {
		t.Fatalf("disabled: %v %+v", err, off)
	}
	empty := core.ScheduleTrigger{}
	if err := normalizeSchedule(&empty); err != nil || empty.Days == nil || empty.Times == nil {
		t.Fatalf("empty: %v %+v", err, empty)
	}
	e := core.ScheduleTrigger{Enabled: true}
	err := normalizeSchedule(&e)
	if err == nil || core.AsAppError(err).Message != "Pick at least one day and one time" {
		t.Fatalf("err = %v", err)
	}
}

func TestNextFireAcrossDays(t *testing.T) {
	loc := time.UTC
	s := core.ScheduleTrigger{Enabled: true, Days: []int{1, 4}, Times: []string{"09:00", "17:30"}} // Mon, Thu
	at := func(d, h, m int) time.Time { return time.Date(2026, 3, d, h, m, 0, 0, loc) }
	// 2026-03-04 is a Wednesday.
	for _, c := range []struct{ after, want time.Time }{
		{at(4, 12, 0), at(5, 9, 0)},                             // Wed noon -> Thu 09:00
		{at(5, 9, 0), at(5, 17, 30)},                            // strictly after
		{at(5, 17, 30), at(9, 9, 0)},                            // Thu evening -> Mon
		{at(9, 8, 59), at(9, 9, 0)},                             // same day
		{at(7, 3, 0), at(9, 9, 0)},                              // weekend
		{at(1, 0, 0), at(2, 9, 0)},                              // Sun -> Mon
		{at(9, 17, 30), at(12, 9, 0)},                           // Mon eve -> Thu
		{at(31, 18, 0), time.Date(2026, 4, 2, 9, 0, 0, 0, loc)}, // month boundary (Tue 31st -> Thu)
	} {
		if got := nextFire(s, c.after, loc); !got.Equal(c.want) {
			t.Errorf("nextFire(%v) = %v, want %v", c.after, got, c.want)
		}
	}
	if got := nextFire(core.ScheduleTrigger{Days: []int{}, Times: []string{"09:00"}}, at(1, 0, 0), loc); !got.IsZero() {
		t.Fatalf("no days: %v", got)
	}
}

func TestLatestSlot(t *testing.T) {
	loc := time.UTC
	s := core.ScheduleTrigger{Enabled: true, Days: allDays(), Times: []string{"08:00", "09:00"}}
	at := func(d, h, m int) time.Time { return time.Date(2026, 3, d, h, m, 0, 0, loc) }
	if got := latestSlot(s, at(10, 7, 0), at(10, 9, 20), loc); !got.Equal(at(10, 9, 0)) {
		t.Fatalf("latest = %v", got)
	}
	if got := latestSlot(s, at(10, 9, 0), at(10, 9, 20), loc); !got.IsZero() {
		t.Fatalf("already fired: %v", got)
	}
	// A slot exactly at now counts; one exactly at last doesn't.
	if got := latestSlot(s, at(10, 8, 30), at(10, 9, 0), loc); !got.Equal(at(10, 9, 0)) {
		t.Fatalf("at now: %v", got)
	}
	// Missed for days: only the most recent slot.
	if got := latestSlot(s, at(3, 0, 0), at(10, 8, 30), loc); !got.Equal(at(10, 8, 0)) {
		t.Fatalf("days later: %v", got)
	}
	weekly := core.ScheduleTrigger{Enabled: true, Days: []int{1}, Times: []string{"10:00"}} // Monday
	if got := latestSlot(weekly, at(1, 0, 0), at(10, 9, 0), loc); !got.Equal(at(9, 10, 0)) {
		t.Fatalf("weekly: %v", got)
	}
}

func TestDaylightSavingGapAndRepeat(t *testing.T) {
	loc := laLoc(t)
	utc := func(y int, mo time.Month, d, h, mi int) time.Time { return time.Date(y, mo, d, h, mi, 0, 0, time.UTC) }

	// Spring forward 2026-03-08: 02:00 PST jumps to 03:00 PDT; 02:30 doesn't exist.
	spring := core.ScheduleTrigger{Enabled: true, Days: allDays(), Times: []string{"01:30", "02:30", "03:15"}}
	slots := slotsOn(spring, 2026, time.March, 8, loc)
	want := []time.Time{
		utc(2026, 3, 8, 9, 30),  // 01:30 PST
		utc(2026, 3, 8, 10, 0),  // 02:30 -> the first valid minute after: 03:00 PDT
		utc(2026, 3, 8, 10, 15), // 03:15 PDT
	}
	for i := range want {
		if !slots[i].Equal(want[i]) {
			t.Errorf("spring slot %d = %v, want %v", i, slots[i].UTC(), want[i])
		}
	}
	// The gap slot fires once, at 03:00.
	fired := latestSlot(core.ScheduleTrigger{Days: allDays(), Times: []string{"02:30"}}, utc(2026, 3, 8, 9, 0), utc(2026, 3, 8, 10, 5), loc)
	if !fired.Equal(utc(2026, 3, 8, 10, 0)) {
		t.Errorf("gap slot fires at %v", fired.UTC())
	}
	if got := latestSlot(core.ScheduleTrigger{Days: allDays(), Times: []string{"02:30"}}, utc(2026, 3, 8, 9, 0), utc(2026, 3, 8, 9, 59), loc); !got.IsZero() {
		t.Errorf("gap slot fired early at %v", got)
	}
	// The day before and after are plain.
	if got := slotsOn(spring, 2026, time.March, 9, loc)[1]; !got.Equal(utc(2026, 3, 9, 9, 30)) { // 02:30 PDT
		t.Errorf("after the gap 02:30 = %v", got.UTC())
	}

	// Fall back 2026-11-01: 02:00 PDT returns to 01:00 PST; 01:30 happens twice.
	fall := core.ScheduleTrigger{Enabled: true, Days: allDays(), Times: []string{"00:30", "01:30", "02:30"}}
	slots = slotsOn(fall, 2026, time.November, 1, loc)
	want = []time.Time{
		utc(2026, 11, 1, 7, 30),  // 00:30 PDT
		utc(2026, 11, 1, 8, 30),  // 01:30 PDT, the first of two
		utc(2026, 11, 1, 10, 30), // 02:30 PST
	}
	for i := range want {
		if !slots[i].Equal(want[i]) {
			t.Errorf("fall slot %d = %v, want %v", i, slots[i].UTC(), want[i])
		}
	}
	// Once the first 01:30 fired, the second one (09:30 UTC) is not a slot.
	one := core.ScheduleTrigger{Days: allDays(), Times: []string{"01:30"}}
	if got := latestSlot(one, utc(2026, 11, 1, 8, 30), utc(2026, 11, 1, 9, 45), loc); !got.IsZero() {
		t.Errorf("repeated 01:30 fired twice: %v", got.UTC())
	}
	if got := latestSlot(one, utc(2026, 11, 1, 0, 0), utc(2026, 11, 1, 9, 45), loc); !got.Equal(utc(2026, 11, 1, 8, 30)) {
		t.Errorf("first 01:30 = %v", got.UTC())
	}
	// And the next fire after the first one is tomorrow's.
	if got := nextFire(one, utc(2026, 11, 1, 8, 30), loc); !got.Equal(utc(2026, 11, 2, 9, 30)) {
		t.Errorf("next after the repeat = %v", got.UTC())
	}
}

// --- running schedules ---

func schedPipeline(name string, times ...string) core.Pipeline {
	p := timerPipeline(name)
	p.Schedule = core.ScheduleTrigger{Enabled: true, Days: allDays(), Times: times, CatchUpMin: 30}
	return p
}

func (e *env) schedRuns(pipelineID string) []core.PipelineRun {
	e.t.Helper()
	runs, err := e.r.Runs(core.RunFilter{PipelineID: pipelineID})
	must(e.t, err)
	return runs
}

func (e *env) setLast(id string, at time.Time) {
	e.t.Helper()
	must(e.t, e.db.SetScheduleFired(context.Background(), id, at.UnixMilli()))
}

func (e *env) lastFired(id string) time.Time {
	e.t.Helper()
	at, err := e.db.ScheduleFired(context.Background(), id)
	must(e.t, err)
	return time.UnixMilli(at).UTC()
}

func TestScheduleCatchUpFiresOnlyTheLatestSlotWithinTheWindow(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	day := func(h, m int) time.Time { return time.Date(2026, 5, 4, h, m, 0, 0, time.UTC) }
	clk := newFakeClock(day(6, 0))
	e.startAt(clk, nil)
	p := e.save(schedPipeline("catch", "08:00", "09:00"))
	e.setLast(p.ID, day(7, 0))

	// 09:20: the 09:00 slot is 20 min old (within 30); 08:00 is older and dropped.
	clk.Set(day(9, 20))
	e.r.scheduleTick(true)
	until(t, "one run", func() bool { return len(e.schedRuns(p.ID)) == 1 })
	runs := e.schedRuns(p.ID)
	eq(t, "trigger", runs[0].Trigger, "schedule")
	eq(t, "items", len(runs[0].Items), 1)
	eq(t, "last fire", e.lastFired(p.ID), day(9, 0))
	e.r.scheduleTick(true)
	time.Sleep(50 * time.Millisecond)
	eq(t, "no second run", len(e.schedRuns(p.ID)), 1)
	e.waitStatus(runs[0].ID, core.RunDone)

	// 12:00 after a long sleep: the 09:00 slot is 3 h old -> dropped, but the
	// last-fire moves on so it isn't reconsidered.
	clk.Set(day(12, 0))
	e.r.scheduleTick(true)
	time.Sleep(50 * time.Millisecond)
	eq(t, "dropped slot starts nothing", len(e.schedRuns(p.ID)), 1)
	eq(t, "last fire advanced", e.lastFired(p.ID), day(9, 0))
	p2 := e.save(schedPipeline("catch0", "10:00"))
	p2.Schedule.CatchUpMin = 0
	p2 = e.save(p2)
	e.setLast(p2.ID, day(7, 0))
	e.r.scheduleTick(true) // 12:00, the 10:00 slot is 2 h old; CatchUpMin 0
	time.Sleep(50 * time.Millisecond)
	eq(t, "no catch-up with 0", len(e.schedRuns(p2.ID)), 0)
	eq(t, "slot consumed", e.lastFired(p2.ID), day(10, 0))
}

func TestScheduleTimerFiresTheSlotItself(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	day := func(h, m, s int) time.Time { return time.Date(2026, 5, 4, h, m, s, 0, time.UTC) }
	clk := newFakeClock(day(8, 59, 58))
	e.startAt(clk, nil)
	p := e.save(schedPipeline("tick", "09:00"))
	eq(t, "baselined at save", e.lastFired(p.ID), day(8, 59, 58))
	clk.Set(day(9, 0, 5))
	e.r.scheduleTick(false) // CatchUpMin is 30, and a plain tick has 90 s of slack at least
	until(t, "a run", func() bool { return len(e.schedRuns(p.ID)) == 1 })
}

func TestScheduleSkipsWhileTheLastRunIsGoing(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	day := func(h, m int) time.Time { return time.Date(2026, 5, 4, h, m, 0, 0, time.UTC) }
	clk := newFakeClock(day(8, 0))
	e.startAt(clk, nil)
	ts.fn = waitUntil(func() time.Time { return time.Now().Add(time.Hour) }, time.Now)
	p := e.save(schedPipeline("overlap", "09:30", "10:00"))
	e.setLast(p.ID, day(8, 0))

	clk.Set(day(9, 31))
	e.r.scheduleTick(false)
	until(t, "first run", func() bool { return len(e.schedRuns(p.ID)) == 1 })
	first := e.schedRuns(p.ID)[0]
	e.waitRun(first.ID, "time wait", func(r core.PipelineRun) bool { return cellOf(r, 0, 0).Wait == core.WaitTime })

	clk.Set(day(10, 0))
	e.r.scheduleTick(false)
	time.Sleep(50 * time.Millisecond)
	eq(t, "no overlapping run", len(e.schedRuns(p.ID)), 1)
	eq(t, "last fire still advances", e.lastFired(p.ID), day(10, 0))
	var msg string
	for _, en := range e.r.List() {
		if en.Pipeline.ID == p.ID {
			msg = en.Schedule.Message
			eq(t, "active", en.Schedule.Active, true)
		}
	}
	eq(t, "message", msg, "Skipped 10:00: the last run is still going")

	// Once it ends the next slot fires and the message goes away.
	must(t, e.r.Cancel(first.ID))
	e.waitStatus(first.ID, core.RunCancelled)
	clk.Set(day(10, 59))
	p.Schedule.Times = []string{"09:30", "10:00", "11:00"}
	e.save(p) // a changed schedule starts counting again, so the 11:00 slot is the next one
	clk.Set(day(11, 1))
	e.r.scheduleTick(false)
	until(t, "second run", func() bool { return len(e.schedRuns(p.ID)) == 2 })
	for _, en := range e.r.List() {
		if en.Pipeline.ID == p.ID {
			eq(t, "message cleared", en.Schedule.Message, "")
		}
	}
}

func TestScheduleNoDoubleFireAfterARestart(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	day := func(h, m int) time.Time { return time.Date(2026, 5, 4, h, m, 0, 0, time.UTC) }
	clk := newFakeClock(day(8, 0))
	first := e.startAt(clk, nil)
	p := e.save(schedPipeline("restart", "09:00"))
	e.setLast(p.ID, day(8, 0))
	clk.Set(day(9, 1))
	first.scheduleTick(false)
	until(t, "a run", func() bool { return len(e.schedRuns(p.ID)) == 1 })
	first.Stop()

	e.startAt(clk, nil) // Start catches up: the 09:00 slot already fired
	time.Sleep(150 * time.Millisecond)
	e.r.scheduleTick(true)
	time.Sleep(50 * time.Millisecond)
	eq(t, "runs", len(e.schedRuns(p.ID)), 1)
}

func TestScheduleStateAndProblems(t *testing.T) {
	ts := &timerStep{}
	e := newEnv(t, 2, ts)
	day := func(h, m int) time.Time { return time.Date(2026, 5, 4, h, m, 0, 0, time.UTC) }
	clk := newFakeClock(day(8, 0))
	e.startAt(clk, nil)

	ent, err := e.r.Save(schedPipeline("state", "09:30"))
	must(t, err)
	eq(t, "active", ent.Schedule.Active, true)
	eq(t, "next", ent.Schedule.Next, day(9, 30).UnixMilli())
	eq(t, "message", ent.Schedule.Message, "")

	// Off: nothing.
	off := schedPipeline("off", "09:30")
	off.Schedule.Enabled = false
	ent, err = e.r.Save(off)
	must(t, err)
	eq(t, "inactive", ent.Schedule, core.ScheduleState{})

	// A step that reads the run's files is a problem.
	files := core.Pipeline{Name: "needs files", Steps: []core.PipelineStep{
		{ID: "aaaaaaaa", Type: "timer", From: FromNone, OptionsJSON: "{}"},
		{ID: "bbbbbbbb", Type: "timer", From: FromInput, OptionsJSON: "{}"},
	}, Schedule: core.ScheduleTrigger{Enabled: true, Days: allDays(), Times: []string{"09:00"}, CatchUpMin: 30}}
	ent, err = e.r.Save(files)
	must(t, err)
	eq(t, "takes files", ent.Check.TakesFiles, true)
	eq(t, "not active", ent.Schedule.Active, false)
	eq(t, "next", ent.Schedule.Next, int64(0))
	found := false
	for _, pr := range ent.Check.Problems {
		if pr == "A scheduled run starts with no files, but step 2 reads the run's files" {
			found = true
		}
	}
	if !found {
		t.Fatalf("problems = %v", ent.Check.Problems)
	}
	if ent.Check.Ready {
		t.Fatal("must not be ready")
	}
	clk.Set(day(9, 5))
	e.setLast(ent.Pipeline.ID, day(8, 0))
	e.r.scheduleTick(true)
	time.Sleep(50 * time.Millisecond)
	eq(t, "no run for a pipeline with problems", len(e.schedRuns(ent.Pipeline.ID)), 0)

	// Saving an enabled schedule without days or times is refused.
	bad := schedPipeline("bad", "09:30")
	bad.Schedule.Days = nil
	_, err = e.r.Save(bad)
	if err == nil || core.AsAppError(err).Fields["schedule"] == "" || !strings.Contains(err.Error(), "Pick at least one day and one time") {
		t.Fatalf("err = %v", err)
	}
	// A duplicate of a scheduled pipeline is switched off.
	dup, err := e.r.Duplicate(e.r.List()[0].Pipeline.ID)
	must(t, err)
	eq(t, "duplicate schedule", dup.Pipeline.Schedule.Enabled, false)
}
