package editstudio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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

// The export's audio mix (SPEC.md §12.3). WP-ES8.

// mixRate is the mix's sample rate; the mix is stereo PCM s16.
const mixRate = 48000

// clipFadeMs is the fade at both ends of every clip's audio (no clicks).
const clipFadeMs = 10

// ---- speed ----

// speedKey is one key of a clip's Speed JSON (SPEC.md §6.3 Key).
type speedKey struct {
	T    float64 `json:"t"`
	V    float64 `json:"v"`
	Ease string  `json:"ease"`
}

// speedCurve is a parsed Clip.Speed: a constant, or keys.
type speedCurve struct {
	base float64
	keys []speedKey
}

// parseSpeedCurve reads Clip.Speed: "" = 1, a bare number, or {base, keys}.
// Anything unreadable counts as 1 (validate already rejected bad JSON).
func parseSpeedCurve(raw string) speedCurve {
	c := speedCurve{base: 1}
	if strings.TrimSpace(raw) == "" {
		return c
	}
	var n float64
	if json.Unmarshal([]byte(raw), &n) == nil {
		c.base = n
		return c
	}
	var o struct {
		Base *float64   `json:"base"`
		Keys []speedKey `json:"keys"`
	}
	if json.Unmarshal([]byte(raw), &o) != nil {
		return c
	}
	if o.Base != nil {
		c.base = *o.Base
	}
	c.keys = o.Keys
	return c
}

// constant reports the clip's speed when it doesn't change: no keys, one key,
// or keys that all hold the same value.
func (c speedCurve) constant() (float64, bool) {
	if len(c.keys) == 0 {
		return c.base, true
	}
	v := c.keys[0].V
	for _, k := range c.keys[1:] {
		if k.V != v {
			return 0, false
		}
	}
	return v, true
}

// at is the speed at clip time u ms: keys hold outside their range; a segment
// uses its first key's ease (linear, smoothstep "ease", or "hold").
func (c speedCurve) at(u float64) float64 {
	k := c.keys
	if len(k) == 0 {
		return c.base
	}
	if u <= k[0].T {
		return k[0].V
	}
	for i := 0; i+1 < len(k); i++ {
		a, b := k[i], k[i+1]
		if u >= b.T {
			continue
		}
		f := (u - a.T) / (b.T - a.T)
		switch a.Ease {
		case "hold":
			return a.V
		case "ease":
			f = f * f * (3 - 2*f)
		}
		return a.V + (b.V-a.V)*f
	}
	return k[len(k)-1].V
}

// minMax is the lowest and highest speed of the clip's keys (or its constant).
func (c speedCurve) minMax() (lo, hi float64) {
	if len(c.keys) == 0 {
		return c.base, c.base
	}
	lo, hi = c.keys[0].V, c.keys[0].V
	for _, k := range c.keys[1:] {
		lo, hi = math.Min(lo, k.V), math.Max(hi, k.V)
	}
	return lo, hi
}

// clipSourceRange is the source range a video clip plays: InMs to InMs plus
// the integral of its speed over the output frame grid (the same integration
// as the frontend's clipSourceSpan, so the interp keys match).
func clipSourceRange(c Clip, fps int) (fromMs, toMs int64) {
	sp := parseSpeedCurve(c.Speed)
	n := c.EndMs - c.StartMs
	if v, ok := sp.constant(); ok {
		return c.InMs, c.InMs + int64(math.Round(v*float64(n)))
	}
	step := 1000 / float64(fps)
	src := float64(c.InMs)
	for u := 0.0; u < float64(n); u += step {
		src += sp.at(u) * math.Min(step, float64(n)-u)
	}
	return c.InMs, int64(math.Round(src))
}

// ---- graph ----

// mixInput is one -i of the mix: its seek options and file.
type mixInput struct {
	Pre  []string
	Path string
}

// secs formats a number of seconds with up to 6 decimals and no trailing zeros.
func mixSec(v float64) string {
	s := strconv.FormatFloat(v, 'f', 6, 64)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	if s == "" || s == "-0" {
		return "0"
	}
	return s
}

func mixMs(ms float64) string { return mixSec(ms / 1000) }

// atempoStages splits speed into atempo stages within 0.5..2.
func atempoStages(speed float64) []string {
	var out []string
	for speed < 0.5 {
		out = append(out, "atempo=0.5")
		speed /= 0.5
	}
	for speed > 2 {
		out = append(out, "atempo=2")
		speed /= 2
	}
	return append(out, "atempo="+mixSec(speed))
}

const stereoFormat = "aformat=sample_rates=48000:channel_layouts=stereo"

// buildMixGraph builds the mix's inputs and filter graph. hasAudio says which
// source paths carry an audio stream. Input 0 is the song; each audible clip
// has its own input, seeked to its source range (so a long source isn't
// decoded from the start for every clip).
func buildMixGraph(doc EditProject, hasAudio func(path string) bool) (inputs []mixInput, graph string) {
	song := doc.Song
	d := float64(editLen(doc))
	chain := []string{stereoFormat}
	if song != nil {
		inputs = []mixInput{{Pre: []string{"-ss", mixMs(float64(song.StartMs)), "-t", mixMs(d)}, Path: song.Path}}
		if song.GainDb != 0 {
			chain = append(chain, "volume="+mixSec(song.GainDb)+"dB")
		}
		if song.FadeInMs > 0 {
			chain = append(chain, "afade=t=in:st=0:d="+mixMs(float64(song.FadeInMs)))
		}
		if song.FadeOutMs > 0 {
			chain = append(chain, "afade=t=out:st="+mixMs(d-float64(song.FadeOutMs))+":d="+mixMs(float64(song.FadeOutMs)))
		}
	} else {
		// No song: the base is silence of length D, under the clips' audio.
		inputs = []mixInput{{Pre: []string{"-f", "lavfi", "-t", mixMs(d)}, Path: "anullsrc=r=48000:cl=stereo"}}
	}

	var stmts []string
	stmts = append(stmts, "[0:a]"+strings.Join(chain, ",")+"[song]")

	off := float64(doc.CutOffsetFrames) * 1000 / float64(doc.FPS)
	labels := []string{"[song]"}
	for _, t := range doc.Tracks {
		if t.Muted || t.Kind != "video" {
			continue
		}
		for _, c := range t.Clips {
			if c.Kind != "video" || c.Volume <= 0 || !hasAudio(c.Path) {
				continue
			}
			sp := parseSpeedCurve(c.Speed)
			speed, ok := sp.constant()
			if !ok || speed <= 0 {
				continue // the speed changes (or is frozen): the clip's audio is off
			}
			start, end := float64(c.StartMs)+off, float64(c.EndMs)+off
			if start >= d || end <= 0 || end <= start {
				continue
			}
			visStart, visEnd := math.Max(start, 0), math.Min(end, d)
			srcFrom := float64(c.InMs) + (visStart-start)*speed
			srcLen := (visEnd - visStart) * speed
			n := len(inputs)
			inputs = append(inputs, mixInput{Pre: []string{"-ss", mixMs(srcFrom), "-t", mixMs(srcLen)}, Path: c.Path})

			ch := []string{stereoFormat, "asetpts=PTS-STARTPTS"}
			if speed != 1 {
				ch = append(ch, atempoStages(speed)...)
			}
			if c.Volume != 1 {
				ch = append(ch, "volume="+mixSec(c.Volume))
			}
			if outLen := visEnd - visStart; outLen >= 2*clipFadeMs {
				ch = append(ch,
					"afade=t=in:st=0:d="+mixMs(clipFadeMs),
					"afade=t=out:st="+mixMs(outLen-clipFadeMs)+":d="+mixMs(clipFadeMs))
			}
			if delay := int64(math.Round(visStart)); delay > 0 {
				ch = append(ch, fmt.Sprintf("adelay=%d|%d", delay, delay))
			}
			label := fmt.Sprintf("[c%d]", n)
			stmts = append(stmts, fmt.Sprintf("[%d:a]%s%s", n, strings.Join(ch, ","), label))
			labels = append(labels, label)
		}
	}

	tail := "alimiter=limit=0.97,apad=whole_dur=" + mixMs(d) + ",atrim=start=0:end=" + mixMs(d) + "[out]"
	if len(labels) == 1 {
		stmts = append(stmts, labels[0]+tail)
	} else {
		stmts = append(stmts, strings.Join(labels, "")+fmt.Sprintf("amix=inputs=%d:normalize=0:duration=first,", len(labels))+tail)
	}
	return inputs, strings.Join(stmts, ";\n") + "\n"
}

// mixArgs are the FFmpeg arguments (run with TempDir as the working
// directory, the graph in graph.txt).
func mixArgs(inputs []mixInput, d int64, dst string) []string {
	a := []string{"-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"}
	for _, in := range inputs {
		a = append(a, in.Pre...)
		a = append(a, "-i", in.Path)
	}
	return append(a, "-/filter_complex", "graph.txt", "-map", "[out]", "-c:a", "pcm_s16le",
		"-ar", strconv.Itoa(mixRate), "-ac", "2", "-t", mixMs(float64(d)), dst)
}

// mixAudio writes the song (range, gain, fades) plus clip audio as a WAV of
// exactly D ms to dst.
func (m *Module) mixAudio(ctx context.Context, job *core.JobContext, doc EditProject, ffmpeg, dst string) error {
	if doc.Song != nil && doc.Song.EndMs <= doc.Song.StartMs {
		return core.ValidationError("The song's range is empty", map[string]string{"song": "The song's range is empty"})
	}
	if doc.FPS <= 0 {
		return core.Errorf(core.CodeInternal, "Missing frame rate for the audio")
	}
	// Which sources have sound.
	has := map[string]bool{}
	var paths []string
	for _, t := range doc.Tracks {
		if t.Muted {
			continue
		}
		for _, c := range t.Clips {
			if c.Kind == "video" && c.Volume > 0 && c.Path != "" && !has[c.Path] {
				has[c.Path] = false
				paths = append(paths, c.Path)
			}
		}
	}
	if len(paths) > 0 {
		ffprobe, err := job.Tool("ffprobe")
		if err != nil {
			return err
		}
		for _, info := range exportProbeFn(ctx, ffprobe, paths) {
			has[info.Path] = info.HasAudio
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	inputs, graph := buildMixGraph(doc, func(p string) bool { return has[p] })
	if err := os.WriteFile(filepath.Join(job.TempDir, "graph.txt"), []byte(graph), 0o600); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't write the audio mix").WithCause(err)
	}
	d := editLen(doc)
	args := mixArgs(inputs, d, dst)

	tracker := &media.ProgressTracker{Duration: float64(d) / 1000, Label: "Mixing the audio"}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	_, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: args, Dir: job.TempDir,
		OnStdout: func(l string) {
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				job.Progress(pct, msg)
			}
		},
		OnStderr: func(l string) {
			if strings.TrimSpace(l) != "" {
				mu.Lock()
				lastStderr = l
				mu.Unlock()
			}
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("audio mix cancelled: %w", ctxErr)
	}
	if err != nil {
		_ = os.Remove(dst)
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			return fmt.Errorf("run ffmpeg: %w", err)
		}
		mu.Lock()
		msg := strings.TrimSpace(lastStderr)
		mu.Unlock()
		if msg == "" {
			msg = "ffmpeg failed"
		}
		return core.Errorf(core.CodeToolFailed, "Couldn't mix the audio: %s", msg).WithCause(err)
	}
	return nil
}
