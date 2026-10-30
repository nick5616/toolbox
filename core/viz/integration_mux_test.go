//go:build integration

package viz

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func near(got, want, tol int) bool { return got >= want-tol && got <= want+tol }

const testASS = "[Script Info]\nScriptType: v4.00+\nPlayResX: 128\nPlayResY: 72\n\n[V4+ Styles]\n" +
	"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
	"Style: Default,Arial,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,10,10,10,1\n\n[Events]\n" +
	"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hi\n"

func TestMuxAndCompositeIntegration(t *testing.T) {
	ffmpeg, ffprobe := tool(t, "ffmpeg"), tool(t, "ffprobe")
	dir := t.TempDir()
	plan := RenderPlan{Analysis: AnalysisRef{Summary: AnalysisSummary{DurationMs: 1000}},
		Width: 128, Height: 72, FPS: 30, EndMs: 1000, Mode: ModeOpaque}

	frames := func(t *testing.T, path string) string {
		t.Helper()
		return probe(t, ffprobe, path, "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames")
	}

	// Opaque "renderer output": 1 s of 128x72 test video as Annex-B H.264.
	opaque := filepath.Join(dir, "opaque.h264")
	ff(t, ffmpeg, "-f", "lavfi", "-i", "testsrc=s=128x72:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "h264", opaque)
	opaqueBytes, err := os.ReadFile(opaque)
	if err != nil {
		t.Fatal(err)
	}
	song := filepath.Join(dir, "song.wav")
	ff(t, ffmpeg, "-f", "lavfi", "-i", "sine=f=440:d=3", song)

	t.Run("mux", func(t *testing.T) {
		out, _ := feed(t, plan, opaqueBytes)
		dst := filepath.Join(dir, "mux.mp4")
		var last float64
		// audio cut to 1 s starting at 0.5 s.
		if err := MuxOpaque(context.Background(), ffmpeg, out, song, 500, 1500, 30, "", dst, func(p float64) { last = p }); err != nil {
			t.Fatal(err)
		}
		if got := frames(t, dst); got != "30" {
			t.Errorf("frames %q", got)
		}
		if got := probe(t, ffprobe, dst, "-select_streams", "a:0", "-show_entries", "stream=codec_name"); got != "aac" {
			t.Errorf("audio %q", got)
		}
		d, _ := strconv.ParseFloat(probe(t, ffprobe, dst, "-show_entries", "format=duration"), 64)
		if d < 0.9 || d > 1.15 {
			t.Errorf("duration %v", d)
		}
		if last != 1 {
			t.Errorf("progress ended at %v", last)
		}
	})

	t.Run("mux with burned ass", func(t *testing.T) {
		out, td := feed(t, plan, opaqueBytes)
		if err := os.WriteFile(filepath.Join(td, "subs.ass"), []byte(testASS), 0o644); err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(dir, "mux-ass.mp4")
		if err := MuxOpaque(context.Background(), ffmpeg, out, song, 0, 0, 30, "subs.ass", dst, nil); err != nil {
			t.Fatal(err)
		}
		if got := frames(t, dst); got != "30" {
			t.Errorf("frames %q", got)
		}
	})

	// Overlay "renderer output": 64x128 stacked, red over a 0x80 alpha matte.
	stacked := filepath.Join(dir, "stacked.h264")
	ff(t, ffmpeg, "-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=1", "-f", "lavfi", "-i", "color=c=0x808080:s=64x64:r=30:d=1",
		"-filter_complex", "[0:v][1:v]vstack", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "h264", stacked)
	stackedBytes, err := os.ReadFile(stacked)
	if err != nil {
		t.Fatal(err)
	}
	overlayPlan := plan
	overlayPlan.Width, overlayPlan.Height, overlayPlan.Mode = 64, 64, ModeOverlay
	grey := filepath.Join(dir, "grey.mp4")
	ff(t, ffmpeg, "-f", "lavfi", "-i", "color=c=0x646464:s=128x72:r=30:d=1", "-i", song, "-t", "1",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", grey)

	check := func(t *testing.T, dst string) {
		t.Helper()
		if got := frames(t, dst); got != "30" {
			t.Errorf("frames %q, want 30", got)
		}
		if got := probe(t, ffprobe, dst, "-select_streams", "a:0", "-show_entries", "stream=codec_name"); got != "aac" {
			t.Errorf("audio %q", got)
		}
		// 50% red over grey 100: R about 178, G and B about 50.
		px := pixel(t, ffmpeg, dst, 128, 72)
		if !near(px[0], 178, 3) || !near(px[1], 50, 3) || !near(px[2], 50, 3) {
			t.Errorf("blended pixel %v, want about [178 50 50]", px)
		}
	}

	t.Run("composite over the video", func(t *testing.T) {
		out, _ := feed(t, overlayPlan, stackedBytes)
		dst := filepath.Join(dir, "comp.mp4")
		if err := CompositeOverlay(context.Background(), ffmpeg, out, grey, false, "", 30, 128, 72, "", dst, nil); err != nil {
			t.Fatal(err)
		}
		check(t, dst)
	})

	t.Run("composite over a looped background", func(t *testing.T) {
		short := filepath.Join(dir, "short.mp4")
		ff(t, ffmpeg, "-f", "lavfi", "-i", "color=c=0x646464:s=128x72:r=30:d=0.3", "-c:v", "libx264", "-pix_fmt", "yuv420p", short)
		out, _ := feed(t, overlayPlan, stackedBytes)
		dst := filepath.Join(dir, "loop.mp4")
		if err := CompositeOverlay(context.Background(), ffmpeg, out, short, true, song, 30, 128, 72, "", dst, nil); err != nil {
			t.Fatal(err)
		}
		check(t, dst)
	})
}
