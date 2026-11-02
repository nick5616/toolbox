package videoeditor

// Timeline maths (SPEC.md Part B §B6.1 "Timeline time"). The frontend mirrors
// these rules; testdata/timeline.json holds the shared vectors.

// Span is one clip's place on the timeline, in milliseconds.
type Span struct {
	Index     int   `json:"index"`
	StartMs   int64 `json:"startMs"`
	EndMs     int64 `json:"endMs"`
	LenMs     int64 `json:"lenMs"`     // the clip's own length after speed
	OverlapMs int64 `json:"overlapMs"` // overlap with the next clip (its transition); 0 for cuts and the last clip
}

// speedOf treats an unset speed as 1.
func speedOf(c Clip) float64 {
	if c.Speed <= 0 {
		return 1
	}
	return c.Speed
}

// clipLenMs is a clip's length on the timeline: (out - in) / speed for video,
// DurationMs for photos.
func clipLenMs(c Clip) int64 {
	if c.Kind == "image" {
		return c.DurationMs
	}
	n := max(c.OutMs-c.InMs, 0)
	return int64(float64(n)/speedOf(c) + 0.5)
}

// overlapMs is the overlap between clip i and clip i+1. A cut, an unset
// duration and the last clip overlap nothing; the overlap never exceeds half
// of either neighbour (validation rejects such projects, the clamp keeps the
// maths safe for unvalidated ones).
func overlapMs(clips []Clip, i int) int64 {
	if i < 0 || i >= len(clips)-1 {
		return 0
	}
	t := clips[i].Transition
	if t.Kind == "" || t.Kind == "cut" || t.DurationMs <= 0 {
		return 0
	}
	return min(t.DurationMs, clipLenMs(clips[i])/2, clipLenMs(clips[i+1])/2)
}

// Timeline returns each clip's span.
func Timeline(doc VideoProject) []Span {
	spans := make([]Span, 0, len(doc.Clips))
	var start int64
	for i, c := range doc.Clips {
		l := clipLenMs(c)
		ov := overlapMs(doc.Clips, i)
		spans = append(spans, Span{Index: i, StartMs: start, EndMs: start + l, LenMs: l, OverlapMs: ov})
		start += l - ov
	}
	return spans
}

// DurationMs is a project's timeline length.
func DurationMs(doc VideoProject) int64 {
	spans := Timeline(doc)
	if len(spans) == 0 {
		return 0
	}
	return spans[len(spans)-1].EndMs
}
