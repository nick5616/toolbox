package viz

import (
	"context"
	"crypto/sha1"
	"encoding/binary"
	"encoding/json"

	"toolbox/core"
	"toolbox/core/lyrics"
)

// renderVia is the render seam (tests replace it).
var renderVia = func(ctx context.Context, b *RenderBroker, job *core.JobContext, plan RenderPlan) (RenderOutput, error) {
	return b.Render(ctx, job, plan)
}

// analysisShare is the part of a RenderVisuals range given to the analysis.
const analysisShare = 0.45

// Range is a part of the input to render (ms); EndMs 0 means to the end.
type Range struct {
	StartMs, EndMs int64
}

// RenderVisuals analyses input (cached), then renders spec's design without
// text at w×h/fps over rng (SPEC.md §4.3). Progress is mapped into [p0, p1].
func RenderVisuals(ctx context.Context, job *core.JobContext, a *Analyzer, b *RenderBroker,
	input string, spec VisualsSpec, lines []lyrics.Line, w, h, fps int, mode RenderMode, rng Range, p0, p1 float64) (RenderOutput, error) {
	show, err := showWithoutText(spec.ShowJSON)
	if err != nil {
		return RenderOutput{}, err
	}
	o := AnalyzeOptions{Stems: spec.Stems, Words: WordsNone}
	if spec.UseWords && len(lines) > 0 {
		o.Words, o.Lines, o.Mood = WordsGiven, lines, true
	}
	mid := p0 + (p1-p0)*analysisShare
	ref, err := a.Analyze(ctx, job.Scoped(p0, mid), input, o)
	if err != nil {
		return RenderOutput{}, err
	}
	if err := ctx.Err(); err != nil {
		return RenderOutput{}, err
	}
	if rng.EndMs <= 0 || rng.EndMs > ref.Summary.DurationMs {
		rng.EndMs = ref.Summary.DurationMs
	}
	if rng.StartMs < 0 || rng.StartMs >= rng.EndMs {
		return RenderOutput{}, core.ValidationError("The range is empty", map[string]string{"range": "The range is empty"})
	}
	sum := sha1.Sum([]byte(ref.Key))
	plan := RenderPlan{
		Analysis: ref, ShowJSON: show, Width: w, Height: h, FPS: fps,
		StartMs: rng.StartMs, EndMs: rng.EndMs, Mode: mode,
		Seed: int64(binary.BigEndian.Uint64(sum[:8]) >> 12),
	}
	return renderVia(ctx, b, job.Scoped(mid, p1), plan)
}

// showWithoutText forces the design's "text" to null (visuals never draw text
// when another tool draws it) and checks the size and shape.
func showWithoutText(showJSON string) (string, error) {
	bad := func(msg string) error {
		return core.ValidationError(msg, map[string]string{"showJson": msg})
	}
	if len(showJSON) == 0 || len(showJSON) > MaxShowBytes {
		return "", bad("The visual design is missing or too large")
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(showJSON), &m); err != nil || m == nil {
		return "", bad("The visual design isn't valid")
	}
	m["text"] = json.RawMessage("null")
	out, err := json.Marshal(m)
	if err != nil {
		return "", bad("The visual design isn't valid")
	}
	return string(out), nil
}
