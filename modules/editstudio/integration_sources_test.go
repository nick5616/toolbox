//go:build integration

package editstudio

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

// Real FFmpeg: `go test -tags integration -run 'Source|Index|Shot|Interp|Image' ./modules/editstudio/`.

func realTools(t *testing.T) map[string]string {
	t.Helper()
	tools := map[string]string{}
	for _, id := range []string{"ffmpeg", "ffprobe"} {
		p, err := exec.LookPath(id)
		if err != nil {
			t.Skipf("%s isn't installed", id)
		}
		tools[id] = p
	}
	return tools
}

func ffmpegDo(t *testing.T, ffmpeg string, args ...string) {
	t.Helper()
	out, err := exec.Command(ffmpeg, append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("ffmpeg %v: %v\n%s", args, err, out)
	}
}

func realModule(t *testing.T, tools map[string]string) *Module {
	t.Helper()
	m := newTestModule(t)
	m.cfg.Resolve = func(id string) (string, error) { return tools[id], nil }
	return m
}

func realJob(t *testing.T, tools map[string]string, o Options) (*core.JobContext, *recorder) {
	t.Helper()
	rec := &recorder{}
	return newJob(t, t.TempDir(), o, rec, tools), rec
}

// checkStream verifies an edit stream against its index and the bytes on disk.
func checkStream(t *testing.T, es EditStream, wantFrames, tolerance int) StreamIndex {
	t.Helper()
	idx, err := ReadIndex(es.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if idx.Frames != es.Frames || idx.Width != es.Width || idx.Height != es.Height || idx.FPS != es.FPS {
		t.Fatalf("index %+v disagrees with %+v", idx, es)
	}
	if d := idx.Frames - wantFrames; d < -tolerance || d > tolerance {
		t.Errorf("%d frames, want %d ± %d", idx.Frames, wantFrames, tolerance)
	}
	if !strings.HasPrefix(idx.Codec, "avc1.") || len(idx.Codec) != len("avc1.640028") {
		t.Errorf("codec %q", idx.Codec)
	}
	data, err := os.ReadFile(es.Stream)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(data)) != idx.Bytes || idx.Offsets[idx.Frames] != idx.Bytes {
		t.Errorf("size %d, index bytes %d, last offset %d", len(data), idx.Bytes, idx.Offsets[idx.Frames])
	}
	for n := 0; n < idx.Frames; n++ {
		au := data[idx.Offsets[n]:idx.Offsets[n+1]]
		// start code, then an AUD NAL (type 9)
		i := 2
		if len(au) > 3 && au[2] == 0 {
			i = 3
		}
		if len(au) < i+2 || au[i] != 1 || au[i+1]&0x1f != 9 {
			t.Fatalf("frame %d doesn't start with an AUD: % x", n, au[:min(8, len(au))])
		}
	}
	for n := 0; n < idx.Frames; n++ {
		isKey := false
		for _, k := range idx.Keys {
			isKey = isKey || k == n
		}
		if want := n%10 == 0; isKey != want {
			t.Fatalf("frame %d: key=%v, want %v (keys %v)", n, isKey, want, idx.Keys)
		}
	}
	return idx
}

func TestIntegrationSourceStreamsBothTiers(t *testing.T) {
	tools := realTools(t)
	m := realModule(t, tools)
	src := filepath.Join(t.TempDir(), "clip.mp4")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=4", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-g", "48", src)
	ctx := context.Background()
	job, rec := realJob(t, tools, Options{})

	// Preview: short side 540 → 960x540, at 30 fps from a 24 fps source (cfr).
	var last float64
	prev, err := m.EnsureStream(ctx, job, src, PreviewShort(1280, 720), 30, func(p float64) { last = p })
	if err != nil {
		t.Fatal(err)
	}
	if prev.Width != 960 || prev.Height != 540 || prev.FPS != 30 || last != 1 {
		t.Fatalf("%+v progress %v", prev, last)
	}
	checkStream(t, prev, 120, 1)

	// Export: the source's own short side (720) for a 1080x1920 output.
	exp, err := m.EnsureStream(ctx, job, src, ExportShort(1280, 720, 1080, 1920), 30, nil)
	if err != nil {
		t.Fatal(err)
	}
	if exp.Width != 1280 || exp.Height != 720 {
		t.Fatalf("%+v", exp)
	}
	checkStream(t, exp, 120, 1)

	// Reuse, and what Sources reports.
	if again, err := m.EnsureStream(ctx, job, src, 540, 30, nil); err != nil || again != prev {
		t.Errorf("reuse: %+v %v", again, err)
	}
	st, err := m.sourceStates(ctx, []string{src}, 30)
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Info.Kind != "video" || st[0].Info.Width != 1280 || st[0].Preview == nil || *st[0].Preview != prev {
		t.Errorf("sourceStates: %+v", st[0])
	}
	for _, l := range rec.logs {
		if strings.Contains(l, "expected about") {
			t.Errorf("frame count mismatch: %s", l)
		}
	}
}

func TestIntegrationSourceRotatedPhoneVideoIsUpright(t *testing.T) {
	tools := realTools(t)
	m := realModule(t, tools)
	dir := t.TempDir()
	plain, rotated := filepath.Join(dir, "plain.mp4"), filepath.Join(dir, "rot.mp4")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", plain)
	ffmpegDo(t, tools["ffmpeg"], "-display_rotation:v:0", "90", "-i", plain, "-c", "copy", rotated)
	job, _ := realJob(t, tools, Options{})
	es, err := m.EnsureStream(context.Background(), job, rotated, 360, 30, nil)
	if err != nil {
		t.Fatal(err)
	}
	if es.Width != 360 || es.Height != 640 {
		t.Errorf("a clip rotated 90° must come out upright, got %dx%d", es.Width, es.Height)
	}
	checkStream(t, es, 60, 1)
}

func TestIntegrationShotsTwoScenes(t *testing.T) {
	tools := realTools(t)
	m := realModule(t, tools)
	src := filepath.Join(t.TempDir(), "two.mp4")
	ffmpegDo(t, tools["ffmpeg"],
		"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
		"-f", "lavfi", "-i", "smptebars=size=640x360:rate=30:duration=2",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p", "-c:v", "libx264", src)
	job, _ := realJob(t, tools, Options{})
	shots, err := m.EnsureShots(context.Background(), job, src, 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(shots) != 1 || shots[0] < 1900 || shots[0] > 2100 {
		t.Fatalf("shots = %v, want one cut near 2000 ms", shots)
	}
	if got := m.ShotsFor(src); len(got) != 1 || got[0] != shots[0] {
		t.Errorf("ShotsFor = %v", got)
	}
}

func TestIntegrationInterpQuadruplesFrames(t *testing.T) {
	tools := realTools(t)
	m := realModule(t, tools)
	src := filepath.Join(t.TempDir(), "clip.mp4")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", "-c:v", "libx264", src)
	job, _ := realJob(t, tools, Options{})
	prev, exp, err := m.EnsureInterp(context.Background(), job, src, 500, 1500, 30, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The range rounds out to 0..2 s: 60 source frames → about 240 interpolated.
	if exp.FPS != 120 || prev.FPS != 120 || exp.Width != 640 || exp.Height != 360 {
		t.Fatalf("%+v %+v", prev, exp)
	}
	checkStream(t, exp, 240, 8)
	checkStream(t, prev, 240, 8)
	if got := m.InterpFor(src, 500, 1500, 30, TierExport); got == nil || *got != exp {
		t.Errorf("InterpFor = %+v", got)
	}
	// A range that starts later is trimmed on the way in: 1..2 s is 30 source frames → about 120.
	_, later, err := m.EnsureInterp(context.Background(), job, src, 1200, 1900, 30, nil)
	if err != nil {
		t.Fatal(err)
	}
	checkStream(t, later, 120, 8)
}

func TestIntegrationImageFromRealFiles(t *testing.T) {
	tools := realTools(t)
	m := realModule(t, tools)
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.jpg")
	ffmpegDo(t, tools["ffmpeg"], "-f", "lavfi", "-i", "testsrc2=size=3000x2000", "-frames:v", "1", src)
	out, err := m.EnsureImage(context.Background(), nil, src, PreviewImageMax)
	if err != nil {
		t.Fatal(err)
	}
	if w, h := imageSize(t, out); w != 1920 || h != 1280 {
		t.Errorf("size %dx%d, want 1920x1280", w, h)
	}
}
