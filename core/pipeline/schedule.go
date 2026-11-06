package pipeline

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"
	"time"

	"toolbox/core"
)

// The schedule trigger (Phase 18, SPEC.md §3.3). A schedule starts a run of a
// pipeline that takes no files at local clock times on chosen weekdays. It
// fires only while Toolbox runs; a slot missed while it was closed or asleep
// fires once on start or wake when it is within CatchUpMin.

const (
	maxScheduleTimes   = 12
	maxScheduleCatchUp = 720
	// scheduleSlack lets the timer and the 30 s check fire a slot that is
	// already a little past, even when CatchUpMin is 0.
	scheduleSlack = 90 * time.Second
	// maxSlotLookback is how many days back the latest slot is searched
	// (a weekly slot is at most seven days old).
	maxSlotLookback = 8
)

func (r *Runner) location() *time.Location {
	if r.cfg.Location != nil {
		return r.cfg.Location
	}
	return time.Local
}

// parseClock reads "H:MM" or "HH:MM" (24 h).
func parseClock(s string) (h, m int, ok bool) {
	hs, ms, found := strings.Cut(strings.TrimSpace(s), ":")
	if !found || len(ms) != 2 || len(hs) < 1 || len(hs) > 2 {
		return 0, 0, false
	}
	for _, part := range []string{hs, ms} {
		for _, c := range part {
			if c < '0' || c > '9' {
				return 0, 0, false
			}
		}
	}
	h = int(hs[0] - '0')
	if len(hs) == 2 {
		h = h*10 + int(hs[1]-'0')
	}
	m = int(ms[0]-'0')*10 + int(ms[1]-'0')
	if h > 23 || m > 59 {
		return 0, 0, false
	}
	return h, m, true
}

// normalizeSchedule checks and canonicalises a schedule on Save: days sorted
// and unique, times as sorted unique "HH:MM". A disabled schedule keeps its
// values but they must still be well formed.
func normalizeSchedule(s *core.ScheduleTrigger) error {
	days := make([]int, 0, len(s.Days))
	for _, d := range s.Days {
		if d < 0 || d > 6 {
			return fieldErr("schedule", "Days are 0 (Sunday) to 6 (Saturday)")
		}
		if !slices.Contains(days, d) {
			days = append(days, d)
		}
	}
	sort.Ints(days)
	times := make([]string, 0, len(s.Times))
	for _, t := range s.Times {
		h, m, ok := parseClock(t)
		if !ok {
			return fieldErr("schedule", fmt.Sprintf("%q isn't a time of day (use HH:MM, 24 hours)", t))
		}
		c := fmt.Sprintf("%02d:%02d", h, m)
		if !slices.Contains(times, c) {
			times = append(times, c)
		}
	}
	sort.Strings(times)
	if len(times) > maxScheduleTimes {
		return fieldErr("schedule", fmt.Sprintf("At most %d times a day", maxScheduleTimes))
	}
	if s.CatchUpMin < 0 || s.CatchUpMin > maxScheduleCatchUp {
		return fieldErr("schedule", fmt.Sprintf("Catch-up is 0–%d minutes", maxScheduleCatchUp))
	}
	s.Days, s.Times = days, times
	if s.Enabled && (len(days) == 0 || len(times) == 0) {
		return fieldErr("schedule", "Pick at least one day and one time")
	}
	return nil
}

// slotAt is the instant of the local clock time h:mi on the given date. A
// time that doesn't exist that day (the clocks jumped over it) is the first
// valid minute after it; a time that happens twice is the first one.
func slotAt(y int, mo time.Month, d, h, mi int, loc *time.Location) time.Time {
	target := time.Date(y, mo, d, h, mi, 0, 0, time.UTC).Unix()
	t := time.Date(y, mo, d, h, mi, 0, 0, loc).Add(-3 * time.Hour).Truncate(time.Minute)
	for i := 0; i < 8*60; i++ {
		l := t.In(loc)
		if time.Date(l.Year(), l.Month(), l.Day(), l.Hour(), l.Minute(), 0, 0, time.UTC).Unix() >= target {
			return t
		}
		t = t.Add(time.Minute)
	}
	return time.Date(y, mo, d, h, mi, 0, 0, loc)
}

// slotsOn returns the schedule's slots on the date of day (in loc).
func slotsOn(s core.ScheduleTrigger, y int, mo time.Month, d int, loc *time.Location) []time.Time {
	wd := int(time.Date(y, mo, d, 12, 0, 0, 0, loc).Weekday())
	if !slices.Contains(s.Days, wd) {
		return nil
	}
	var out []time.Time
	for _, ts := range s.Times {
		h, m, ok := parseClock(ts)
		if !ok {
			continue
		}
		out = append(out, slotAt(y, mo, d, h, m, loc))
	}
	return out
}

// nextFire is the first slot strictly after the given moment ("" zero = none).
func nextFire(s core.ScheduleTrigger, after time.Time, loc *time.Location) time.Time {
	base := after.In(loc)
	for i := 0; i <= maxSlotLookback; i++ {
		day := time.Date(base.Year(), base.Month(), base.Day()+i, 12, 0, 0, 0, loc)
		var best time.Time
		for _, sl := range slotsOn(s, day.Year(), day.Month(), day.Day(), loc) {
			if sl.After(after) && (best.IsZero() || sl.Before(best)) {
				best = sl
			}
		}
		if !best.IsZero() {
			return best
		}
	}
	return time.Time{}
}

// latestSlot is the most recent slot in (last, now] (zero = none).
func latestSlot(s core.ScheduleTrigger, last, now time.Time, loc *time.Location) time.Time {
	base := now.In(loc)
	var best time.Time
	for i := 0; i <= maxSlotLookback; i++ {
		day := time.Date(base.Year(), base.Month(), base.Day()-i, 12, 0, 0, 0, loc)
		for _, sl := range slotsOn(s, day.Year(), day.Month(), day.Day(), loc) {
			if sl.After(last) && !sl.After(now) && (best.IsZero() || sl.After(best)) {
				best = sl
			}
		}
	}
	return best
}

// scheduleProblems are the Describe problems of a schedule.
func scheduleProblems(p core.Pipeline) []string {
	if !p.Schedule.Enabled {
		return nil
	}
	var out []string
	if len(p.Schedule.Days) == 0 || len(p.Schedule.Times) == 0 {
		out = append(out, "Pick at least one day and one time")
	}
	for i, s := range p.Steps {
		if s.From == FromInput {
			out = append(out, fmt.Sprintf("A scheduled run starts with no files, but step %d reads the run's files", i+1))
			break
		}
	}
	return out
}

// scheduleState reports whether a pipeline's schedule is live and when it
// fires next.
func (r *Runner) scheduleState(p core.Pipeline, check core.PipelineCheck) core.ScheduleState {
	if !p.Schedule.Enabled {
		return core.ScheduleState{}
	}
	if !check.Ready {
		return core.ScheduleState{Message: scheduleBlockedMessage(check)}
	}
	r.pmu.RLock()
	msg := r.schedMsg[p.ID]
	r.pmu.RUnlock()
	st := core.ScheduleState{Active: true, Message: msg}
	if nx := nextFire(p.Schedule, r.now(), r.location()); !nx.IsZero() {
		st.Next = nx.UnixMilli()
	}
	return st
}

// maxScheduleMsg is the longest problem text shown as a schedule message.
const maxScheduleMsg = 80

// scheduleBlockedMessage says why a schedule isn't live: "Fix the problems in
// step N" for a step problem, else the first pipeline-level problem's own text
// (shortened), else what is missing.
func scheduleBlockedMessage(check core.PipelineCheck) string {
	for i, sc := range check.Steps {
		if len(sc.Problems) > 0 {
			return fmt.Sprintf("Fix the problems in step %d", i+1)
		}
	}
	if len(check.Problems) > 0 {
		msg := strings.TrimSpace(check.Problems[0])
		if rs := []rune(msg); len(rs) > maxScheduleMsg {
			msg = strings.TrimSpace(string(rs[:maxScheduleMsg-1])) + "…"
		}
		if msg != "" {
			return msg
		}
	}
	if len(check.Missing) > 0 {
		return "Install what this pipeline needs first"
	}
	return "Fix the problems first"
}

func (r *Runner) setScheduleMsg(id, msg string) {
	r.pmu.Lock()
	if msg == "" {
		delete(r.schedMsg, id)
	} else {
		r.schedMsg[id] = msg
	}
	r.pmu.Unlock()
}

// scheduleLast is the last slot the pipeline's schedule fired for (0 = never).
func (r *Runner) scheduleLast(id string) int64 {
	if r.cfg.Store != nil {
		at, err := r.cfg.Store.ScheduleFired(context.Background(), id)
		if err != nil {
			logErr("read schedule state", err)
		}
		return at
	}
	return r.schedLast[id]
}

func (r *Runner) setScheduleLast(id string, at int64) {
	if r.cfg.Store != nil {
		logErr("save schedule state", r.cfg.Store.SetScheduleFired(context.Background(), id, at))
		return
	}
	if r.schedLast == nil {
		r.schedLast = map[string]int64{}
	}
	r.schedLast[id] = at
}

// scheduleRunActive reports whether the previous scheduled run of the
// pipeline is still going.
func (r *Runner) scheduleRunActive(pipelineID string) bool {
	runs, err := r.Runs(core.RunFilter{PipelineID: pipelineID, ActiveOnly: true})
	if err != nil {
		return false
	}
	for _, run := range runs {
		if run.Trigger == "schedule" {
			return true
		}
	}
	return false
}

func clockText(t time.Time) string { return fmt.Sprintf("%d:%02d", t.Hour(), t.Minute()) }

// scheduleTick fires every due slot once. With catchUp (start and wake) a
// slot is fired only within the pipeline's CatchUpMin; in between a small
// slack lets the timer's own slot through. Older missed slots are dropped.
func (r *Runner) scheduleTick(catchUp bool) {
	r.schedMu.Lock()
	defer r.schedMu.Unlock()
	now := r.now()
	loc := r.location()
	for _, p := range r.snapshotPipes() {
		if !p.Schedule.Enabled || len(scheduleProblems(p)) > 0 {
			continue
		}
		if !r.Describe(p).Ready {
			continue
		}
		last := r.scheduleLast(p.ID)
		if last == 0 {
			// Never fired: start counting from now, so enabling a schedule at
			// 9:40 doesn't fire the 9:30 slot.
			r.setScheduleLast(p.ID, now.UnixMilli())
			continue
		}
		slot := latestSlot(p.Schedule, time.UnixMilli(last), now, loc)
		if slot.IsZero() {
			continue
		}
		r.setScheduleLast(p.ID, slot.UnixMilli()) // before starting: never twice
		window := time.Duration(p.Schedule.CatchUpMin) * time.Minute
		if !catchUp && window < scheduleSlack {
			window = scheduleSlack
		}
		if now.Sub(slot) > window {
			slog.Debug("pipelines: schedule slot dropped", "pipeline", p.Name, "slot", slot)
			continue
		}
		if r.scheduleRunActive(p.ID) {
			r.setScheduleMsg(p.ID, fmt.Sprintf("Skipped %s: the last run is still going", clockText(slot.In(loc))))
			r.emitPipelines()
			continue
		}
		if _, err := r.StartRun(core.RunRequest{PipelineID: p.ID}, "schedule"); err != nil {
			r.setScheduleMsg(p.ID, core.AsAppError(err).Message)
		} else {
			r.setScheduleMsg(p.ID, "")
		}
		r.emitPipelines()
	}
}

// kickSchedule wakes the schedule goroutine (never blocks).
func (r *Runner) kickSchedule(catchUp bool) {
	select {
	case r.schedKick <- catchUp:
	default:
		if catchUp { // a pending plain kick becomes a catch-up
			select {
			case <-r.schedKick:
			default:
			}
			select {
			case r.schedKick <- true:
			default:
			}
		}
	}
}

// startSchedule runs the schedule goroutine: one timer for the earliest next
// fire plus the wall-clock check.
func (r *Runner) startSchedule(ctx context.Context) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		r.scheduleTick(true)
		timer := time.NewTimer(time.Hour)
		defer timer.Stop()
		wall := time.NewTicker(r.wallEvery)
		defer wall.Stop()
		for {
			r.armSchedule(timer)
			select {
			case <-r.quit:
				return
			case <-ctx.Done():
				return
			case <-timer.C:
				r.scheduleTick(false)
			case <-wall.C:
				r.scheduleTick(false)
			case c := <-r.schedKick:
				r.scheduleTick(c)
			}
		}
	}()
}

// armSchedule sets the timer to the earliest next fire of any schedule.
func (r *Runner) armSchedule(t *time.Timer) {
	now := r.now()
	var next time.Time
	for _, p := range r.snapshotPipes() {
		if !p.Schedule.Enabled {
			continue
		}
		if nx := nextFire(p.Schedule, now, r.location()); !nx.IsZero() && (next.IsZero() || nx.Before(next)) {
			next = nx
		}
	}
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
	d := time.Hour
	if !next.IsZero() {
		d = next.Sub(now)
		if d < time.Millisecond {
			d = time.Millisecond
		}
	}
	t.Reset(d)
}
