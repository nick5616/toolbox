package editstudio

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/modules/videoeditor"
)

// fakeFF stands in for FFmpeg and ffprobe: it records every command, writes a
// synthetic Annex-B stream into the output of a transcode, and prints the
// scene lines a shots run would.
type fakeFF struct {
	mu        sync.Mutex
	calls     [][]string
	frames    int
	delay     time.Duration
	failWith  error
	info      media.Info
	transfer  string
	filtersOK bool
	filterRun atomic.Int32
	scenes    []string
}

func installFakes(t *testing.T) *fakeFF {
	t.Helper()
	f := &fakeFF{
		frames: 60,
		info:   media.Info{DurationMs: 2000, Video: &media.VideoStream{Width: 1080, Height: 1920, FPS: 30}},
	}
	oldRun, oldProbe, oldTr, oldFil, oldFiles := runFFmpeg, probeMedia, probeTransfer, ffmpegFilters, probeFiles
	probeFiles = func(ctx context.Context, ffprobe string, paths []string) []videoeditor.ClipInfo {
		out := make([]videoeditor.ClipInfo, 0, len(paths))
		for _, p := range paths {
			switch {
			case kindByExt(p) == "image" || !fileExists(p):
				out = append(out, oldFiles(ctx, ffprobe, []string{p})...) // photos and missing files need no ffprobe
			default:
				v := f.info.Video
				out = append(out, videoeditor.ClipInfo{Path: p, Kind: "video", DurationMs: f.info.DurationMs, Width: v.Width, Height: v.Height, FPS: v.FPS})
			}
		}
		return out
	}
	runFFmpeg = f.run
	probeMedia = func(context.Context, string, string) (media.Info, error) { return f.info, nil }
	probeTransfer = func(context.Context, string, string) (string, error) { return f.transfer, nil }
	ffmpegFilters = func(context.Context, string) (bool, error) { f.filterRun.Add(1); return f.filtersOK, nil }
	t.Cleanup(func() {
		runFFmpeg, probeMedia, probeTransfer, ffmpegFilters, probeFiles = oldRun, oldProbe, oldTr, oldFil, oldFiles
	})
	return f
}

func (f *fakeFF) run(ctx context.Context, s proc.Spec) (proc.Result, error) {
	f.mu.Lock()
	f.calls = append(f.calls, slices.Clone(s.Args))
	f.mu.Unlock()
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return proc.Result{}, ctx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return proc.Result{}, err
	}
	if f.failWith != nil {
		return proc.Result{StderrTail: []string{"boom"}}, f.failWith
	}
	if slices.Contains(s.Args, "null") { // shots
		for _, l := range f.scenes {
			s.OnStdout(l)
		}
		return proc.Result{}, nil
	}
	out := s.Args[len(s.Args)-1]
	data, _, _ := synthStream(f.frames, 10, true)
	if err := os.WriteFile(out, data, 0o644); err != nil {
		return proc.Result{}, err
	}
	if s.OnStdout != nil {
		s.OnStdout("out_time_us=1000000")
		s.OnStdout("progress=continue")
	}
	return proc.Result{}, nil
}

func (f *fakeFF) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeFF) last() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

func argAfter(args []string, flag string) string {
	i := slices.Index(args, flag)
	if i < 0 || i+1 >= len(args) {
		return ""
	}
	return args[i+1]
}

func fakeTools() map[string]string {
	return map[string]string{"ffmpeg": "ffmpeg-fake", "ffprobe": "ffprobe-fake"}
}

// srcFile makes a source file of any content.
func srcFile(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte("not really a video"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestTierShortSides(t *testing.T) {
	tests := []struct {
		name         string
		w, h         int
		outW, outH   int
		wantPrev     int
		wantExport   int
		wantSizeW    int
		wantSizeH    int
		sizeForShort int
	}{
		{"portrait 4k to 1080x1920", 2160, 3840, 1080, 1920, 540, 1920, 540, 960, 540},
		{"landscape 1080p", 1920, 1080, 1080, 1920, 540, 1080, 960, 540, 540},
		{"small source", 480, 360, 1080, 1920, 360, 360, 480, 360, 360},
		{"square", 1000, 1000, 1080, 1080, 540, 1000, 540, 540, 540},
		{"odd result is made even", 1081, 1919, 1080, 1920, 540, 1081, 542, 960, 541},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := PreviewShort(tc.w, tc.h); got != tc.wantPrev {
				t.Errorf("PreviewShort = %d, want %d", got, tc.wantPrev)
			}
			if got := ExportShort(tc.w, tc.h, tc.outW, tc.outH); got != tc.wantExport {
				t.Errorf("ExportShort = %d, want %d", got, tc.wantExport)
			}
			w, h := streamSize(tc.w, tc.h, tc.sizeForShort)
			if w != tc.wantSizeW || h != tc.wantSizeH || w%2 != 0 || h%2 != 0 {
				t.Errorf("streamSize = %dx%d, want %dx%d", w, h, tc.wantSizeW, tc.wantSizeH)
			}
		})
	}
	// The short side never grows past the source's.
	if w, h := streamSize(640, 360, 1080); w != 640 || h != 360 {
		t.Errorf("no upscaling: %dx%d", w, h)
	}
}

func TestStreamArgs(t *testing.T) {
	args := streamArgs("in.mov", "out.h264.part", 540, 960, 30, 20, false)
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-hide_banner -nostdin -y", "-progress pipe:1", "-i in.mov", "-map 0:v:0 -an -sn -dn",
		"-vf scale=540:960:flags=bicubic,setsar=1,fps=30,format=yuv420p",
		"-fps_mode cfr -c:v libx264 -preset veryfast -crf 20",
		"-profile:v high -bf 0 -g 10 -keyint_min 10 -sc_threshold 0",
		"-x264-params aud=1:repeat-headers=1 -f h264 out.h264.part",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("args lack %q:\n%s", want, joined)
		}
	}
	if args[len(args)-1] != "out.h264.part" {
		t.Error("the output must be the last argument")
	}
	if strings.Contains(joined, "zscale") {
		t.Error("no tone mapping without HDR")
	}
	hdr := argAfter(streamArgs("in.mov", "o", 540, 960, 30, 16, true), "-vf")
	if !strings.HasPrefix(hdr, "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,scale=540:960") {
		t.Errorf("HDR chain: %s", hdr)
	}
	if crfFor(540) != 20 || crfFor(960) != 16 {
		t.Error("crf by tier")
	}
	if !isHDR("smpte2084") || !isHDR("arib-std-b67") || isHDR("bt709") || isHDR("") {
		t.Error("isHDR")
	}
}

func TestEnsureStreamMakesAndReuses(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	src := srcFile(t, "a.mov")
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
	var last float64
	es, err := m.EnsureStream(context.Background(), job, src, 540, 30, func(p float64) { last = p })
	if err != nil {
		t.Fatal(err)
	}
	if es.Width != 540 || es.Height != 960 || es.FPS != 30 || es.Frames != 60 {
		t.Fatalf("%+v", es)
	}
	if last != 1 {
		t.Errorf("progress ended at %v", last)
	}
	key, _ := keyOf(src)
	if want := filepath.Join(m.cfg.CacheDir, "src", key, "v540-30.h264"); es.Stream != want || es.Index != IndexPath(want) {
		t.Errorf("paths: %+v want %s", es, want)
	}
	if _, err := os.Stat(es.Stream + ".part"); err == nil {
		t.Error(".part must be renamed away")
	}
	idx, err := ReadIndex(es.Stream)
	if err != nil || idx.Frames != 60 || idx.Width != 540 {
		t.Fatalf("index: %+v %v", idx, err)
	}
	if got := m.StreamFor(src, 540, 30); got == nil || *got != es {
		t.Errorf("StreamFor = %+v", got)
	}
	if m.StreamFor(src, 270, 30) != nil || m.StreamFor(src, 540, 60) != nil {
		t.Error("other tiers and fps don't exist")
	}
	args := ff.last()
	if argAfter(args, "-crf") != "20" || ff.count() != 1 {
		t.Errorf("args: %v", args)
	}
	// A second call reuses the files.
	if _, err := m.EnsureStream(context.Background(), job, src, 540, 30, nil); err != nil || ff.count() != 1 {
		t.Fatalf("reuse: %v, calls %d", err, ff.count())
	}
	// The export tier is a different file with the better quality.
	ex, err := m.EnsureStream(context.Background(), job, src, 1080, 30, nil)
	if err != nil || ex.Width != 1080 || ex.Height != 1920 || argAfter(ff.last(), "-crf") != "16" {
		t.Fatalf("%+v %v %v", ex, err, ff.last())
	}
}

func keyOf(path string) (string, error) {
	m := &Module{}
	dir, err := m.srcDir(path)
	return filepath.Base(dir), err
}

func TestEnsureStreamCacheKeyFollowsFile(t *testing.T) {
	m := newTestModule(t)
	src := srcFile(t, "a.mov")
	d1, err := m.srcDir(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, []byte("a longer, changed file"), 0o644); err != nil {
		t.Fatal(err)
	}
	d2, _ := m.srcDir(src)
	if d1 == d2 {
		t.Error("a changed file must get a new cache folder")
	}
	if _, err := m.srcDir(filepath.Join(t.TempDir(), "nope.mov")); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("missing file: %v", err)
	}
}

func TestEnsureStreamOneTranscodeForConcurrentCallers(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	ff.delay = 80 * time.Millisecond
	src := srcFile(t, "a.mov")
	var wg sync.WaitGroup
	results := make([]EditStream, 4)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var rec recorder
			job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
			es, err := m.EnsureStream(context.Background(), job, src, 540, 30, nil)
			if err != nil {
				t.Error(err)
			}
			results[i] = es
		}()
	}
	wg.Wait()
	if ff.count() != 1 {
		t.Fatalf("ffmpeg ran %d times, want 1", ff.count())
	}
	for _, r := range results {
		if r != results[0] || r.Frames != 60 {
			t.Fatalf("results differ: %+v", results)
		}
	}
}

func TestEnsureStreamCancelAndFailureLeaveNothing(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	src := srcFile(t, "a.mov")
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())

	ff.failWith = errors.New("exit status 1")
	_, err := m.EnsureStream(context.Background(), job, src, 540, 30, nil)
	if !core.IsCode(err, core.CodeToolFailed) {
		t.Fatalf("failure: %v", err)
	}
	ff.failWith = nil

	ff.delay = time.Second
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	if _, err := m.EnsureStream(ctx, job, src, 540, 30, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	dir, _ := m.srcDir(src)
	ents, _ := os.ReadDir(dir)
	if len(ents) != 0 {
		t.Errorf("leftovers: %v", ents)
	}
	if m.StreamFor(src, 540, 30) != nil {
		t.Error("nothing should exist")
	}
}

func TestEnsureStreamHDR(t *testing.T) {
	tests := []struct {
		name      string
		transfer  string
		filters   bool
		wantTone  bool
		wantWarn  bool
		ffmpegBin string
	}{
		{"SDR", "bt709", true, false, false, "ffmpeg-sdr"},
		{"PQ with filters", "smpte2084", true, true, false, "ffmpeg-pq-yes"},
		{"HLG with filters", "arib-std-b67", true, true, false, "ffmpeg-hlg-yes"},
		{"HDR without filters", "smpte2084", false, false, true, "ffmpeg-pq-no"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newTestModule(t)
			ff := installFakes(t)
			ff.transfer, ff.filtersOK = tc.transfer, tc.filters
			src := srcFile(t, "a.mov")
			var rec recorder
			job := newJob(t, t.TempDir(), Options{}, &rec, map[string]string{"ffmpeg": tc.ffmpegBin, "ffprobe": "ffprobe-fake"})
			if _, err := m.EnsureStream(context.Background(), job, src, 540, 30, nil); err != nil {
				t.Fatal(err)
			}
			if got := strings.Contains(argAfter(ff.last(), "-vf"), "tonemap=hable"); got != tc.wantTone {
				t.Errorf("tone mapping = %v, want %v", got, tc.wantTone)
			}
			warned := false
			for _, l := range rec.logs {
				warned = warned || strings.Contains(l, "HDR footage may look washed out")
			}
			if warned != tc.wantWarn {
				t.Errorf("warning = %v, want %v (%v)", warned, tc.wantWarn, rec.logs)
			}
		})
	}
	t.Run("the filter check is cached per FFmpeg path", func(t *testing.T) {
		m := newTestModule(t)
		ff := installFakes(t)
		ff.transfer, ff.filtersOK = "smpte2084", true
		var rec recorder
		job := newJob(t, t.TempDir(), Options{}, &rec, map[string]string{"ffmpeg": "ffmpeg-cached", "ffprobe": "ffprobe-fake"})
		for _, name := range []string{"a.mov", "b.mov"} {
			if _, err := m.EnsureStream(context.Background(), job, srcFile(t, name), 540, 30, nil); err != nil {
				t.Fatal(err)
			}
		}
		if n := ff.filterRun.Load(); n != 1 {
			t.Errorf("-filters ran %d times", n)
		}
	})
}

func TestEnsureStreamFrameMismatchIsLoggedNotFatal(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	ff.frames = 30 // the probe says 2 s = 60 frames
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
	es, err := m.EnsureStream(context.Background(), job, srcFile(t, "a.mov"), 540, 30, nil)
	if err != nil || es.Frames != 30 {
		t.Fatalf("%+v %v", es, err)
	}
	if !strings.Contains(strings.Join(rec.logs, "\n"), "expected about 60") {
		t.Errorf("logs: %v", rec.logs)
	}
}

func TestRunPrepare(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	ff.scenes = []string{"frame:10   pts:300   pts_time:0.3", "lavfi.scene_score=0.5", "frame:40 pts:1200 pts_time:1.2"}
	// ProbeFiles reads photos itself (imaging.Size); a real PNG gives it a size.
	photo := writePNG(t, filepath.Join(t.TempDir(), "p.png"), 64, 32, true)
	video := srcFile(t, "v.mov")
	missing := filepath.Join(t.TempDir(), "gone.mov")
	var rec recorder
	o := Options{Action: ActionPrepare, Prepare: &PrepareRequest{Paths: []string{video, photo, missing}, FPS: 30}}
	job := newJob(t, t.TempDir(), o, &rec, fakeTools())
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if rec.title != "Preparing 3 clips" {
		t.Errorf("title = %q", rec.title)
	}
	var res Result
	if err := json.Unmarshal(rec.result, &res); err != nil {
		t.Fatal(err)
	}
	if res.Action != ActionPrepare || len(res.Sources) != 3 {
		t.Fatalf("%+v", res)
	}
	v, p, g := res.Sources[0], res.Sources[1], res.Sources[2]
	if v.Error != "" || v.Preview == nil || v.Preview.Frames != 60 || !slices.Equal(v.Shots, []int64{300, 1200}) {
		t.Errorf("video: %+v", v)
	}
	if p.Error != "" || p.Image == "" || p.Preview != nil {
		t.Errorf("photo: %+v", p)
	}
	if g.Error == "" || g.Preview != nil {
		t.Errorf("missing file must carry an error and not stop the job: %+v", g)
	}
	// Progress is monotonic and ends at 1.
	prev := -1.0
	for _, p := range rec.progress {
		if p < prev-1e-9 {
			t.Fatalf("progress went back: %v", rec.progress)
		}
		prev = p
	}
	if prev != 1 {
		t.Errorf("progress ended at %v", prev)
	}
	// Sources now reports it all (no ffprobe resolver: Info stays empty).
	st, err := m.sourceStates(context.Background(), []string{video, photo}, 30)
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Preview == nil || !slices.Equal(st[0].Shots, []int64{300, 1200}) || st[1].Image == "" {
		t.Errorf("sourceStates: %+v", st)
	}
	if st[0].Info.Kind != "" {
		t.Error("Info stays empty without ffprobe")
	}
	// Nothing is made for files that were never prepared.
	other := srcFile(t, "other.mov")
	st, _ = m.sourceStates(context.Background(), []string{other}, 30)
	if st[0].Preview != nil || st[0].Shots != nil || ff.count() != 2 {
		t.Errorf("sourceStates must not do work: %+v, %d calls", st[0], ff.count())
	}
}

func TestRunPrepareCancel(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	ff.delay = time.Second
	o := Options{Action: ActionPrepare, Prepare: &PrepareRequest{Paths: []string{srcFile(t, "a.mov")}, FPS: 30}}
	var rec recorder
	job := newJob(t, t.TempDir(), o, &rec, fakeTools())
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	if err := m.Run(ctx, job); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if rec.title != "Preparing 1 clip" {
		t.Errorf("title = %q", rec.title)
	}
}

func TestFitSources(t *testing.T) {
	long := strings.Repeat("x", 200)
	var states []SourceState
	for i := 0; i < 300; i++ {
		states = append(states, SourceState{Path: long, Image: long, Shots: make([]int64, 50), Preview: &EditStream{Stream: long, Index: long}})
	}
	out := fitSources(states)
	b, _ := json.Marshal(out)
	if len(b) > core.MaxResultBytes {
		t.Errorf("still %d bytes", len(b))
	}
	if len(out) != 0 {
		t.Error("with no failures nothing needs to stay")
	}
	states[7].Error = "Couldn't read this file"
	out = fitSources(states)
	if len(out) != 1 || out[0].Path != long || out[0].Error == "" {
		t.Errorf("failures must stay: %+v", out)
	}
}
