package viz

import (
	"context"

	"toolbox/core"
)

// MuxOpaque muxes the rendered stream with audio (cut to startMs..endMs; 0 =
// whole). ass is "" or a subtitle file name in dst's job TempDir, burned in
// last, which forces a re-encode (SPEC.md §7.4, §9.6). RB1's.
func MuxOpaque(ctx context.Context, ffmpeg string, out RenderOutput, audio string, startMs, endMs int64, fps int, ass, dst string, onProgress func(float64)) error {
	return core.Errorf(core.CodeInternal, "not built yet")
}

// CompositeOverlay recombines a double-height colour/alpha stream, scales it
// to w×h and overlays it on base (looped when loopBase), with audio from
// audio ("" = base's own), burning in ass last (SPEC.md §7.4). RB1's.
func CompositeOverlay(ctx context.Context, ffmpeg string, out RenderOutput, base string, loopBase bool, audio string, fps, w, h int, ass, dst string, onProgress func(float64)) error {
	return core.Errorf(core.CodeInternal, "not built yet")
}
