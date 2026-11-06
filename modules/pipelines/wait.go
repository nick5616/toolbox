package pipelines

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"toolbox/core"
)

// waitStep is the Wait built-in (SPEC.md §3.2): "for N minutes" or "until
// HH:MM". PrepareStep returns core.ErrWaitingUntil until the deadline, which
// stays fixed through req.Until (the runner stores it with the cell, so it
// survives retries and restarts), then zero jobs: files pass through.
type waitStep struct {
	m   *Module
	now func() time.Time // tests; nil = time.Now
}

const (
	waitMinMinutes = 1
	waitMaxMinutes = 1440
	waitMaxNote    = 200
)

func (w *waitStep) clock() time.Time {
	if w.now != nil {
		return w.now()
	}
	return time.Now()
}

func (w *waitStep) StepDefaults() any { return DefaultWait() }

// parseWaitClock reads "HH:MM" (24 h); one-digit hours are accepted.
func parseWaitClock(s string) (h, m int, ok bool) {
	hs, ms, found := strings.Cut(strings.TrimSpace(s), ":")
	if !found || len(ms) != 2 || len(hs) < 1 || len(hs) > 2 {
		return 0, 0, false
	}
	h, err1 := strconv.Atoi(hs)
	m, err2 := strconv.Atoi(ms)
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 ||
		strings.ContainsAny(hs+ms, "+- ") {
		return 0, 0, false
	}
	return h, m, true
}

// checkWait validates the options.
func checkWait(o WaitStep) error {
	if utf8.RuneCountInString(o.Note) > waitMaxNote {
		return core.ValidationError(fmt.Sprintf("The note is too long (%d characters at most)", waitMaxNote), map[string]string{"note": "Too long"})
	}
	switch o.Mode {
	case WaitFor:
		if o.Minutes < waitMinMinutes || o.Minutes > waitMaxMinutes {
			return core.ValidationError(fmt.Sprintf("Wait between %d and %d minutes", waitMinMinutes, waitMaxMinutes), map[string]string{"minutes": "Between 1 and 1440"})
		}
	case WaitUntil:
		if _, _, ok := parseWaitClock(o.At); !ok {
			return core.ValidationError("Type the time as HH:MM, e.g. 17:30", map[string]string{"at": "Use HH:MM (24 hours)"})
		}
	default:
		return core.ValidationError("Choose how to wait: for some minutes or until a time", map[string]string{"mode": "Choose for or until"})
	}
	return nil
}

func (w *waitStep) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options, DefaultWait())
	if err != nil {
		return core.StepInfo{}, err
	}
	info := core.StepInfo{
		Accepts: core.Accepts{Extensions: []string{}, URLs: true, Any: true}, NoFiles: true,
		Produces: []core.StepProduct{{Many: true}}, Vars: []core.StepVar{}, Secrets: []core.StepSecret{},
		Templates: []string{}, Warnings: []string{}, Summary: "Wait",
	}
	if err := checkWait(o); err != nil {
		return info, err
	}
	if o.Mode == WaitFor {
		info.Summary = fmt.Sprintf("%d min", o.Minutes)
	} else {
		h, m, _ := parseWaitClock(o.At)
		info.Summary = fmt.Sprintf("until %02d:%02d", h, m)
	}
	return info, nil
}

// deadline is the moment the wait ends: the stored one, else a new one.
func (w *waitStep) deadline(o WaitStep, now time.Time, stored int64) time.Time {
	if stored > 0 {
		return time.UnixMilli(stored)
	}
	if o.Mode == WaitFor {
		return now.Add(time.Duration(o.Minutes) * time.Minute)
	}
	h, m, _ := parseWaitClock(o.At)
	l := now.Local()
	t := time.Date(l.Year(), l.Month(), l.Day(), h, m, 0, 0, time.Local)
	if t.Before(now) {
		t = time.Date(l.Year(), l.Month(), l.Day()+1, h, m, 0, 0, time.Local)
	}
	return t
}

func (w *waitStep) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options, DefaultWait())
	if err != nil {
		return nil, err
	}
	if req.SkipWait {
		return nil, nil
	}
	if err := checkWait(o); err != nil {
		return nil, err
	}
	now := w.clock()
	until := w.deadline(o, now, req.Until)
	if !now.Before(until) {
		return nil, nil
	}
	msg := strings.TrimSpace(o.Note)
	if msg == "" {
		msg = "Waiting until " + until.Local().Format("15:04")
	}
	return nil, core.ErrWaitingUntil(msg, "", until)
}

func (w *waitStep) StepOutputs(job core.Job) (core.StepResult, error) {
	return core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}, nil
}
