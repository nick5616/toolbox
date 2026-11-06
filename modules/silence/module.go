// Package silence removes silent stretches from audio and video files with
// FFmpeg (silencedetect + trim/concat), keeping a little padding so the cuts
// don't feel abrupt (Phase 15, SPEC.md §2).
package silence

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
)

// ModuleID is the Silence Cutter's module ID.
const ModuleID = "silence"

// Module implements core.Module.
type Module struct {
	resolve func(depID string) (string, error)
}

// Register adds the module to the registry. resolve finds ffmpeg/ffprobe
// (deps.Service.Resolve).
func Register(reg *core.Registry, resolve func(depID string) (string, error)) error {
	return reg.Register(&Module{resolve: resolve})
}

// Accepts lists the input extensions.
func Accepts() []string { return append(media.VideoExtensions(), media.AudioExtensions()...) }

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Silence Cutter", Icon: "audio-lines", Category: core.CategoryMedia,
		Tagline:     "Cut the dead air out of recordings",
		Description: "Finds the silent stretches of an audio or video file and removes them, keeping a little padding so the cuts don't feel abrupt.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{"ffmpeg", "ffprobe"},
		Order:       137, OutputSubdir: "Cut", SplitInputs: true, MaxInputs: 200,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) == 0 {
		return core.ValidationError("Choose a file to cut", nil)
	}
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	return opts.Validate()
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := opts.Validate(); err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return core.ValidationError("Choose one file to cut", nil)
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
	if len(info.Audio) == 0 {
		return core.ValidationError("This file has no sound to measure", nil)
	}
	job.SetTitle(filepath.Base(input))
	job.Progress(core.IndeterminateProgress, "Listening for silence…")

	silences, err := detect(ctx, job.Scoped(0, 0.2), ffmpeg, input, opts, info.DurationMs)
	if err != nil {
		return err
	}
	removed, kept := Plan(silences, info.DurationMs, opts.PaddingMs)
	if err := check(removed, kept); err != nil {
		return err
	}

	hasVideo := info.Video != nil
	graph := BuildGraph(kept, hasVideo, true, opts.CrossfadeMs)
	if err := os.WriteFile(filepath.Join(job.TempDir, "cut.fg"), []byte(graph), 0o644); err != nil {
		return fmt.Errorf("write filtergraph: %w", err)
	}
	ext := ".mp4"
	args := []string{"-i", input, "-/filter_complex", "cut.fg"}
	if hasVideo {
		args = append(args, "-map", "[v]", "-map", "[a]",
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
			"-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart")
	} else {
		var codecs []string
		ext, codecs = audioFamily(filepath.Ext(input))
		args = append(args, "-map", "[a]")
		args = append(args, codecs...)
	}
	tmp := filepath.Join(job.TempDir, "out"+ext)
	args = append(commonArgs(), append(args, tmp)...)
	job.Progress(0.2, "Cutting…")
	if err := runFF(ctx, job.Scoped(0.2, 1), ffmpeg, job.TempDir, args, float64(total(kept))/1000); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("cut cancelled: %w", err)
	}

	final := core.UniquePath(job.OutputDir, core.StemName(input)+" (cut)", ext)
	if err := moveFile(tmp, final); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the cut file").WithCause(err)
	}
	if _, err := job.Output(final); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	res := Result{Output: final, DurationMs: info.DurationMs, RemovedMs: total(removed), KeptMs: total(kept), Removed: removed}
	if opts.CutList {
		if err := os.MkdirAll(job.OutputDir, 0o755); err != nil {
			return fmt.Errorf("create output dir: %w", err)
		}
		list := core.UniquePath(job.OutputDir, core.StemName(input)+" (cut list)", ".csv")
		if err := os.WriteFile(list, []byte(CutListCSV(removed, kept)), 0o644); err != nil {
			return core.Errorf(core.CodeToolFailed, "Couldn't save the cut list").WithCause(err)
		}
		if _, err := job.Output(list); err != nil {
			return fmt.Errorf("register output: %w", err)
		}
		res.CutList = list
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("Removed %.1f s of silence", float64(res.RemovedMs)/1000))
	return nil
}

// commonArgs are the flags every ffmpeg run here starts with.
func commonArgs() []string {
	return []string{"-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"}
}

// detectArgs is the silencedetect run: audio only, output discarded.
func detectArgs(input string, o Options) []string {
	filter := fmt.Sprintf("silencedetect=noise=%sdB:d=%s",
		strconv.FormatFloat(o.ThresholdDb, 'f', -1, 64), strconv.FormatFloat(float64(o.MinSilenceMs)/1000, 'f', 3, 64))
	return []string{"-hide_banner", "-nostdin", "-v", "info", "-progress", "pipe:1", "-nostats",
		"-i", input, "-vn", "-sn", "-dn", "-af", filter, "-f", "null", "-"}
}

// detect runs silencedetect over a file and returns the silences.
func detect(ctx context.Context, job *core.JobContext, ffmpeg, input string, o Options, durationMs int64) ([]Range, error) {
	var (
		mu  sync.Mutex
		log bytes.Buffer
	)
	tracker := &media.ProgressTracker{Duration: float64(durationMs) / 1000, Label: "Listening"}
	res, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg,
		Args: detectArgs(input, o),
		OnStdout: func(l string) {
			if job == nil {
				return
			}
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				job.Progress(pct, msg)
			}
		},
		OnStderr: func(l string) {
			mu.Lock()
			log.WriteString(l)
			log.WriteByte('\n')
			mu.Unlock()
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, fmt.Errorf("silence detection cancelled: %w", ctxErr)
	}
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return nil, fmt.Errorf("run ffmpeg: %w", err)
		}
		return nil, core.Errorf(core.CodeToolFailed, "Couldn't listen to this file").WithCause(fmt.Errorf("ffmpeg exited with code %d", res.ExitCode))
	}
	mu.Lock()
	defer mu.Unlock()
	return ParseSilenceDetect(&log, durationMs)
}

// audioFamily is the container and codec args for audio-only output in the
// input's own family.
func audioFamily(ext string) (string, []string) {
	switch strings.ToLower(ext) {
	case ".mp3":
		return ".mp3", []string{"-c:a", "libmp3lame", "-q:a", "0"}
	case ".m4a":
		return ".m4a", []string{"-c:a", "aac", "-b:a", "256k"}
	case ".aac":
		return ".aac", []string{"-c:a", "aac", "-b:a", "256k"}
	case ".wav":
		return ".wav", []string{"-c:a", "pcm_s16le"}
	case ".flac":
		return ".flac", []string{"-c:a", "flac"}
	case ".ogg":
		return ".ogg", []string{"-c:a", "libopus", "-b:a", "160k"}
	case ".opus":
		return ".opus", []string{"-c:a", "libopus", "-b:a", "160k"}
	case ".aiff", ".aif":
		return ".aiff", []string{"-c:a", "pcm_s16be"}
	}
	return ".m4a", []string{"-c:a", "aac", "-b:a", "256k"}
}

// runFF runs one ffmpeg invocation in dir, mapping -progress to job progress.
func runFF(ctx context.Context, job *core.JobContext, ffmpeg, dir string, args []string, durSec float64) error {
	tracker := &media.ProgressTracker{Duration: durSec, Label: "Cutting"}
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
		return fmt.Errorf("cut cancelled: %w", ctxErr)
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
