package viz

import (
	"strings"
	"testing"
)

func has(args []string, seq ...string) bool {
	for i := 0; i+len(seq) <= len(args); i++ {
		ok := true
		for j, s := range seq {
			if args[i+j] != s {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func index(args []string, s string) int {
	for i, a := range args {
		if a == s {
			return i
		}
	}
	return -1
}

func TestMuxOpaqueArgs(t *testing.T) {
	h264 := RenderOutput{Path: "/t/video.h264", Codec: "h264", Frames: 90}
	mjpeg := RenderOutput{Path: "/t/frames.mjpeg", Codec: "mjpeg", Frames: 90}
	cases := []struct {
		name         string
		out          RenderOutput
		start, end   int64
		ass          string
		must         [][]string
		mustNot      []string
		wantVideoVF  bool
		firstInputIs []string
	}{
		{name: "copy", out: h264,
			must:    [][]string{{"-f", "h264", "-framerate", "30", "-i", "/t/video.h264"}, {"-c:v", "copy"}, {"-c:a", "aac", "-b:a", "192k", "-avoid_negative_ts", "make_zero", "-t", "3.000"}, {"-movflags", "+faststart", "out.mp4"}},
			mustNot: []string{"-ss", "-to", "libx264", "-vf", "-shortest"}},
		{name: "trim audio", out: h264, start: 10_500, end: 20_000,
			must: [][]string{{"-ss", "10.500", "-to", "20.000", "-i", "song.flac"}}},
		{name: "start only", out: h264, start: 1500,
			must: [][]string{{"-ss", "1.500", "-i", "song.flac"}}, mustNot: []string{"-to"}},
		{name: "mjpeg", out: mjpeg,
			must:    [][]string{{"-f", "mjpeg", "-framerate", "30", "-i", "/t/frames.mjpeg"}, {"-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"}},
			mustNot: []string{"copy", "-vf"}},
		{name: "ass forces re-encode", out: h264, ass: "subs.ass",
			must:    [][]string{{"-vf", "ass=subs.ass", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"}},
			mustNot: []string{"copy"}},
		{name: "ass mjpeg", out: mjpeg, ass: "subs.ass",
			must: [][]string{{"-vf", "ass=subs.ass", "-c:v", "libx264", "-preset", "medium"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			args := muxOpaqueArgs(c.out, "song.flac", c.start, c.end, 30, c.ass, "out.mp4")
			for _, m := range c.must {
				if !has(args, m...) {
					t.Errorf("missing %v in %v", m, args)
				}
			}
			for _, m := range c.mustNot {
				if index(args, m) >= 0 {
					t.Errorf("unexpected %q in %v", m, args)
				}
			}
			if args[len(args)-1] != "out.mp4" {
				t.Error("dst must be last")
			}
			if !has(args, "-map", "0:v:0", "-map", "1:a:0") {
				t.Error("maps")
			}
		})
	}
}

func TestCompositeArgs(t *testing.T) {
	out := RenderOutput{Path: "/t/video.h264", Codec: "h264", Frames: 90}
	t.Run("base audio copy", func(t *testing.T) {
		args := compositeArgs(out, "in.mp4", false, "", 25, 1080, 1920, "", "o.mp4", true)
		if !has(args, "-i", "in.mp4", "-f", "h264", "-framerate", "25", "-i", "/t/video.h264") {
			t.Errorf("inputs %v", args)
		}
		if !has(args, "-map", "[v]", "-map", "0:a:0?") || !has(args, "-c:a", "copy") {
			t.Errorf("audio %v", args)
		}
		if index(args, "-stream_loop") >= 0 {
			t.Error("loop on a plain base")
		}
		g := args[index(args, "-filter_complex")+1]
		for _, want := range []string{"[1:v]split[a][b]", "crop=iw:ih/2:0:0", "crop=iw:ih/2:0:ih/2,format=gray[m]",
			"[c][m]alphamerge,scale=1080:1920:flags=bicubic[ov]", "[0:v]fps=25[bg]", "overlay=0:0:format=auto:shortest=1,format=yuv420p[v]"} {
			if !strings.Contains(g, want) {
				t.Errorf("graph lacks %q: %s", want, g)
			}
		}
		if strings.Contains(g, "ass=") || strings.Contains(g, "force_original_aspect_ratio") {
			t.Errorf("graph: %s", g)
		}
	})
	t.Run("base audio transcoded", func(t *testing.T) {
		args := compositeArgs(out, "in.mp4", false, "", 30, 1920, 1080, "", "o.mp4", false)
		if !has(args, "-c:a", "aac", "-b:a", "192k") || index(args, "copy") >= 0 {
			t.Errorf("%v", args)
		}
	})
	t.Run("loop base with separate audio", func(t *testing.T) {
		args := compositeArgs(out, "bg.mp4", true, "song.flac", 30, 1280, 720, "", "o.mp4", true)
		if !has(args, "-stream_loop", "-1", "-i", "bg.mp4") {
			t.Errorf("loop %v", args)
		}
		if !has(args, "-i", "song.flac") || !has(args, "-map", "2:a:0") || !has(args, "-c:a", "aac", "-b:a", "192k") {
			t.Errorf("audio %v", args)
		}
		if !has(args, "-shortest") {
			t.Error("a looped base needs -shortest")
		}
		if g := args[index(args, "-filter_complex")+1]; !strings.Contains(g, "[0:v]fps=30,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1[bg]") {
			t.Errorf("graph %s", g)
		}
	})
	t.Run("ass last", func(t *testing.T) {
		args := compositeArgs(out, "in.mp4", false, "", 30, 1920, 1080, "subs.ass", "o.mp4", true)
		g := args[index(args, "-filter_complex")+1]
		if !strings.HasSuffix(g, "overlay=0:0:format=auto:shortest=1,format=yuv420p,ass=subs.ass[v]") {
			t.Errorf("graph %s", g)
		}
	})
	t.Run("mjpeg input", func(t *testing.T) {
		m := RenderOutput{Path: "/t/frames.mjpeg", Codec: "mjpeg", Frames: 10}
		if args := compositeArgs(m, "in.mp4", false, "", 30, 640, 360, "", "o.mp4", false); !has(args, "-f", "mjpeg", "-framerate", "30", "-i", "/t/frames.mjpeg") {
			t.Errorf("%v", args)
		}
	})
	t.Run("rotated display size is used as given", func(t *testing.T) {
		// callers pass the display size (rotation applied); the graph uses it as is.
		g := overlayGraph(30, 1080, 1920, false, "")
		if !strings.Contains(g, "scale=1080:1920") {
			t.Error(g)
		}
	})
}

func TestWorkDir(t *testing.T) {
	out := RenderOutput{Path: "/tmp/job/video.h264"}
	if workDir(out, "") != "" {
		t.Error("no ass, no dir")
	}
	if got := workDir(out, "subs.ass"); got != "/tmp/job" && !strings.HasSuffix(got, "job") {
		t.Errorf("dir %q", got)
	}
}
