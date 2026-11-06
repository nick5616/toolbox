package scenes

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
)

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := checkOptions(opts); err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return core.ValidationError("Choose one video to split", nil)
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
	if info.Video == nil {
		return core.ValidationError("This file has no video to split", nil)
	}
	if info.DurationMs <= 0 {
		return core.ValidationError("Couldn't read how long this video is", nil)
	}
	job.SetTitle(filepath.Base(input))

	writes := opts.Output
	detectShare := 0.5
	if opts.Keep == KeepAll && writes == OutputStills {
		detectShare = 0.7
	}

	// 1. Score every frame.
	job.Progress(0, "Looking for scene changes…")
	if err := runFF(ctx, job.Scoped(0, detectShare), ffmpeg, detectArgs(input), job.TempDir, float64(info.DurationMs)/1000, "Looking for scene changes"); err != nil {
		return err
	}
	raw, err := os.ReadFile(filepath.Join(job.TempDir, scoresFile))
	if err != nil {
		return core.Errorf(core.CodeToolFailed, "Scene detection produced no result").WithCause(err)
	}
	frames := parseScores(string(raw))
	for i := range frames {
		frames[i].ms -= info.StartMs
	}
	all := buildScenes(frames, opts.Threshold, int64(opts.MinSceneSecs*1000), 0, info.DurationMs)
	if len(all) > maxScenes {
		return core.Errorf(core.CodeValidation, "Found %d scenes, which is too many", len(all)).
			WithHint("Raise the sensitivity threshold or the shortest scene length")
	}
	kept := keepScenes(all, opts.Keep, opts.KeepN)
	job.Logf("Found %d scenes, keeping %d", len(all), len(kept))

	// 2. Write each kept scene.
	var keyframes []int64
	if writes != OutputStills {
		kf, kerr := media.Keyframes(ctx, ffprobe, input)
		if kerr != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("scene split cancelled: %w", ctx.Err())
			}
			job.Logf("Couldn't read keyframes (re-encoding clips): %v", kerr)
		}
		for _, k := range kf {
			keyframes = append(keyframes, k-info.StartMs)
		}
	}
	stem := core.StemName(input)
	ext := copyExt(filepath.Ext(input))
	type made struct {
		tmp, stem, ext string
		scene, kind    int // kind 0 clip, 1 still
	}
	var files []made
	reencoded := 0
	for i := range kept {
		s := &kept[i]
		sj := job.Scoped(detectShare+(1-detectShare)*float64(i)/float64(len(kept)), detectShare+(1-detectShare)*float64(i+1)/float64(len(kept)))
		sj.Progress(0, fmt.Sprintf("Scene %d of %d", i+1, len(kept)))
		name := sceneName(stem, s.N)
		if writes != OutputStills {
			if onKeyframe(keyframes, s.StartMs, keyframeTolMs) {
				tmp := filepath.Join(job.TempDir, fmt.Sprintf("c%03d%s", s.N, ext))
				if err := runFF(ctx, sj, ffmpeg, copyClipArgs(input, tmp, s.StartMs, s.EndMs), "", float64(s.EndMs-s.StartMs)/1000, "Cutting"); err != nil {
					return err
				}
				files = append(files, made{tmp, name, ext, i, 0})
			} else {
				tmp := filepath.Join(job.TempDir, fmt.Sprintf("c%03d.mp4", s.N))
				if err := runFF(ctx, sj, ffmpeg, encodeClipArgs(input, tmp, s.StartMs, s.EndMs), "", float64(s.EndMs-s.StartMs)/1000, "Cutting"); err != nil {
					return err
				}
				reencoded++
				files = append(files, made{tmp, name, ".mp4", i, 0})
			}
		}
		if writes != OutputClips {
			tmp := filepath.Join(job.TempDir, fmt.Sprintf("s%03d.jpg", s.N))
			if err := runFF(ctx, sj, ffmpeg, stillArgs(input, tmp, (s.StartMs+s.EndMs)/2), "", 0, "Saving still"); err != nil {
				return err
			}
			files = append(files, made{tmp, name, ".jpg", i, 1})
		}
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("scene split cancelled: %w", ctxErr)
	}

	// 3. Move into the library and register.
	var finals []string
	for _, f := range files {
		final := core.UniquePath(job.OutputDir, f.stem, f.ext)
		if err := moveFile(f.tmp, final); err != nil {
			for _, p := range finals {
				_ = os.Remove(p)
			}
			return core.Errorf(core.CodeToolFailed, "Couldn't save a scene").WithCause(err)
		}
		finals = append(finals, final)
		if f.kind == 0 {
			kept[f.scene].Clip = final
		} else {
			kept[f.scene].Still = final
		}
	}
	for _, p := range finals {
		if _, err := job.Output(p); err != nil {
			return fmt.Errorf("register output: %w", err)
		}
	}
	if err := job.SetResult(Result{DurationMs: info.DurationMs, Found: len(all), Scenes: kept, Outputs: finals, Reencoded: reencoded}); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("Saved %d scenes", len(kept)))
	return nil
}

// runFF runs one ffmpeg invocation, mapping -progress to job progress.
func runFF(ctx context.Context, job *core.JobContext, ffmpeg string, args []string, dir string, durSec float64, label string) error {
	tracker := &media.ProgressTracker{Duration: durSec, Label: label}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	res, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg,
		Args: args,
		Dir:  dir,
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
		return fmt.Errorf("scene split cancelled: %w", ctxErr)
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
