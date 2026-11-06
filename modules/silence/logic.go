package silence

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"

	"toolbox/core"
)

// minPieceMs is the shortest kept or removed piece worth a cut.
const minPieceMs = 20

func errNothingSilent() error {
	return core.Errorf(core.CodeValidation, "There's nothing silent to cut").
		WithHint("Raise the threshold or shorten the shortest silence")
}

func errAllSilent() error {
	return core.Errorf(core.CodeValidation, "Everything is quieter than the threshold, so nothing would be left").
		WithHint("Lower the threshold")
}

// ParseSilenceDetect reads FFmpeg's silencedetect log lines into ranges (ms).
// A silence that starts and never ends runs to durationMs (or is dropped when
// that is unknown, 0). Lines that aren't silencedetect output are ignored.
func ParseSilenceDetect(r io.Reader, durationMs int64) ([]Range, error) {
	out := []Range{}
	open := int64(-1)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if i := strings.Index(line, "silence_start:"); i >= 0 {
			v, ok := leadingNumber(line[i+len("silence_start:"):])
			if !ok {
				continue
			}
			open = max(0, secToMs(v))
		} else if i := strings.Index(line, "silence_end:"); i >= 0 {
			v, ok := leadingNumber(line[i+len("silence_end:"):])
			if !ok {
				continue
			}
			end := secToMs(v)
			start := max(0, open)
			if end > start {
				out = append(out, Range{start, end})
			}
			open = -1
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read silencedetect output: %w", err)
	}
	if open >= 0 && durationMs > open {
		out = append(out, Range{open, durationMs})
	}
	return out, nil
}

func secToMs(v float64) int64 { return int64(math.Round(v * 1000)) }

// leadingNumber parses the first number in s.
func leadingNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	end := 0
	for end < len(s) && strings.IndexByte("+-.0123456789eE", s[end]) >= 0 {
		end++
	}
	v, err := strconv.ParseFloat(s[:end], 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// Plan turns detected silences into the ranges to remove and the ranges to
// keep. Each silence loses paddingMs at both inner edges (so the cut leaves
// room to breathe); a silence touching the start or end of the file keeps no
// padding on that outer side. Overlapping silences merge, and pieces shorter
// than minPieceMs are not worth a cut.
func Plan(silences []Range, durationMs int64, paddingMs int) (removed, kept []Range) {
	removed, kept = []Range{}, []Range{}
	if durationMs <= 0 {
		return
	}
	pad := int64(max(0, paddingMs))
	var cores []Range
	for _, s := range mergeRanges(silences, durationMs) {
		start, end := s.StartMs, s.EndMs
		if start > 0 {
			start += pad
		}
		if end < durationMs {
			end -= pad
		}
		if end-start >= minPieceMs {
			cores = append(cores, Range{start, end})
		}
	}
	// A kept sliver between two cuts isn't worth keeping: merge the cuts.
	for _, c := range cores {
		if n := len(removed); n > 0 && c.StartMs-removed[n-1].EndMs < minPieceMs {
			removed[n-1].EndMs = c.EndMs
			continue
		}
		removed = append(removed, c)
	}
	pos := int64(0)
	for _, r := range removed {
		if r.StartMs-pos >= minPieceMs {
			kept = append(kept, Range{pos, r.StartMs})
		}
		pos = r.EndMs
	}
	if durationMs-pos >= minPieceMs {
		kept = append(kept, Range{pos, durationMs})
	}
	return
}

// mergeRanges sorts, clamps to [0, limit] and joins overlapping or touching ranges.
func mergeRanges(in []Range, limit int64) []Range {
	rs := make([]Range, 0, len(in))
	for _, r := range in {
		r.StartMs, r.EndMs = max(0, r.StartMs), min(limit, r.EndMs)
		if r.EndMs > r.StartMs {
			rs = append(rs, r)
		}
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i].StartMs < rs[j].StartMs })
	out := rs[:0]
	for _, r := range rs {
		if n := len(out); n > 0 && r.StartMs <= out[n-1].EndMs {
			out[n-1].EndMs = max(out[n-1].EndMs, r.EndMs)
			continue
		}
		out = append(out, r)
	}
	return out
}

// total sums the lengths of rs.
func total(rs []Range) int64 {
	var n int64
	for _, r := range rs {
		n += r.EndMs - r.StartMs
	}
	return n
}

// check says why a plan can't be run, or nil.
func check(removed, kept []Range) error {
	if len(removed) == 0 {
		return errNothingSilent()
	}
	if len(kept) == 0 {
		return errAllSilent()
	}
	return nil
}

func sec(ms int64) string { return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64) }

func secF(s float64) string { return strconv.FormatFloat(s, 'f', 3, 64) }

// fadeFor is the smoothing at one join: at most crossfadeMs, at most half of
// either neighbouring piece. In seconds.
func fadeFor(crossfadeMs int, a, b Range) float64 {
	d := min(int64(crossfadeMs), (a.EndMs-a.StartMs)/2, (b.EndMs-b.StartMs)/2)
	return float64(max(0, d)) / 1000
}

// BuildGraph writes the filtergraph that keeps the given pieces. Audio-only
// files chain acrossfade joins; video files trim picture and sound in step
// and concat them (so they can't drift), with a micro fade on each side of
// every join. The result labels are [a] (audio) and, for video, [v].
func BuildGraph(kept []Range, hasVideo, hasAudio bool, crossfadeMs int) string {
	n := len(kept)
	if n == 0 || (!hasVideo && !hasAudio) {
		return ""
	}
	var b strings.Builder
	if !hasVideo {
		for i, k := range kept {
			fmt.Fprintf(&b, "[0:a]atrim=start=%s:end=%s,asetpts=PTS-STARTPTS[a%d];\n", sec(k.StartMs), sec(k.EndMs), i)
		}
		if n == 1 {
			b.WriteString("[a0]anull[a]\n")
			return b.String()
		}
		last := "a0"
		for i := 1; i < n; i++ {
			out := fmt.Sprintf("x%d", i)
			if i == n-1 {
				out = "a"
			}
			if d := fadeFor(crossfadeMs, kept[i-1], kept[i]); d > 0 {
				fmt.Fprintf(&b, "[%s][a%d]acrossfade=d=%s:c1=tri:c2=tri[%s]", last, i, secF(d), out)
			} else {
				fmt.Fprintf(&b, "[%s][a%d]concat=n=2:v=0:a=1[%s]", last, i, out)
			}
			if i < n-1 {
				b.WriteString(";")
			}
			b.WriteString("\n")
			last = out
		}
		return b.String()
	}
	for i, k := range kept {
		fmt.Fprintf(&b, "[0:v]trim=start=%s:end=%s,setpts=PTS-STARTPTS[v%d];\n", sec(k.StartMs), sec(k.EndMs), i)
		if !hasAudio {
			continue
		}
		fmt.Fprintf(&b, "[0:a]atrim=start=%s:end=%s,asetpts=PTS-STARTPTS", sec(k.StartMs), sec(k.EndMs))
		if crossfadeMs > 0 {
			if i > 0 {
				fmt.Fprintf(&b, ",afade=t=in:st=0:d=%s", secF(fadeFor(crossfadeMs, kept[i-1], k)/2))
			}
			if i < n-1 {
				d := fadeFor(crossfadeMs, k, kept[i+1]) / 2
				fmt.Fprintf(&b, ",afade=t=out:st=%s:d=%s", secF(float64(k.EndMs-k.StartMs)/1000-d), secF(d))
			}
		}
		fmt.Fprintf(&b, "[a%d];\n", i)
	}
	for i := range kept {
		fmt.Fprintf(&b, "[v%d]", i)
		if hasAudio {
			fmt.Fprintf(&b, "[a%d]", i)
		}
	}
	if hasAudio {
		fmt.Fprintf(&b, "concat=n=%d:v=1:a=1[v][a]\n", n)
	} else {
		fmt.Fprintf(&b, "concat=n=%d:v=1:a=0[v]\n", n)
	}
	return b.String()
}

// CutListCSV writes the kept and removed ranges, in time order.
func CutListCSV(removed, kept []Range) string {
	type row struct {
		r    Range
		what string
	}
	rows := make([]row, 0, len(kept)+len(removed))
	for _, r := range kept {
		rows = append(rows, row{r, "kept"})
	}
	for _, r := range removed {
		rows = append(rows, row{r, "removed"})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].r.StartMs < rows[j].r.StartMs })
	var b strings.Builder
	b.WriteString("type,start_s,end_s,length_s\n")
	for _, w := range rows {
		fmt.Fprintf(&b, "%s,%s,%s,%s\n", w.what, sec(w.r.StartMs), sec(w.r.EndMs), sec(w.r.EndMs-w.r.StartMs))
	}
	return b.String()
}

// Validate checks the numeric options.
func (o Options) Validate() error {
	fe := func(msg, field string) error { return core.ValidationError(msg, map[string]string{field: msg}) }
	switch {
	case math.IsNaN(o.ThresholdDb) || o.ThresholdDb < MinThresholdDb || o.ThresholdDb > MaxThresholdDb:
		return fe("The threshold must be between -80 and -10 dB", "thresholdDb")
	case o.MinSilenceMs < MinMinSilenceMs || o.MinSilenceMs > MaxMinSilenceMs:
		return fe("The shortest silence must be between 0.1 and 10 seconds", "minSilenceMs")
	case o.PaddingMs < 0 || o.PaddingMs > MaxPaddingMs:
		return fe("Padding must be between 0 and 2 seconds", "paddingMs")
	case o.CrossfadeMs < 0 || o.CrossfadeMs > MaxCrossfadeMs:
		return fe("The smooth join must be between 0 and 200 ms", "crossfadeMs")
	}
	return nil
}
