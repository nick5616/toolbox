package lyricvideo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// The auto action (SPEC.md §6.4): detect the lyrics, then render the video
// with them. Progress: 0–55 % lyrics, 55–100 % render.
const autoLyricsEnd = 0.55

// noWordsError marks "the detect run heard nothing" so auto can say it in
// its own words; on its own it is the lyrics action's error.
type noWordsError struct{ *core.AppError }

func (e *noWordsError) Unwrap() error { return e.AppError }

func (m *Module) runAuto(ctx context.Context, job *core.JobContext, o Options) error {
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	job.SetTitle(filepath.Base(job.Inputs[0]))

	lo := o
	lo.Action, lo.Source = ActionLyrics, SourceDetect
	var lyr Result
	err := m.doLyrics(ctx, job.Scoped(0, autoLyricsEnd), lo, func(v any) error {
		r, ok := v.(Result)
		if !ok {
			return fmt.Errorf("unexpected lyrics result %T", v)
		}
		lyr = r
		return nil
	})
	var nw *noWordsError
	if errors.As(err, &nw) {
		return core.Errorf(core.CodeValidation, "No lyrics heard").WithHint("Use Lyric Video with pasted lyrics")
	}
	if err != nil {
		return err
	}
	if len(lyr.Lines) < 1 {
		return core.Errorf(core.CodeValidation, "No lyrics heard").WithHint("Use Lyric Video with pasted lyrics")
	}
	job.Progress(autoLyricsEnd, fmt.Sprintf("%d lines", len(lyr.Lines)))

	ro := o
	ro.Action, ro.Lines = ActionRender, lyr.Lines
	if err := validateOptions(ro); err != nil {
		return err
	}
	var rendered Result
	err = m.doRender(ctx, job.Scoped(autoLyricsEnd, 1), ro, func(v any) error {
		r, ok := v.(Result)
		if !ok {
			return fmt.Errorf("unexpected render result %T", v)
		}
		rendered = r
		return nil
	})
	if err != nil {
		return err
	}
	res := Result{
		Action: ActionAuto, Lines: lyr.Lines, Matched: lyr.Matched,
		HasInstrumental: rendered.HasInstrumental, Outputs: rendered.Outputs,
	}
	if res.Outputs == nil {
		res.Outputs = []string{}
	}
	// A long song's word timings can exceed the result cap; the lines keep
	// their text and times without the words then.
	if b, _ := json.Marshal(res); len(b) > core.MaxResultBytes {
		res.Lines = make([]LyricLine, len(lyr.Lines))
		for i, l := range lyr.Lines {
			l.Words = []LyricWord{}
			res.Lines[i] = l
		}
	}
	return job.SetResult(res)
}
