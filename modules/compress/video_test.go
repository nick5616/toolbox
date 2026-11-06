package compress

import (
	"slices"
	"strings"
	"testing"
)

func vopts(mod func(*Options)) Options {
	o := DefaultOptions()
	if mod != nil {
		mod(&o)
	}
	return o
}

func TestPlanVideo(t *testing.T) {
	land := VideoFacts{DurationMs: 20_000, Width: 1920, Height: 1080, FPS: 30, HasAudio: true, AudioChannels: 2}
	port := VideoFacts{DurationMs: 20_000, Width: 1080, Height: 1920, FPS: 30, HasAudio: true, AudioChannels: 2}
	tests := []struct {
		name    string
		f       VideoFacts
		budget  int64
		opts    Options
		w, h    int
		fps     float64
		audio   int
		ch      int
		grade   Grade
		possibl bool
		summary string
	}{
		{"landscape 2MB", land, 1_940_000, vopts(nil), 640, 360, 30, 96, 2, GradeFair,
			true, "1080p → 360p · 30 fps · H.264 668 kb/s · AAC 96 kb/s"},
		{"portrait short side", port, 1_940_000, vopts(nil), 360, 640, 30, 96, 2, GradeFair, true, ""},
		{"roomy keeps source", VideoFacts{DurationMs: 20_000, Width: 1920, Height: 1080, FPS: 30, HasAudio: true, AudioChannels: 2},
			50_000_000, vopts(nil), 1920, 1080, 30, 160, 2, GradeGreat, true,
			"1080p · 30 fps · H.264 " + "19.5 Mb/s" + " · AAC 160 kb/s"},
		{"max height caps", land, 50_000_000, vopts(func(o *Options) { o.MaxHeight = 720 }), 1280, 720, 30, 160, 2, GradeGreat, true, ""},
		{"never upscales", VideoFacts{DurationMs: 10_000, Width: 640, Height: 360, FPS: 30}, 50_000_000, vopts(nil), 640, 360, 30, 0, 0, GradeGreat, true,
			"360p · 30 fps · H.264 39.4 Mb/s"},
		{"60 fps kept when roomy", VideoFacts{DurationMs: 60_000, Width: 1920, Height: 1080, FPS: 60, HasAudio: true, AudioChannels: 2},
			100_000_000, vopts(nil), 1920, 1080, 60, 160, 2, GradeGreat, true, ""},
		{"120 fps capped at 60", VideoFacts{DurationMs: 60_000, Width: 1920, Height: 1080, FPS: 120, HasAudio: true, AudioChannels: 2},
			100_000_000, vopts(nil), 1920, 1080, 60, 160, 2, GradeGreat, true, ""},
		{"no audio", VideoFacts{DurationMs: 20_000, Width: 1920, Height: 1080, FPS: 30}, 1_940_000, vopts(nil), 640, 360, 30, 0, 0, GradeFair, true, ""},
		{"keep audio off", land, 1_940_000, vopts(func(o *Options) { o.KeepAudio = false }), 640, 360, 30, 0, 0, GradeFair, true, ""},
		{"mono source", VideoFacts{DurationMs: 20_000, Width: 1920, Height: 1080, FPS: 30, HasAudio: true, AudioChannels: 1}, 1_940_000, vopts(nil), 640, 360, 30, 96, 1, GradeFair, true, ""},
		{"h264 vs h265 (h264)", VideoFacts{DurationMs: 30_000, Width: 1280, Height: 720, FPS: 30, HasAudio: true, AudioChannels: 2},
			3_800_000, vopts(nil), 852, 480, 30, 128, 2, GradeGood, true, ""},
		{"h264 vs h265 (h265)", VideoFacts{DurationMs: 30_000, Width: 1280, Height: 720, FPS: 30, HasAudio: true, AudioChannels: 2},
			3_800_000, vopts(func(o *Options) { o.VideoCodec = CodecH265 }), 960, 540, 30, 128, 2, GradeGood, true,
			"720p → 540p · 30 fps · H.265 870 kb/s · AAC 128 kb/s"},
		{"tiny budget is impossible", land, 100_000, vopts(nil), 0, 0, 0, 0, 0, GradeNone, false, ""},
		{"long video at 144p stays possible but poor", VideoFacts{DurationMs: 1_800_000, Width: 1920, Height: 1080, FPS: 30, HasAudio: true, AudioChannels: 2},
			19_400_000, vopts(nil), 256, 144, 15, 48, 1, GradePoor, true, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := planVideo(tc.f, tc.budget, tc.opts)
			if p.Possible != tc.possibl {
				t.Fatalf("possible = %v, want %v (%+v)", p.Possible, tc.possibl, p)
			}
			if !tc.possibl {
				return
			}
			if p.Width != tc.w || p.Height != tc.h || p.FPS != tc.fps {
				t.Errorf("size/fps = %dx%d@%g, want %dx%d@%g", p.Width, p.Height, p.FPS, tc.w, tc.h, tc.fps)
			}
			if p.AudioKbps != tc.audio || p.AudioChannels != tc.ch {
				t.Errorf("audio = %d kb/s ch %d, want %d ch %d", p.AudioKbps, p.AudioChannels, tc.audio, tc.ch)
			}
			if p.Grade != tc.grade {
				t.Errorf("grade = %q, want %q (bpp %.3f)", p.Grade, tc.grade, p.Bpp)
			}
			if p.Width%2 != 0 || p.Height%2 != 0 {
				t.Errorf("odd output size %dx%d", p.Width, p.Height)
			}
			if tc.summary != "" && p.Summary() != tc.summary {
				t.Errorf("summary = %q, want %q", p.Summary(), tc.summary)
			}
			// The plan never exceeds the budget.
			bits := float64(p.VideoKbps+p.AudioKbps) * 1000 * float64(tc.f.DurationMs) / 1000
			if bits/8 > float64(tc.budget) {
				t.Errorf("plan needs %.0f bytes, budget %d", bits/8, tc.budget)
			}
		})
	}
}

func TestPlanVideoLowerFPSFlag(t *testing.T) {
	f := VideoFacts{DurationMs: 60_000, Width: 1920, Height: 1080, FPS: 120}
	if p := planVideo(f, 100_000_000, vopts(nil)); !p.LowerFPS || p.FPS != 60 {
		t.Errorf("120 -> 60 should lower fps: %+v", p)
	}
	f.FPS = 30
	if p := planVideo(f, 100_000_000, vopts(nil)); p.LowerFPS {
		t.Errorf("30 -> 30 must not add an fps filter: %+v", p)
	}
	f.FPS = 0 // unknown
	if p := planVideo(f, 100_000_000, vopts(nil)); p.LowerFPS || p.FPS != 30 {
		t.Errorf("unknown fps: %+v", p)
	}
}

func TestPlanVideoNonStandardSource(t *testing.T) {
	// 1600x900 is not on the ladder: the native size is the first candidate.
	f := VideoFacts{DurationMs: 10_000, Width: 1600, Height: 900, FPS: 30}
	p := planVideo(f, 100_000_000, vopts(nil))
	if p.Width != 1600 || p.Height != 900 {
		t.Errorf("native size should be kept: %dx%d", p.Width, p.Height)
	}
	// Odd dimensions are rounded down to even.
	f = VideoFacts{DurationMs: 10_000, Width: 855, Height: 481, FPS: 30}
	p = planVideo(f, 100_000_000, vopts(nil))
	if p.Width != 854 || p.Height != 480 {
		t.Errorf("odd source: %dx%d", p.Width, p.Height)
	}
}

func TestPlanVideoSplit(t *testing.T) {
	f := VideoFacts{DurationMs: 600_000, Width: 1920, Height: 1080, FPS: 30, HasAudio: true, AudioChannels: 2}
	lower := planVideo(f, 19_400_000, vopts(nil))
	if lower.Parts != 1 || lower.Grade != GradePoor {
		t.Fatalf("lower: %+v", lower)
	}
	split := planVideo(f, 19_400_000, vopts(func(o *Options) { o.IfTooSmall = TooSmallSplit }))
	if split.Parts < 2 || !atLeastFair(split.Grade) {
		t.Fatalf("split: %+v", split)
	}
	// Fewest parts: one fewer would not be fair.
	pf := f
	pf.DurationMs = partDur(f.DurationMs, split.Parts-1)
	if split.Parts > 2 {
		if prev := planVideoSingle(pf, 19_400_000, vopts(nil)); atLeastFair(prev.Grade) {
			t.Errorf("parts %d is not the fewest: %d parts is already %v", split.Parts, split.Parts-1, prev.Grade)
		}
	}
	// A fine-looking video is not split.
	short := VideoFacts{DurationMs: 20_000, Width: 1920, Height: 1080, FPS: 30}
	if p := planVideo(short, 19_400_000, vopts(func(o *Options) { o.IfTooSmall = TooSmallSplit })); p.Parts != 1 {
		t.Errorf("fine video split into %d", p.Parts)
	}
	// Hopeless even at MaxParts: impossible.
	huge := VideoFacts{DurationMs: 3_600_000 * 1000, Width: 1920, Height: 1080, FPS: 30}
	if p := planVideo(huge, 100_000, vopts(func(o *Options) { o.IfTooSmall = TooSmallSplit })); p.Possible {
		t.Errorf("should be impossible: %+v", p)
	}
	if !strings.Contains(split.Describe(), "parts · ") {
		t.Errorf("describe = %q", split.Describe())
	}
}

func TestSplitRanges(t *testing.T) {
	r := splitRanges(10_001, 3)
	var sum int64
	for i, p := range r {
		if i > 0 && p.StartMs != r[i-1].StartMs+r[i-1].DurMs {
			t.Errorf("gap before part %d", i)
		}
		sum += p.DurMs
	}
	if sum != 10_001 || len(r) != 3 {
		t.Errorf("ranges %v", r)
	}
}

func TestVideoArgsH264(t *testing.T) {
	p := VideoPlan{Codec: CodecH264, Width: 960, Height: 540, FPS: 15, LowerFPS: true, VideoKbps: 668, AudioKbps: 96, AudioChannels: 2, Parts: 1}
	o := DefaultOptions()
	a1 := strings.Join(videoArgs(1, "0-0", p, 668, `C:\in.mp4`, partRange{}, false, o, "out.mp4"), " ")
	for _, want := range []string{"-i C:\\in.mp4", "-map 0:v:0", "scale=960:540:flags=lanczos,setsar=1,fps=15", "-c:v libx264", "-b:v 668k",
		"-maxrate 1002k", "-bufsize 1336k", "-preset medium", "-pix_fmt yuv420p", "-pass 1", "-passlogfile pass-0-0", "-an -f null -"} {
		if !strings.Contains(a1, want) {
			t.Errorf("pass 1 missing %q in %s", want, a1)
		}
	}
	if strings.Contains(a1, "-map 0:a") || strings.Contains(a1, "faststart") || strings.Contains(a1, "-ss") {
		t.Errorf("pass 1 has pass-2/part flags: %s", a1)
	}
	a2 := videoArgs(2, "0-0", p, 668, `C:\in.mp4`, partRange{}, false, o, `C:\t\out.mp4`)
	s2 := strings.Join(a2, " ")
	for _, want := range []string{"-pass 2", "-map 0:a:0?", "-c:a aac", "-b:a 96k", "-map_metadata -1", "-movflags +faststart"} {
		if !strings.Contains(s2, want) {
			t.Errorf("pass 2 missing %q in %s", want, s2)
		}
	}
	if strings.Contains(s2, "-ac 1") {
		t.Errorf("stereo got -ac 1")
	}
	if a2[len(a2)-1] != `C:\t\out.mp4` {
		t.Errorf("output must be last: %v", a2)
	}
	// No filter holds a path.
	for i, x := range a2 {
		if x == "-vf" && strings.ContainsAny(a2[i+1], `\/:`) && !strings.Contains(a2[i+1], "scale=") {
			t.Errorf("path in filter %q", a2[i+1])
		}
	}
}

func TestVideoArgsVariants(t *testing.T) {
	p := VideoPlan{Codec: CodecH265, Width: 1280, Height: 720, FPS: 30, VideoKbps: 900, AudioKbps: 48, AudioChannels: 1, Parts: 3}
	o := vopts(func(o *Options) { o.KeepMetadata = true })
	a := strings.Join(videoArgs(2, "2-1", p, 800, "in.mp4", partRange{StartMs: 20_000, DurMs: 10_000}, true, o, "o.mp4"), " ")
	for _, want := range []string{"-ss 20.000 -t 10.000 -i in.mp4", "-c:v libx265", "-tag:v hvc1", "-x265-params pass=2:stats=x265-2-1.log", "-ac 1"} {
		if !strings.Contains(a, want) {
			t.Errorf("missing %q in %s", want, a)
		}
	}
	if strings.Contains(a, "map_metadata") || strings.Contains(a, "-passlogfile") || strings.Contains(a, "fps=") {
		t.Errorf("unexpected flags: %s", a)
	}
	noAudio := p
	noAudio.AudioKbps = 0
	b := videoArgs(2, "0-0", noAudio, 800, "in.mp4", partRange{}, false, DefaultOptions(), "o.mp4")
	if !slices.Contains(b, "-an") || slices.Contains(b, "aac") {
		t.Errorf("no-audio plan: %v", b)
	}
}

func TestRetryKbps(t *testing.T) {
	// 2.4 MB with a 2 MB budget and 0.24 MB of audio: scale video by ~0.78.
	got := retryKbps(1000, 2_400_000, 1_940_000, 240_000)
	if got >= 1000 || got < 700 || got > 800 {
		t.Errorf("retryKbps = %d", got)
	}
	// Always lower, even when the measure is nonsense.
	if got := retryKbps(1000, 100, 1_940_000, 240_000); got >= 1000 {
		t.Errorf("must go down: %d", got)
	}
}
