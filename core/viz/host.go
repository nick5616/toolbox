package viz

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
)

// Headless requests (Phase 14 A2): pipeline steps need a picture or an edit
// built by code that only exists in the webview (composer/render.ts and the
// auto-fill recipes). They travel the same way as video renders: a viz:render
// event with a plan, and `vz1|<token>|…` raw messages back, with the same
// token and origin rules. The answer is one file instead of a stream.

type hostKindT int

const (
	hostStream      hostKindT = iota // an elementary video stream
	hostComposition                  // one PNG or JPEG
	hostRecipe                       // one JSON document
	hostStill                        // one PNG/JPEG/WebP frame of an edit (Phase 21)
)

func (p RenderPlan) hostKind() hostKindT {
	switch {
	case p.Composition != nil:
		return hostComposition
	case p.Recipe != nil:
		return hostRecipe
	case p.Still != nil:
		return hostStill
	}
	return hostStream
}

// eventKind is RenderStart.Kind.
func (k hostKindT) eventKind() string {
	switch k {
	case hostComposition:
		return "composition"
	case hostRecipe:
		return "recipe"
	case hostStill:
		return "still"
	}
	return ""
}

// singleEncoder is the start message's encoder for a single-file answer.
func (p RenderPlan) singleEncoder() string {
	switch p.hostKind() {
	case hostComposition:
		if p.Composition.Format == "png" {
			return "png"
		}
		return "jpg"
	case hostRecipe:
		return "json"
	case hostStill:
		switch p.Still.Format {
		case "png", "webp":
			return p.Still.Format
		}
		return "jpg"
	}
	return ""
}

// maxSingleBytes caps a still or a recipe result.
const maxSingleBytes = 256 << 20 // Phase 21: full-resolution stills up to 8192 px

// HostReady reports whether the main window's RenderHost has announced itself
// (`vz1|host|up`). Steps that render headless wait while it is false.
func (b *RenderBroker) HostReady() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.hostUp
}

// ErrNoHost is what a step's PrepareStep returns while no window can render.
func ErrNoHost() *core.AppError {
	return core.ErrWaiting("Open Toolbox to render", "This step draws in the app's window. It continues when the window is open.")
}

// WaitForHost returns ErrNoHost while the broker has no host (nil broker too).
func (b *RenderBroker) WaitForHost() error {
	if b == nil || !b.HostReady() {
		return ErrNoHost()
	}
	return nil
}

// RenderComposition renders a Photo Composer document in the main window and
// returns the PNG or JPEG written in job.TempDir. width and height are the
// output size in pixels.
func (b *RenderBroker) RenderComposition(ctx context.Context, job *core.JobContext, c CompositionPlan, width, height int) (RenderOutput, error) {
	if c.Format != "png" && c.Format != "jpg" {
		return RenderOutput{}, core.ValidationError("Pick PNG or JPEG", nil)
	}
	if width < 1 || height < 1 {
		return RenderOutput{}, core.ValidationError("The picture has no size", nil)
	}
	return b.render(ctx, job, RenderPlan{Width: width, Height: height, FPS: 1, Mode: ModeOpaque, Composition: &c})
}

// BuildEdit runs an auto-fill recipe in the main window and returns the
// filled project as JSON. ref is the song's analysis.
func (b *RenderBroker) BuildEdit(ctx context.Context, job *core.JobContext, r RecipePlan, ref AnalysisRef) (string, error) {
	out, err := b.render(ctx, job, RenderPlan{Analysis: ref, FPS: 1, Mode: ModeOpaque, Recipe: &r})
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(out.Path)
	if err != nil {
		return "", fmt.Errorf("read recipe result: %w", err)
	}
	_ = os.Remove(out.Path)
	return string(raw), nil
}

// singleFile is the file name of a single-file answer.
func singleFile(codec string) string {
	switch codec {
	case "png":
		return "still.png"
	case "jpeg":
		return "still.jpg"
	case "json":
		return "result.json"
	}
	return filepath.Base(streamFile(codec))
}
