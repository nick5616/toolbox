package trimmer

import (
	"reflect"
	"strings"
	"testing"
)

func TestFastExt(t *testing.T) {
	for in, want := range map[string]string{".mp4": ".mp4", ".MTS": ".ts", ".m2ts": ".ts", ".ts": ".ts", ".avi": ".avi", ".wmv": ".wmv", ".mp3": ".mp3"} {
		if got := fastExt(in); got != want {
			t.Errorf("fastExt(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFastSegmentArgs(t *testing.T) {
	got := fastSegmentArgs("in.mp4", "out.mp4", 1500, 4250, false)
	want := []string{"-ss", "1.500", "-to", "4.250", "-i", "in.mp4", "-map", "0", "-c", "copy",
		"-avoid_negative_ts", "make_zero", "-map_metadata", "0", "out.mp4"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	an := fastSegmentArgs("in.mp4", "out.mp4", 0, 1000, true)
	if an[len(an)-2] != "-an" || an[len(an)-1] != "out.mp4" {
		t.Fatalf("-an missing: %v", an)
	}
}

func TestConcat(t *testing.T) {
	list := concatList([]string{`C:\tmp\a.mp4`, "/tmp/it's.mp4"})
	if list != "file 'C:/tmp/a.mp4'\nfile '/tmp/it'\\''s.mp4'\n" {
		t.Fatalf("list = %q", list)
	}
	args := strings.Join(fastConcatArgs("l.txt", "o.mp4"), " ")
	if !strings.Contains(args, "-f concat -safe 0 -i l.txt") || !strings.Contains(args, "-c copy") {
		t.Fatalf("args = %s", args)
	}
}

func TestBuildGraph(t *testing.T) {
	g, v, a := buildGraph([]Segment{{1000, 3000}}, true, true, "")
	want := "[0:v:0]trim=start=1.000:end=3.000,setpts=PTS-STARTPTS[v0];[0:a:0]atrim=start=1.000:end=3.000,asetpts=PTS-STARTPTS[a0];[v0][a0]concat=n=1:v=1:a=1[cv][ca]"
	if g != want || v != "[cv]" || a != "[ca]" {
		t.Fatalf("got %q %q %q", g, v, a)
	}
	g, v, _ = buildGraph([]Segment{{0, 1000}, {2000, 3000}, {4000, 5500}}, true, true, "crop=2:2:0:0,scale=-2:720")
	if !strings.Contains(g, "[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[cv][ca]") ||
		!strings.HasSuffix(g, ";[cv]crop=2:2:0:0,scale=-2:720[vout]") || v != "[vout]" ||
		!strings.Contains(g, "trim=start=4.000:end=5.500") {
		t.Fatalf("graph = %s", g)
	}
	g, v, a = buildGraph([]Segment{{0, 1000}}, false, true, "")
	if v != "" || a != "[ca]" || strings.Contains(g, "[0:v") || !strings.Contains(g, "concat=n=1:v=0:a=1[ca]") {
		t.Fatalf("audio graph = %s", g)
	}
}

func TestCropFor(t *testing.T) {
	tests := []struct {
		name   string
		w, h   int
		aspect Aspect
		cx, cy float64
		want   *cropRect
	}{
		{"landscape 9:16 centre", 1920, 1080, AspectPortrait, 0.5, 0.5, &cropRect{608, 1080, 656, 0}},
		{"landscape 9:16 left", 1920, 1080, AspectPortrait, 0, 0.5, &cropRect{608, 1080, 0, 0}},
		{"landscape 9:16 right", 1920, 1080, AspectPortrait, 1, 0.5, &cropRect{608, 1080, 1312, 0}},
		{"landscape 1:1", 1920, 1080, AspectSquare, 0.5, 0.5, &cropRect{1080, 1080, 420, 0}},
		{"landscape 4:5", 1920, 1080, AspectFourFive, 0.5, 0.5, &cropRect{864, 1080, 528, 0}},
		{"landscape 16:9 same", 1920, 1080, AspectWide, 0.5, 0.5, nil},
		{"portrait 9:16 same", 1080, 1920, AspectPortrait, 0.5, 0.5, nil},
		{"portrait 1:1 centre", 1080, 1920, AspectSquare, 0.5, 0.5, &cropRect{1080, 1080, 0, 420}},
		{"portrait 1:1 top", 1080, 1920, AspectSquare, 0.5, 0, &cropRect{1080, 1080, 0, 0}},
		{"portrait 1:1 bottom", 1080, 1920, AspectSquare, 0.5, 1, &cropRect{1080, 1080, 0, 840}},
		{"portrait 16:9", 1080, 1920, AspectWide, 0.5, 0.5, &cropRect{1080, 608, 0, 656}},
		{"portrait 4:5", 1080, 1920, AspectFourFive, 0.5, 0.5, &cropRect{1080, 1350, 0, 285 &^ 1}},
		{"keep", 1920, 1080, AspectKeep, 0.5, 0.5, nil},
		{"odd dims even output", 1921, 1081, AspectSquare, 0.5, 0.5, &cropRect{1080, 1080, 420, 0}},
	}
	for _, tc := range tests {
		got := cropFor(tc.w, tc.h, tc.aspect, tc.cx, tc.cy)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestVideoFilter(t *testing.T) {
	o := Options{Aspect: AspectPortrait, CropX: 0.5, CropY: 0.5, MaxHeight: 720}
	if got := videoFilter(1920, 1080, o); got != "crop=608:1080:656:0,scale=-2:720" {
		t.Fatalf("got %q", got)
	}
	if got := videoFilter(1280, 720, Options{MaxHeight: 1080}); got != "" {
		t.Fatalf("no upscale: %q", got)
	}
	if got := outputHeight(1920, 1080, o); got != 720 {
		t.Fatalf("height %d", got)
	}
}

func TestVideoBitrate(t *testing.T) {
	// 50 MB over 60 s with 192k audio: (50*8*1048576*0.97 - 192000*60)/60/1000
	got := videoBitrateKbps(50, 192000, 60)
	if got < 6500 || got > 6600 {
		t.Fatalf("kbps = %v", got)
	}
	if videoBitrateKbps(1, 192000, 3600) >= minVideoKbps {
		t.Fatal("expected too low")
	}
	if videoBitrateKbps(10, 0, 0) != 0 {
		t.Fatal("zero duration")
	}
}

func TestAudioFamily(t *testing.T) {
	tests := map[string]struct {
		ext   string
		codec string
	}{
		".mp3": {".mp3", "libmp3lame"}, ".m4a": {".m4a", "aac"}, ".aac": {".aac", "aac"},
		".wav": {".wav", "pcm_s16le"}, ".FLAC": {".flac", "flac"}, ".ogg": {".ogg", "libopus"},
		".opus": {".opus", "libopus"}, ".wma": {".m4a", "aac"}, ".aiff": {".m4a", "aac"},
	}
	for in, want := range tests {
		ext, args := audioFamily(in)
		if ext != want.ext || args[1] != want.codec {
			t.Errorf("%s: %s %v", in, ext, args)
		}
	}
}

func TestPreciseArgs(t *testing.T) {
	g, v, a := buildGraph([]Segment{{0, 1000}}, true, true, "")
	s := preciseSpec{In: "i.mp4", Out: "o.mp4", Graph: g, VLabel: v, ALabel: a}
	got := strings.Join(s.args(), " ")
	for _, w := range []string{"-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p", "-c:a aac -b:a 192k", "-movflags +faststart"} {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in %s", w, got)
		}
	}
	s.Kbps, s.Pass, s.PassLog = 5000, 1, "log"
	p1 := strings.Join(s.args(), " ")
	if !strings.Contains(p1, "-b:v 5000k") || !strings.Contains(p1, "-pass 1 -passlogfile log") ||
		!strings.HasSuffix(p1, "-f null -") || strings.Contains(p1, "-crf") {
		t.Errorf("pass1 = %s", p1)
	}
	s.Pass = 2
	if p2 := strings.Join(s.args(), " "); !strings.Contains(p2, "-pass 2") || !strings.HasSuffix(p2, "o.mp4") {
		t.Errorf("pass2 = %s", p2)
	}
	au := preciseSpec{In: "i.mp3", Out: "o.mp3", Graph: "g", ALabel: "[ca]", AudioOnlyCodecs: []string{"-c:a", "libmp3lame", "-q:a", "0"}}
	if got := strings.Join(au.args(), " "); strings.Contains(got, "libx264") || strings.Contains(got, "faststart") || !strings.Contains(got, "libmp3lame") {
		t.Errorf("audio = %s", got)
	}
}

func TestShiftOf(t *testing.T) {
	kf := []int64{1400, 3400, 8400} // start_time 1400 ms
	got := shiftOf([]Segment{{2500, 3000}, {4000, 5000}}, kf, 1400)
	// timeline keyframes 0, 2000, 7000: seg1 shift 500, seg2 shift 2000
	if got != 2000 {
		t.Fatalf("shift = %d", got)
	}
	if shiftOf([]Segment{{0, 1000}}, kf, 1400) != 0 {
		t.Fatal("keyframe at start")
	}
}
