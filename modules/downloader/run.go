package downloader

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"toolbox/core"
	"toolbox/core/proc"
)

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("No link to download", nil)
	}

	ytdlp, err := job.Tool("yt-dlp")
	if err != nil {
		return err
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	if _, err := job.Tool("ffprobe"); err != nil {
		return err
	}

	jsRuntime := selectJSRuntime(ctx, job)

	if opts.Mode == ModeAudio && opts.AudioFormat == FormatWAV && opts.EmbedThumbnail {
		job.Logf("Thumbnail embedding isn't supported for WAV, skipped")
	}

	args := BuildArgs(opts, job.Inputs[0], ArgEnv{
		OutputDir:  job.OutputDir,
		TempDir:    job.TempDir,
		CacheDir:   m.cacheDir,
		FFmpegPath: ffmpeg,
		JSRuntime:  jsRuntime,
	})

	path := os.Getenv("PATH")
	prefix := filepath.Dir(ytdlp)
	if d := filepath.Dir(ffmpeg); d != prefix {
		prefix += string(os.PathListSeparator) + d
	}
	if path != "" {
		path = prefix + string(os.PathListSeparator) + path
	} else {
		path = prefix
	}

	var (
		mu         sync.Mutex
		tracker    = NewTracker()
		outputs    = map[string]bool{}
		nOutputs   int
		titleSet   bool
		lastError  string
		lastStderr string
	)

	tracker.SetTrim(opts.TrimEnabled)

	handle := func(line string, stderr bool) {
		ev := ParseLine(line)
		mu.Lock()
		defer mu.Unlock()

		if stderr {
			if strings.TrimSpace(line) != "" && !isTbxLine(line) {
				lastStderr = line
			}
			if ev.Kind == EvError {
				lastError = ev.Message
			}
		}

		switch ev.Kind {
		case EvStart:
			job.Logf("Starting %q", ev.Title)
			if !titleSet && ev.Title != "" {
				titleSet = true
				title := ev.Title
				if ev.PlaylistCount > 1 {
					title = fmt.Sprintf("%s (+%d more)", title, ev.PlaylistCount-1)
				}
				job.SetTitle(title)
			}
		case EvOutput:
			if ev.Path != "" {
				job.Logf("Saved %s", ev.Path)
				if !outputs[ev.Path] {
					outputs[ev.Path] = true
					if _, err := job.Output(ev.Path); err != nil {
						job.Logf("Couldn't register %s: %v", ev.Path, err)
					} else {
						nOutputs++
					}
				}
			}
		}

		if !isTbxLine(line) {
			if stderr {
				job.Log(core.StreamStderr, line)
			} else {
				job.Log(core.StreamStdout, line)
			}
		}

		if pct, msg, changed := tracker.Apply(ev); changed {
			job.Progress(pct, msg)
		}
	}

	res, runErr := proc.Run(ctx, proc.Spec{
		Path: ytdlp,
		Args: args,
		Env: []string{
			"PYTHONIOENCODING=utf-8",
			"PYTHONUTF8=1",
			"NO_COLOR=1",
			"PATH=" + path,
		},
		OnStdout: func(l string) { handle(l, false) },
		OnStderr: func(l string) { handle(l, true) },
	})

	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("download cancelled: %w", ctxErr)
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return fmt.Errorf("run yt-dlp: %w", runErr)
		}
		mu.Lock()
		msg := lastError
		if msg == "" {
			msg = lastStderr
		}
		mu.Unlock()
		if msg == "" {
			for i := len(res.StderrTail) - 1; i >= 0; i-- {
				if l := res.StderrTail[i]; strings.TrimSpace(l) != "" && !isTbxLine(l) {
					msg = res.StderrTail[i]
					break
				}
			}
		}
		if msg == "" {
			msg = fmt.Sprintf("yt-dlp exited with code %d", res.ExitCode)
		}
		msg = cleanErrorMessage(msg)
		return core.Errorf(core.CodeToolFailed, "%s", msg).
			WithHint(hintFor(msg, jsRuntime == "")).
			WithCause(runErr)
	}

	mu.Lock()
	n := nOutputs
	mu.Unlock()
	if n == 0 {
		return core.Errorf(core.CodeToolFailed, "yt-dlp finished without producing a file")
	}
	return nil
}

func denoInstallHint() string {
	if runtime.GOOS == "windows" {
		return "winget install DenoLand.Deno"
	}
	return "brew install deno"
}

func ffmpegInstallHint() string {
	if runtime.GOOS == "windows" {
		return "Install ffmpeg: winget install Gyan.FFmpeg"
	}
	return "Install ffmpeg: brew install ffmpeg"
}

// hintFor maps an error message to a user-facing next step (SPEC §7.5).
func hintFor(msg string, noJS bool) string {
	l := strings.ToLower(msg)
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(l, strings.ToLower(s)) {
				return true
			}
		}
		return false
	}
	switch {
	case has("Unsupported URL"):
		return "This site isn't supported by yt-dlp"
	case has("Requested format is not available"):
		return "Try a lower max resolution or Best"
	case has("Sign in to confirm", "cookies"):
		return "This video needs a signed-in session, which Toolbox doesn't support yet"
	case has("HTTP Error 403", "nsig", "Signature extraction failed"):
		h := "Update yt-dlp in Settings → Dependencies"
		if noJS {
			h += ". Installing Deno may also help: " + denoInstallHint()
		}
		return h
	case has("ffmpeg not found", "ffprobe"):
		return ffmpegInstallHint()
	case has("Private video", "Video unavailable"):
		return "The video is private or unavailable"
	case has("HTTP Error 404", "Unable to download webpage"):
		return "Check that the link is correct and the page still exists"
	}
	return ""
}

// cleanErrorMessage drops yt-dlp's Python exception suffix, e.g.
// "… HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)".
func cleanErrorMessage(msg string) string {
	if i := strings.Index(msg, " (caused by "); i > 0 {
		msg = msg[:i]
	}
	return strings.TrimSpace(msg)
}
