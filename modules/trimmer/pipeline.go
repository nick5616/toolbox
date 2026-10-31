package trimmer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
)

// Pipeline step adapter (SPEC.md §6.2, §6.3): one job per file; the part to
// keep is resolved against each file's probed length.

var _ core.Chainable = (*Module)(nil)

// StepKeep says which part of each file a Trimmer step keeps.
type StepKeep string

const (
	KeepWhole StepKeep = "whole"
	KeepFirst StepKeep = "first" // the first Seconds
	KeepLast  StepKeep = "last"  // the last Seconds
	KeepRange StepKeep = "range" // From–To
)

// StepOptions are the Trimmer's pipeline step options: the part to keep is
// resolved per file at run time.
type StepOptions struct {
	Keep        StepKeep `json:"keep"`
	Seconds     float64  `json:"seconds"` // first/last: 1–36,000
	From        string   `json:"from"`    // range: timecode, "" = start
	To          string   `json:"to"`      // range: timecode, "" = end
	Mode        Mode     `json:"mode"`
	Aspect      Aspect   `json:"aspect"`
	CropX       float64  `json:"cropX"`
	CropY       float64  `json:"cropY"`
	MaxSizeMB   int      `json:"maxSizeMB"`
	MaxHeight   int      `json:"maxHeight"`
	RemoveAudio bool     `json:"removeAudio"`
}

// DefaultStepOptions: the whole file, precise, shape and size unchanged.
func DefaultStepOptions() StepOptions {
	return StepOptions{Keep: KeepWhole, Seconds: 30, Mode: ModePrecise, Aspect: AspectKeep, CropX: 0.5, CropY: 0.5}
}

// probeFile probes a file; tests replace it.
var probeFile = func(ctx context.Context, ffprobe, path string) (media.Info, error) {
	return media.Probe(ctx, ffprobe, path)
}

const maxKeepSeconds = 36000

// decodeStep decodes step options strictly over the defaults.
func decodeStep(raw json.RawMessage) (StepOptions, error) {
	o := DefaultStepOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return o, nil
}

func plainProblem(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	keys := make([]string, 0, len(ae.Fields))
	for k := range ae.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return core.ValidationError(ae.Fields[keys[0]], ae.Fields)
}

var errStepTimecode = errors.New("invalid timecode")

// parseTimecode parses SS[.fff], M:SS[.fff] or H:MM:SS[.fff] into seconds
// (the same syntax as the Downloader's trim fields).
func parseTimecode(s string) (float64, error) {
	s = strings.TrimSpace(s)
	bad := fmt.Errorf("parse timecode %q: %w", s, errStepTimecode)
	if s == "" {
		return 0, bad
	}
	parts := strings.Split(s, ":")
	if len(parts) > 3 {
		return 0, bad
	}
	digits := func(v string) bool {
		if v == "" {
			return false
		}
		for _, r := range v {
			if r < '0' || r > '9' {
				return false
			}
		}
		return true
	}
	total := 0.0
	for i, p := range parts {
		whole, frac := p, ""
		if i == len(parts)-1 {
			if w, f, ok := strings.Cut(p, "."); ok {
				whole, frac = w, f
				if !digits(f) {
					return 0, bad
				}
			}
		}
		if !digits(whole) || len(whole) > 9 || (i > 0 && len(whole) != 2) {
			return 0, bad
		}
		n, _ := strconv.Atoi(whole)
		if i > 0 && n >= 60 {
			return 0, bad
		}
		total = total*60 + float64(n)
		if frac != "" {
			f, _ := strconv.ParseFloat("0."+frac, 64)
			total += f
		}
	}
	return total, nil
}

// toOptions maps the step options and one resolved segment to job options.
func (o StepOptions) toOptions(seg Segment) Options {
	return Options{
		Segments: []Segment{seg}, Mode: o.Mode, Join: JoinMerge, Aspect: o.Aspect,
		CropX: o.CropX, CropY: o.CropY, MaxSizeMB: o.MaxSizeMB, MaxHeight: o.MaxHeight, RemoveAudio: o.RemoveAudio,
	}
}

// checkStep validates everything that doesn't need a file.
func checkStep(o StepOptions) error {
	switch o.Keep {
	case KeepWhole:
	case KeepFirst, KeepLast:
		if math.IsNaN(o.Seconds) || o.Seconds < 1 || o.Seconds > maxKeepSeconds {
			return fieldErr("Seconds to keep must be between 1 and 36,000", "seconds")
		}
	case KeepRange:
		var from, to float64
		var haveTo bool
		if strings.TrimSpace(o.From) != "" {
			v, err := parseTimecode(o.From)
			if err != nil {
				return fieldErr("Use a start time like 1:05 or 1:02:03.5", "from")
			}
			from = v
		}
		if strings.TrimSpace(o.To) != "" {
			v, err := parseTimecode(o.To)
			if err != nil {
				return fieldErr("Use an end time like 1:05 or 1:02:03.5", "to")
			}
			to, haveTo = v, true
		}
		if strings.TrimSpace(o.From) == "" && !haveTo {
			return fieldErr("Set a start or an end time", "from")
		}
		if haveTo && to <= from {
			return fieldErr("The end must be after the start", "to")
		}
	default:
		return fieldErr("Choose which part to keep", "keep")
	}
	// The shape and size checks, with a stand-in segment.
	if err := validateShape(o.toOptions(Segment{StartMs: 0, EndMs: 1000})); err != nil {
		return err
	}
	if o.Keep == KeepWhole && o.Mode == ModeFast && o.Aspect == AspectKeep && o.MaxSizeMB == 0 && o.MaxHeight == 0 && !o.RemoveAudio {
		return fieldErr("Nothing to do: pick a part, a shape or a size", "keep")
	}
	return nil
}

func stepSummary(o StepOptions) string {
	var parts []string
	secs := strconv.FormatFloat(o.Seconds, 'f', -1, 64)
	switch o.Keep {
	case KeepFirst:
		parts = append(parts, "First "+secs+" s")
	case KeepLast:
		parts = append(parts, "Last "+secs+" s")
	case KeepRange:
		from, to := strings.TrimSpace(o.From), strings.TrimSpace(o.To)
		switch {
		case from == "":
			parts = append(parts, "Up to "+to)
		case to == "":
			parts = append(parts, "From "+from)
		default:
			parts = append(parts, from+" – "+to)
		}
	default:
		parts = append(parts, "Whole file")
	}
	if o.Aspect != AspectKeep {
		parts = append(parts, string(o.Aspect))
	}
	if o.MaxHeight > 0 {
		parts = append(parts, fmt.Sprintf("≤ %dp", o.MaxHeight))
	}
	if o.MaxSizeMB > 0 {
		parts = append(parts, fmt.Sprintf("≤ %d MB", o.MaxSizeMB))
	}
	if o.RemoveAudio {
		parts = append(parts, "no audio")
	}
	if o.Mode == ModeFast {
		parts = append(parts, "fast cut")
	}
	return strings.Join(parts, " · ")
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := checkStep(o); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: []core.StepProduct{{}}, // the input's kind: .mp4 (video) or the audio family when re-encoded
		Vars:     []core.StepVar{},
		Summary:  stepSummary(o),
	}, nil
}

// segmentFor resolves the part to keep against a file of durMs milliseconds.
func segmentFor(o StepOptions, durMs int64) (Segment, error) {
	seg := Segment{StartMs: 0, EndMs: durMs}
	switch o.Keep {
	case KeepFirst:
		seg.EndMs = min(durMs, int64(math.Round(o.Seconds*1000)))
	case KeepLast:
		seg.StartMs = max(0, durMs-int64(math.Round(o.Seconds*1000)))
	case KeepRange:
		if strings.TrimSpace(o.From) != "" {
			v, err := parseTimecode(o.From)
			if err != nil {
				return seg, fieldErr("Use a start time like 1:05 or 1:02:03.5", "from")
			}
			seg.StartMs = int64(math.Round(v * 1000))
		}
		if strings.TrimSpace(o.To) != "" {
			v, err := parseTimecode(o.To)
			if err != nil {
				return seg, fieldErr("Use an end time like 1:05 or 1:02:03.5", "to")
			}
			seg.EndMs = min(durMs, int64(math.Round(v*1000)))
		}
	}
	if seg.EndMs-seg.StartMs < minSegmentMs {
		return seg, core.ValidationError("This file is shorter than the part to keep", nil)
	}
	return seg, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := checkStep(o); err != nil {
		return nil, plainProblem(err)
	}
	if len(req.Item.Files) == 0 {
		return nil, core.ValidationError("There's no file to trim", nil)
	}
	if m.resolve == nil {
		return nil, core.ErrDependencyMissing("ffprobe", "Install FFmpeg from Settings")
	}
	ffprobe, err := m.resolve("ffprobe")
	if err != nil {
		return nil, err
	}
	jobs := make([]core.StepJob, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		if err := core.ValidateFileInputs([]string{f.Path}, Accepts()); err != nil {
			return nil, plainProblem(err)
		}
		info, err := probeFile(ctx, ffprobe, f.Path)
		if err != nil {
			return nil, err
		}
		seg, err := segmentFor(o, info.DurationMs)
		if err != nil {
			return nil, plainProblem(err)
		}
		opts := o.toOptions(seg)
		if err := validateAgainst(opts, info); err != nil {
			return nil, plainProblem(err)
		}
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: opts})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID})
	}
	return res, nil
}
