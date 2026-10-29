package audiocleanup

import (
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPreFiltersAndInline(t *testing.T) {
	tests := []struct {
		name string
		o    Options
		hum  int
		want string
	}{
		{"nothing", Options{Denoise: DenoiseOff}, 0, ""},
		{"highpass", Options{HighPass: true}, 0, "highpass=f=80"},
		{"hum50", Options{}, 50, "bandreject=f=50:width_type=q:w=30,bandreject=f=100:width_type=q:w=30,bandreject=f=150:width_type=q:w=30,bandreject=f=200:width_type=q:w=30"},
		{"order", Options{HighPass: true, Denoise: DenoiseLight}, 60,
			"highpass=f=80,bandreject=f=60:width_type=q:w=30,bandreject=f=120:width_type=q:w=30,bandreject=f=180:width_type=q:w=30,bandreject=f=240:width_type=q:w=30,afftdn=nr=12:nf=-50:tn=1"},
		{"strong", Options{HighPass: true, Denoise: DenoiseStrong}, 0, "highpass=f=80,arnndn=m=std.rnnn"},
		{"voice runs elsewhere", Options{HighPass: true, Denoise: DenoiseVoice}, 0, "highpass=f=80"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := join(inlineFilters(tc.o, tc.hum)); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
	if got := join(preFilters(Options{HighPass: true, Denoise: DenoiseVoice}, 50)); !strings.HasPrefix(got, "highpass=f=80,bandreject=f=50") || strings.Contains(got, "afftdn") {
		t.Fatalf("voice pre-filters %q", got)
	}
}

func TestLoudnessFilters(t *testing.T) {
	for _, tc := range []struct {
		l    Loudness
		want string
	}{
		{LoudnessPodcast, "loudnorm=I=-16:TP=-1.5:LRA=11"},
		{LoudnessStreaming, "loudnorm=I=-14:TP=-1:LRA=11"},
		{LoudnessBroadcast, "loudnorm=I=-23:TP=-1:LRA=11"},
	} {
		tg, ok := targetFor(tc.l)
		if !ok || loudnormBase(tg) != tc.want {
			t.Fatalf("%s: %q", tc.l, loudnormBase(tg))
		}
	}
	if _, ok := targetFor(LoudnessOff); ok {
		t.Fatal("off has no target")
	}
	tg, _ := targetFor(LoudnessPodcast)
	if got := loudnormPass1(tg); got != "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" {
		t.Fatal(got)
	}
	st := loudnormStats{InputI: "-27.61", InputTP: "-4.47", InputLRA: "18.10", InputThresh: "-38.2", TargetOffset: "0.43"}
	want := "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-27.61:measured_TP=-4.47:measured_LRA=18.10:measured_thresh=-38.2:offset=0.43:linear=true:print_format=json,aresample=48000"
	if got := loudnormPass2(tg, st, 48000); got != want {
		t.Fatalf("got %q", got)
	}
	if outRate(44100) != 44100 || outRate(48000) != 48000 || outRate(22050) != 48000 {
		t.Fatal("outRate")
	}
}

const loudnormStderr = `[Parsed_loudnorm_0 @ 000001]
{
	"input_i" : "-27.61",
	"input_tp" : "-4.47",
	"input_lra" : "18.06",
	"input_thresh" : "-39.20",
	"output_i" : "-16.58",
	"output_tp" : "-1.50",
	"output_lra" : "14.40",
	"output_thresh" : "-27.71",
	"normalization_type" : "dynamic",
	"target_offset" : "0.58"
}`

func TestParseLoudnorm(t *testing.T) {
	st, err := parseLoudnorm(strings.Split(loudnormStderr, "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if st.InputI != "-27.61" || st.InputThresh != "-39.20" || st.TargetOffset != "0.58" || st.OutputI != "-16.58" {
		t.Fatalf("%+v", st)
	}
	if _, err := parseLoudnorm([]string{"nothing here"}); err == nil {
		t.Fatal("expected error")
	}
	silent := strings.ReplaceAll(loudnormStderr, `"-27.61"`, `"-inf"`)
	if _, err := parseLoudnorm(strings.Split(silent, "\n")); err == nil {
		t.Fatal("silence should fail")
	}
}

func TestParseEBU128(t *testing.T) {
	lines := []string{
		"[Parsed_ebur128_0 @ 0x1] Summary:",
		"",
		"  Integrated loudness:",
		"    I:         -23.4 LUFS",
		"    Threshold: -33.5 LUFS",
		"",
		"  Loudness range:",
		"    LRA:         5.0 LU",
	}
	if v, ok := parseEBU128(lines); !ok || v != -23.4 {
		t.Fatalf("%v %v", v, ok)
	}
	if _, ok := parseEBU128([]string{"    I:         -inf LUFS"}); ok {
		t.Fatal("-inf must not parse")
	}
}

func TestEncodings(t *testing.T) {
	tests := []struct {
		ext         string
		f           Format
		ext2, codec string
	}{
		{".wav", FormatSame, ".wav", "pcm_s24le"},
		{".mp3", FormatSame, ".mp3", "libmp3lame"},
		{".flac", FormatSame, ".flac", "flac"},
		{".wma", FormatSame, ".m4a", "aac"},
		{".opus", FormatSame, ".opus", "libopus"},
		{".mp3", FormatWAV, ".wav", "pcm_s24le"},
		{".wav", FormatM4A, ".m4a", "aac"},
		{".wav", FormatMP3, ".mp3", "libmp3lame"},
		{".m4a", FormatFLAC, ".flac", "flac"},
	}
	for _, tc := range tests {
		e := audioEncoding(tc.ext, tc.f)
		if e.Ext != tc.ext2 || e.Args[1] != tc.codec {
			t.Errorf("%s/%s: %+v", tc.ext, tc.f, e)
		}
	}
	for ext, codec := range map[string]string{".mp4": "aac", ".MOV": "aac", ".webm": "libopus", ".mkv": "libopus", ".avi": "aac"} {
		e := videoEncoding(ext)
		args := strings.Join(e.Args, " ")
		if !strings.HasPrefix(args, "-c:v copy -c:a "+codec) || e.Ext != strings.ToLower(ext) {
			t.Errorf("%s: %+v", ext, e)
		}
	}
}

func TestPreviewSpan(t *testing.T) {
	tests := []struct {
		start, dur     int64
		wantS, wantLen float64
	}{
		{0, 60000, 0, 10},
		{5000, 60000, 5, 10},
		{58000, 60000, 50, 10}, // pulled back so 10 s fit
		{0, 4000, 0, 4},
		{-5, 60000, 0, 10},
		{3000, 0, 3, 10}, // unknown duration
	}
	for _, tc := range tests {
		s, l := previewSpan(tc.start, tc.dur)
		if s != tc.wantS || l != tc.wantLen {
			t.Errorf("%d/%d: %v %v", tc.start, tc.dur, s, l)
		}
	}
	a, b := previewNames("/c", "job1")
	if filepath.Base(a) != "job1-a.wav" || filepath.Base(b) != "job1-b.wav" {
		t.Fatal(a, b)
	}
}

func tone(n int, hz, amp, noise float64, seed int64) []int16 {
	rng := rand.New(rand.NewSource(seed))
	out := make([]int16, n)
	for i := range out {
		v := amp*math.Sin(2*math.Pi*hz*float64(i)/humSampleRate) + noise*(rng.Float64()*2-1)
		out[i] = int16(max(-1, min(1, v)) * 32767)
	}
	return out
}

func TestDetectHum(t *testing.T) {
	n := humDetectSeconds * humSampleRate
	tests := []struct {
		name string
		pcm  []int16
		want int
	}{
		{"50 Hz hum in noise", tone(n, 50, 0.02, 0.1, 1), 50},
		{"60 Hz hum in noise", tone(n, 60, 0.02, 0.1, 2), 60},
		{"noise only", tone(n, 0, 0, 0.1, 3), 0},
		{"speech-like tone at 220 Hz", tone(n, 220, 0.3, 0.05, 4), 0},
		{"too short", tone(100, 50, 0.5, 0, 5), 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := detectHum(tc.pcm); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestDecodeS16LE(t *testing.T) {
	got := decodeS16LE([]byte{0x01, 0x00, 0xff, 0xff, 0x00, 0x80, 0x7f})
	if len(got) != 3 || got[0] != 1 || got[1] != -1 || got[2] != -32768 {
		t.Fatalf("%v", got)
	}
}

func TestPrunePreviews(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-48 * time.Hour)
	mk := func(name string, mod time.Time) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mod, mod); err != nil {
			t.Fatal(err)
		}
		return p
	}
	oldA, oldB := mk("j1-a.wav", old), mk("j1-b.wav", old)
	newA := mk("j2-a.wav", time.Now())
	other := mk("keep.txt", old)
	m := &Module{previewDir: dir}
	m.PrunePreviews()
	for _, p := range []string{oldA, oldB} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s should be gone", p)
		}
	}
	for _, p := range []string{newA, other} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s should stay: %v", p, err)
		}
	}
	m.prunePreviewsAll()
	if _, err := os.Stat(newA); !os.IsNotExist(err) {
		t.Fatal("prunePreviewsAll left a preview")
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("prunePreviewsAll removed a non-preview")
	}
	(&Module{}).prunePreviewsAll() // no dir: no panic
}

func TestEmbeddedRNNoise(t *testing.T) {
	if len(rnnoiseModel) != 302903 {
		t.Fatalf("std.rnnn is %d bytes", len(rnnoiseModel))
	}
}
