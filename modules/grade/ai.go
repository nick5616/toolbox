package grade

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/media"
	"toolbox/core/proc"
)

// Vibe and Read the picture (SPEC §E1, §E4): interactive calls on the chat
// engine, not jobs. They run one at a time per module; CancelVibe stops the
// running one.

const (
	purposeVibe = "Writing a look"
	purposeRead = "Reading a picture"
	// ReadPixels is the long side of the still the vision model gets.
	ReadPixels = 768
)

var errCouldntWrite = core.Errorf(core.CodeToolFailed, "The chat model couldn't write a look. Try again or rephrase")

// frameFn extracts one frame of a video; a seam for tests.
var frameFn = extractFrame

// begin starts a cancellable request, cancelling any earlier one.
func (m *Module) begin(parent context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	m.vibeMu.Lock()
	if m.vibeCancel != nil {
		m.vibeCancel()
	}
	m.vibeCancel = cancel
	m.vibeMu.Unlock()
	return ctx, cancel
}

// CancelVibe stops a running Vibe or Read request.
func (m *Module) CancelVibe() {
	m.vibeMu.Lock()
	defer m.vibeMu.Unlock()
	if m.vibeCancel != nil {
		m.vibeCancel()
		m.vibeCancel = nil
	}
}

// completeLook asks for a reply that parse accepts: one retry with the error
// appended, then the user-facing failure.
func completeLook[T any](ctx context.Context, gen core.TextGenerator, req core.CompletionRequest, parse func(string) (T, error)) (T, error) {
	var zero T
	base := req.Prompt
	var perr error
	for attempt := 0; attempt < 2; attempt++ {
		reply, err := gen.Complete(ctx, req)
		if err != nil {
			if ctx.Err() != nil {
				return zero, core.Errorf(core.CodeCancelled, "Cancelled")
			}
			return zero, err
		}
		var v T
		if v, perr = parse(reply); perr == nil {
			return v, nil
		}
		req.Prompt = base + "\n\nYour last reply couldn't be used (" + perr.Error() + "). Reply again with only the JSON."
	}
	return zero, errCouldntWrite.WithCause(perr)
}

// Vibe writes req.N looks from a description.
func (m *Module) Vibe(req VibeRequest) ([]Recipe, error) {
	ctx, done := m.begin(context.Background())
	defer done()
	return m.vibe(ctx, req)
}

// vibe is Vibe on a given context (a step's job uses its own).
func (m *Module) vibe(ctx context.Context, req VibeRequest) ([]Recipe, error) {
	text := strings.TrimSpace(req.Text)
	if n := len([]rune(text)); n < 1 || n > MaxVibeChars {
		return nil, core.ValidationError(fmt.Sprintf("Describe the look in 1 to %d characters", MaxVibeChars), map[string]string{"text": "Describe the look"})
	}
	if req.N < 1 || req.N > 4 {
		return nil, core.ValidationError("Ask for 1 to 4 looks", map[string]string{"n": "1 to 4"})
	}
	if m.cfg.Text == nil {
		return nil, core.Errorf(core.CodeDependencyMissing, "Local Chat isn't available")
	}
	if _, err := m.cfg.Text.Ready(); err != nil {
		return nil, err
	}
	system, schema := SystemPrompt(), VibeSchema()
	out := make([]Recipe, 0, req.N)
	for i := 0; i < req.N; i++ {
		seed := req.Seed + uint32(i)
		r, err := completeLook(ctx, m.cfg.Text, core.CompletionRequest{
			System: system, Prompt: VibePrompt(text, i), JSONSchema: schema, MaxTokens: 1800,
			Temperature: 0.9, Seed: int64(seed), Purpose: purposeVibe,
		}, func(reply string) (Recipe, error) { return ParseVibe(reply, seed) })
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

// Read asks the vision model for 6 looks that fit a picture (or the frame of a
// video at atMs).
func (m *Module) Read(path string, atMs int64) ([]Suggestion, error) {
	if m.cfg.Vision == nil {
		return nil, core.Errorf(core.CodeDependencyMissing, "Install the Caption Writer pack to read pictures")
	}
	model, err := m.cfg.Vision.Vision()
	if err != nil {
		return nil, err
	}
	if err := core.ValidateFileInputs([]string{path}, Accepts()); err != nil {
		return nil, err
	}
	ctx, done := m.begin(context.Background())
	defer done()
	still, err := m.readStill(ctx, path, atMs)
	if err != nil {
		return nil, err
	}
	defer os.Remove(still)
	return completeLook(ctx, m.cfg.Vision, core.CompletionRequest{
		System: SystemPrompt(), Prompt: ReadPrompt(), Images: []string{still}, Model: model,
		JSONSchema: ReadSchema(), MaxTokens: 4000, Temperature: 0.8, Seed: seedOf(path, atMs), Purpose: purposeRead,
	}, func(reply string) ([]Suggestion, error) { return ParseSuggestions(reply, uint32(seedOf(path, atMs))) })
}

func seedOf(path string, atMs int64) int64 {
	var h uint32 = 2166136261
	for _, b := range []byte(path) {
		h = (h ^ uint32(b)) * 16777619
	}
	return int64(h>>1) + atMs
}

func (m *Module) readDir() (string, error) {
	dir := filepath.Join(m.cfg.CacheDir, "read")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("creating the picture folder: %w", err)
	}
	return dir, nil
}

// readStill writes a ≤ 768 px oriented still of path (or of a video's frame).
func (m *Module) readStill(ctx context.Context, path string, atMs int64) (string, error) {
	dir, err := m.readDir()
	if err != nil {
		return "", err
	}
	src := path
	if isVideo(path) {
		if m.cfg.Resolve == nil {
			return "", core.Errorf(core.CodeDependencyMissing, "FFmpeg isn't available")
		}
		ffmpeg, err := m.cfg.Resolve("ffmpeg")
		if err != nil {
			return "", err
		}
		frame := filepath.Join(dir, fmt.Sprintf("frame-%d.jpg", time.Now().UnixNano()))
		if err := frameFn(ctx, ffmpeg, path, atMs, ReadPixels, frame); err != nil {
			return "", err
		}
		defer os.Remove(frame)
		src = frame
	}
	url, err := imaging.ThumbUncached(src, ReadPixels)
	if err != nil {
		return "", err
	}
	head, data, ok := strings.Cut(url, ",")
	if !ok {
		return "", core.Errorf(core.CodeInternal, "Couldn't prepare the picture")
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return "", fmt.Errorf("decode picture: %w", err)
	}
	ext := ".jpg"
	if strings.Contains(head, "png") {
		ext = ".png"
	}
	out := filepath.Join(dir, fmt.Sprintf("read-%d%s", time.Now().UnixNano(), ext))
	if err := os.WriteFile(out, raw, 0o600); err != nil {
		return "", fmt.Errorf("write picture: %w", err)
	}
	return out, nil
}

// extractFrame writes one frame of a video as a JPEG scaled to long ≤ maxDim.
func extractFrame(ctx context.Context, ffmpeg, path string, atMs int64, maxDim int, out string) error {
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-ss", fmt.Sprintf("%.3f", float64(max(atMs, 0))/1000), "-i", path, "-frames:v", "1",
		"-vf", fmt.Sprintf("scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease", maxDim, maxDim),
		"-q:v", "3", "-y", out,
	}
	_, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: args})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return core.Errorf(core.CodeToolFailed, "FFmpeg couldn't read a frame of this video").WithCause(err)
	}
	if fi, err := os.Stat(out); err != nil || fi.Size() == 0 {
		return core.Errorf(core.CodeToolFailed, "That moment is past the end of this video")
	}
	return nil
}

func isVideo(path string) bool { return isVideoExt(filepath.Ext(path)) }

func isVideoExt(ext string) bool {
	return slices.Contains(media.VideoExtensions(), strings.ToLower(ext))
}
