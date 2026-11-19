package editstudio

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/modules/videoeditor"
)

// pcm builds s16le samples.
func pcm(samples ...int16) []byte {
	b := make([]byte, 2*len(samples))
	for i, s := range samples {
		binary.LittleEndian.PutUint16(b[2*i:], uint16(s))
	}
	return b
}

func TestWritePeaks(t *testing.T) {
	win := make([]int16, peaksWindow)
	win[10], win[20] = 16384, -16384
	full := make([]int16, peaksWindow)
	full[0], full[1] = 32767, -32768
	tail := make([]int16, 100)
	for i := range tail {
		tail[i] = 256
	}
	in := pcm(slices.Concat(win, full, tail)...)

	var out bytes.Buffer
	n, err := writePeaks(bytes.NewReader(in), &out)
	if err != nil || n != 3 {
		t.Fatalf("n = %d, err = %v", n, err)
	}
	want := append([]byte(peaksHeader), byte(0xC0), 64, byte(0x81), 127, 1, 1) // −64,64  −127,127  1,1
	if !bytes.Equal(out.Bytes(), want) {
		t.Fatalf("peaks = % x\nwant    % x", out.Bytes(), want)
	}
	if !strings.HasPrefix(out.String(), `{"v":1,"rate":100,"channels":1}`+"\n") {
		t.Error("header")
	}
}

func TestWritePeaksEdgeCases(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		var out bytes.Buffer
		n, err := writePeaks(bytes.NewReader(nil), &out)
		if err != nil || n != 0 || out.String() != peaksHeader {
			t.Fatalf("n %d err %v out %q", n, err, out.String())
		}
	})
	t.Run("a stray byte is ignored", func(t *testing.T) {
		var out bytes.Buffer
		in := append(pcm(1<<8, 2<<8), 0x7f)
		n, err := writePeaks(bytes.NewReader(in), &out)
		if err != nil || n != 1 {
			t.Fatal(n, err)
		}
		if got := out.Bytes()[len(peaksHeader):]; !bytes.Equal(got, []byte{1, 2}) {
			t.Errorf("pair = %v", got)
		}
	})
	t.Run("silence", func(t *testing.T) {
		var out bytes.Buffer
		n, _ := writePeaks(bytes.NewReader(pcm(make([]int16, 2*peaksWindow)...)), &out)
		if n != 2 || !bytes.Equal(out.Bytes()[len(peaksHeader):], []byte{0, 0, 0, 0}) {
			t.Errorf("n %d % x", n, out.Bytes())
		}
	})
	t.Run("one window per 10 ms of audio", func(t *testing.T) {
		var out bytes.Buffer
		n, _ := writePeaks(bytes.NewReader(pcm(make([]int16, mixRate)...)), &out) // 1 s
		if n != 100 {
			t.Errorf("windows = %d", n)
		}
	})
}

func TestPeakByte(t *testing.T) {
	for _, tc := range []struct {
		in   int16
		want int8
	}{{0, 0}, {255, 0}, {256, 1}, {32767, 127}, {-1, -1}, {-256, -1}, {-32768, -127}, {-16384, -64}} {
		if got := peakByte(tc.in); got != tc.want {
			t.Errorf("peakByte(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestPreviewAudioArgs(t *testing.T) {
	a := strings.Join(previewAudioArgs("in.mov", "out.part"), " ")
	for _, want := range []string{"-map 0:a:0", "-vn", "-c:a aac -b:a 96k -ar 48000 -ac 2", "-f mp4 out.part"} {
		if !strings.Contains(a, want) {
			t.Errorf("args lack %q: %s", want, a)
		}
	}
	p := strings.Join(peaksPCMArgs("in.mov", "raw.part"), " ")
	for _, want := range []string{"-ac 1 -ar 48000 -f s16le raw.part"} {
		if !strings.Contains(p, want) {
			t.Errorf("pcm args lack %q: %s", want, p)
		}
	}
}

func TestEnsureAudio(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	src := srcFile(t, "a.mov")
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())

	if a, p := m.AudioFor(src); a != "" || p != "" {
		t.Fatalf("nothing should exist yet: %q %q", a, p)
	}
	audio, peaks, err := m.EnsureAudio(context.Background(), job, src, 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(audio) != "audio.m4a" || filepath.Base(peaks) != "peaks.bin" || !nonEmptyFile(audio) || !nonEmptyFile(peaks) {
		t.Fatalf("audio %q peaks %q", audio, peaks)
	}
	if ff.count() != 2 {
		t.Fatalf("ffmpeg ran %d times", ff.count())
	}
	b, _ := os.ReadFile(peaks)
	if !strings.HasPrefix(string(b), peaksHeader) {
		t.Errorf("peaks header: %q", b[:min(len(b), 40)])
	}
	dir := filepath.Dir(audio)
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.Contains(e.Name(), ".part") {
			t.Errorf("leftover %s", e.Name())
		}
	}
	// Made once: the second call does no work.
	if _, _, err := m.EnsureAudio(context.Background(), job, src, 2, nil); err != nil || ff.count() != 2 {
		t.Fatalf("second call: %v, ffmpeg runs %d", err, ff.count())
	}
	if a, p := m.AudioFor(src); a != audio || p != peaks {
		t.Errorf("AudioFor = %q %q", a, p)
	}
}

func TestEnsureAudioFailureLeavesNothing(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	ff.failWith = core.Errorf(core.CodeToolFailed, "boom")
	src := srcFile(t, "a.mov")
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
	if _, _, err := m.EnsureAudio(context.Background(), job, src, 2, nil); err == nil {
		t.Fatal("expected an error")
	}
	if a, p := m.AudioFor(src); a != "" || p != "" {
		t.Errorf("files after a failure: %q %q", a, p)
	}
	dir, _ := m.srcDir(src)
	ents, _ := os.ReadDir(dir)
	if len(ents) != 0 {
		t.Errorf("leftovers: %v", ents)
	}
}

func TestEnsureAudioCancel(t *testing.T) {
	m := newTestModule(t)
	installFakes(t)
	src := srcFile(t, "a.mov")
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := m.EnsureAudio(ctx, job, src, 2, nil); err == nil || ctx.Err() == nil {
		t.Fatalf("err = %v", err)
	}
}

// prepare writes audio.m4a and peaks.bin for videos with sound, and only those two files for audio files.
func TestRunPrepareAudio(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	prev := probeFiles
	probeFiles = func(ctx context.Context, ffprobe string, paths []string) []videoeditor.ClipInfo {
		out := prev(ctx, ffprobe, paths)
		for i := range out {
			switch {
			case strings.HasSuffix(paths[i], ".wav"):
				out[i] = videoeditor.ClipInfo{Path: paths[i], Kind: "audio", DurationMs: 2000, HasAudio: true}
			case out[i].Kind == "video":
				out[i].HasAudio = !strings.Contains(paths[i], "silent")
			}
		}
		return out
	}
	video, silent, wav := srcFile(t, "v.mov"), srcFile(t, "silent.mov"), srcFile(t, "song.wav")
	var rec recorder
	o := Options{Action: ActionPrepare, Prepare: &PrepareRequest{Paths: []string{video, silent, wav}, FPS: 25}}
	job := newJob(t, t.TempDir(), o, &rec, fakeTools())
	if err := m.runPrepare(context.Background(), job, *o.Prepare); err != nil {
		t.Fatal(err)
	}
	var res Result
	if err := json.Unmarshal(rec.result, &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Sources) != 3 {
		t.Fatalf("sources = %+v", res.Sources)
	}
	v, s, w := res.Sources[0], res.Sources[1], res.Sources[2]
	if v.Preview == nil || v.Audio == "" || v.Peaks == "" || v.Error != "" {
		t.Errorf("video: %+v", v)
	}
	if s.Preview == nil || s.Audio != "" || s.Peaks != "" {
		t.Errorf("silent video should get no audio files: %+v", s)
	}
	if w.Preview != nil || w.Audio == "" || w.Peaks == "" || w.Error != "" {
		t.Errorf("audio file: %+v", w)
	}
	// The audio file made no stream: its two FFmpeg runs are the audio and the peaks.
	for _, call := range ff.calls {
		if slices.Contains(call, wav) && slices.Contains(call, "h264") {
			t.Errorf("an audio file got a video stream: %v", call)
		}
	}
	// Sources reports them without work.
	before := ff.count()
	st, err := m.sourceStates(context.Background(), []string{video, wav}, 25)
	if err != nil {
		t.Fatal(err)
	}
	if st[0].Audio == "" || st[0].Peaks == "" || st[1].Audio == "" || st[1].Peaks == "" || ff.count() != before {
		t.Errorf("sourceStates: %+v", st)
	}
	if kindByExt("/x/y.flac") != "audio" {
		t.Error("kindByExt(.flac)")
	}
}
