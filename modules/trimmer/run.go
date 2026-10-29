package trimmer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
)

// produced is a finished temp file waiting to be moved into OutputDir.
type produced struct{ tmp, stem, ext string }

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return core.ValidationError("Choose one file to trim", nil)
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	input := job.Inputs[0]
	info, err := media.Probe(ctx, ffprobe, input)
	if err != nil {
		return err
	}
	if err := validateAgainst(opts, info); err != nil {
		return err
	}
	job.SetTitle(filepath.Base(input))
	job.Progress(core.IndeterminateProgress, "Trimming…")

	var (
		outs     []produced
		maxShift int64
	)
	if opts.Mode == ModeFast {
		outs, maxShift, err = m.runFast(ctx, job, ffmpeg, ffprobe, input, info, opts)
	} else {
		outs, err = m.runPrecise(ctx, job, ffmpeg, input, info, opts)
	}
	if err != nil {
		return err
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("trim cancelled: %w", ctxErr)
	}

	var finals []string
	for _, o := range outs {
		final := core.UniquePath(job.OutputDir, o.stem, o.ext)
		if err := moveFile(o.tmp, final); err != nil {
			for _, f := range finals {
				_ = os.Remove(f)
			}
			return core.Errorf(core.CodeToolFailed, "Couldn't save the trimmed file").WithCause(err)
		}
		finals = append(finals, final)
	}
	for _, f := range finals {
		if _, err := job.Output(f); err != nil {
			return fmt.Errorf("register output: %w", err)
		}
	}
	if err := job.SetResult(Result{Outputs: finals, MaxShiftMs: maxShift}); err != nil {
		return err
	}
	msg := "Saved " + filepath.Base(finals[0])
	if len(finals) > 1 {
		msg = fmt.Sprintf("Saved %d files", len(finals))
	}
	if maxShift > shiftNoticeMs {
		msg += fmt.Sprintf(". Fast mode started up to %.1f s early to land on a keyframe; use Precise for exact cuts", float64(maxShift)/1000)
	}
	job.Progress(1, msg)
	return nil
}

// outName names output i of n.
func outName(input string, i, n int, o Options) string {
	if o.Join == JoinSeparate && n > 1 {
		return fmt.Sprintf("%s (part %d)", core.StemName(input), i+1)
	}
	return core.StemName(input) + " (trim)"
}

// shiftOf is the largest distance a segment start moves back to a keyframe.
func shiftOf(segs []Segment, keyframes []int64, startMs int64) int64 {
	var maxShift int64
	for _, s := range segs {
		idx := sort.Search(len(keyframes), func(i int) bool { return keyframes[i]-startMs > s.StartMs })
		if idx == 0 {
			continue
		}
		maxShift = max(maxShift, s.StartMs-(keyframes[idx-1]-startMs))
	}
	return maxShift
}

func (m *Module) runFast(ctx context.Context, job *core.JobContext, ffmpeg, ffprobe, input string, info media.Info, o Options) ([]produced, int64, error) {
	var shift int64
	if info.Video != nil {
		kf, err := media.Keyframes(ctx, ffprobe, input)
		if err != nil {
			if ctx.Err() != nil {
				return nil, 0, fmt.Errorf("trim cancelled: %w", ctx.Err())
			}
			job.Logf("Couldn't read keyframes: %v", err)
		} else {
			shift = shiftOf(o.Segments, kf, info.StartMs)
		}
	}
	ext := fastExt(filepath.Ext(input))
	merge := o.Join == JoinMerge && len(o.Segments) > 1
	segEnd := 1.0
	if merge {
		segEnd = 0.95
	}
	total := float64(totalMs(o.Segments))
	var (
		files []string
		done  float64
	)
	for i, s := range o.Segments {
		tmp := filepath.Join(job.TempDir, fmt.Sprintf("seg%d%s", i, ext))
		frac := float64(s.EndMs-s.StartMs) / total * segEnd
		sj := job.Scoped(done, done+frac)
		done += frac
		args := append(commonArgs(), fastSegmentArgs(input, tmp, s.StartMs, s.EndMs, o.RemoveAudio)...)
		if err := runFF(ctx, sj, ffmpeg, args, float64(s.EndMs-s.StartMs)/1000); err != nil {
			return nil, 0, err
		}
		files = append(files, tmp)
	}
	if !merge {
		var outs []produced
		for i, f := range files {
			outs = append(outs, produced{f, outName(input, i, len(files), o), ext})
		}
		return outs, shift, nil
	}
	list := filepath.Join(job.TempDir, "list.txt")
	if err := os.WriteFile(list, []byte(concatList(files)), 0o644); err != nil {
		return nil, 0, fmt.Errorf("write concat list: %w", err)
	}
	out := filepath.Join(job.TempDir, "merged"+ext)
	args := append(commonArgs(), fastConcatArgs(list, out)...)
	if err := runFF(ctx, job.Scoped(0.95, 1), ffmpeg, args, total/1000); err != nil {
		return nil, 0, err
	}
	return []produced{{out, outName(input, 0, 1, o), ext}}, shift, nil
}

func (m *Module) runPrecise(ctx context.Context, job *core.JobContext, ffmpeg, input string, info media.Info, o Options) ([]produced, error) {
	hasV := info.Video != nil
	hasA := len(info.Audio) > 0 && !o.RemoveAudio
	ext, audioCodecs := ".mp4", []string(nil)
	if !hasV {
		ext, audioCodecs = audioFamily(filepath.Ext(input))
	}
	var groups [][]Segment
	if o.Join == JoinSeparate {
		for _, s := range o.Segments {
			groups = append(groups, []Segment{s})
		}
	} else {
		groups = [][]Segment{o.Segments}
	}
	vf := ""
	if hasV {
		vf = videoFilter(info.Video.Width, info.Video.Height, o)
	}
	total := float64(totalMs(o.Segments))
	var (
		outs []produced
		done float64
	)
	for gi, g := range groups {
		dur := float64(totalMs(g)) / 1000
		frac := float64(totalMs(g)) / total
		gj := job.Scoped(done, done+frac)
		done += frac
		graph, vl, al := buildGraph(g, hasV, hasA, vf)
		out := filepath.Join(job.TempDir, fmt.Sprintf("out%d%s", gi, ext))
		spec := preciseSpec{In: input, Out: out, Graph: graph, VLabel: vl, ALabel: al, AudioOnlyCodecs: audioCodecs}
		if hasV && o.MaxSizeMB > 0 {
			rate := 0.0
			if hasA {
				rate = audioBps
			}
			spec.Kbps = int(videoBitrateKbps(o.MaxSizeMB, rate, dur))
			if spec.Kbps < minVideoKbps {
				return nil, fieldErr(fmt.Sprintf("That's too long to fit in %d MB; raise the limit or trim more", o.MaxSizeMB), "maxSizeMB")
			}
			spec.PassLog = filepath.Join(job.TempDir, fmt.Sprintf("x264-%d", gi))
			spec.Pass = 1
			if err := runFF(ctx, gj.Scoped(0, 0.5), ffmpeg, append(commonArgs(), spec.args()...), dur); err != nil {
				return nil, err
			}
			spec.Pass = 2
			if err := runFF(ctx, gj.Scoped(0.5, 1), ffmpeg, append(commonArgs(), spec.args()...), dur); err != nil {
				return nil, err
			}
		} else if err := runFF(ctx, gj, ffmpeg, append(commonArgs(), spec.args()...), dur); err != nil {
			return nil, err
		}
		outs = append(outs, produced{out, outName(input, gi, len(groups), o), ext})
	}
	return outs, nil
}

// runFF runs one ffmpeg invocation, mapping -progress to job progress.
func runFF(ctx context.Context, job *core.JobContext, ffmpeg string, args []string, durSec float64) error {
	tracker := &media.ProgressTracker{Duration: durSec, Label: "Trimming"}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	res, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg,
		Args: args,
		OnStdout: func(l string) {
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				job.Progress(pct, msg)
			}
		},
		OnStderr: func(l string) {
			job.Log(core.StreamStderr, l)
			mu.Lock()
			lastStderr = l
			mu.Unlock()
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("trim cancelled: %w", ctxErr)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return fmt.Errorf("run ffmpeg: %w", err)
		}
		mu.Lock()
		msg := strings.TrimSpace(lastStderr)
		mu.Unlock()
		if msg == "" {
			msg = fmt.Sprintf("ffmpeg exited with code %d", res.ExitCode)
		}
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
	}
	return nil
}

// moveFile renames src to dst, falling back to copy+remove across volumes.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return fmt.Errorf("copy to %s: %w", dst, err)
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return fmt.Errorf("close %s: %w", dst, err)
	}
	_ = in.Close()
	return os.Remove(src)
}
