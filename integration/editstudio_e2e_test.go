//go:build integration

package integration

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"toolbox/modules/editstudio"
)

// Phase 9 end to end (SPEC.md §17.4). A render needs the running app, so the
// test has three steps:
//
//  1. TOOLBOX_EDIT_E2E_DIR=<dir> go test -tags integration -run TestEditE2EPrepare -v ./integration/
//     writes a click track, three barcode clips, a sideways photo and projects.json.
//  2. Run the app with TOOLBOX_VIZLAB=1 TOOLBOX_VIZLAB_EDIT=e2e TOOLBOX_EDIT_E2E_DIR=<dir>
//     TOOLBOX_VIEW=vizlab (sandbox env vars): Edit Lab analyses, prepares and
//     renders the projects and writes e2e.json into <support>/tmp/vizlab/.
//  3. TOOLBOX_EDIT_E2E_DIR=<dir> TOOLBOX_EDIT_E2E_RESULT=<path to e2e.json>
//     go test -tags integration -run TestEditE2EVerify -v ./integration/
//
// Every clip carries its identity as a 12-bit barcode (1000·clip + source
// frame) in a row of 12 blocks across the middle of the frame, so the
// verifier can tell which clip and which source frame each output frame shows.

const (
	e2eFPS       = 30
	e2eSongMs    = 32_000
	e2eBeatMs    = 500
	e2eSegMs     = 2000
	e2eClipMs    = 8000
	e2eClipW     = 1280
	e2eClipH     = 720
	e2eBits      = 12
	e2eBlockW    = 80
	e2eBarTop    = 320
	e2eBarBottom = 400
	e2eOutW      = 1080
	e2eOutH      = 1920
)

// e2eSilentBeat is the beat with no click (bar 8, beat 3).
const e2eSilentBeat = 15_000

func e2eDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("TOOLBOX_EDIT_E2E_DIR")
	if dir == "" {
		t.Skip("set TOOLBOX_EDIT_E2E_DIR")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	abs, _ := filepath.Abs(dir)
	return abs
}

// writeClickTrack writes a 48 kHz mono WAV: a click + low thump on every beat
// (accented downbeats), no click at e2eSilentBeat, and everything louder from
// 16 s (bar 9) with a 55 Hz bed, so the analysis finds a drop there.
func writeClickTrack(t *testing.T, path string) {
	t.Helper()
	const sr = 48000
	n := sr * e2eSongMs / 1000
	pcm := make([]float64, n)
	for beat := 0; beat*e2eBeatMs < e2eSongMs; beat++ {
		ms := beat * e2eBeatMs
		if ms == e2eSilentBeat {
			continue
		}
		amp := 0.45
		if beat%4 == 0 {
			amp = 0.8
		}
		if ms >= 16_000 {
			amp *= 1.6
		}
		start := ms * sr / 1000
		for i := 0; i < sr/20 && start+i < n; i++ { // 50 ms
			tt := float64(i) / sr
			click := math.Sin(2*math.Pi*1000*tt) * math.Exp(-tt/0.012)
			thump := math.Sin(2*math.Pi*60*tt) * math.Exp(-tt/0.03)
			pcm[start+i] += amp * (0.5*click + 0.8*thump)
		}
	}
	for i := 16_000 * sr / 1000; i < n; i++ {
		pcm[i] += 0.25 * math.Sin(2*math.Pi*55*float64(i)/sr)
	}
	var buf bytes.Buffer
	data := make([]byte, 2*n)
	for i, v := range pcm {
		v = math.Max(-1, math.Min(1, v))
		binary.LittleEndian.PutUint16(data[2*i:], uint16(int16(v*32000)))
	}
	buf.WriteString("RIFF")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(36+len(data)))
	buf.WriteString("WAVEfmt ")
	_ = binary.Write(&buf, binary.LittleEndian, []any{uint32(16), uint16(1), uint16(1), uint32(sr), uint32(sr * 2), uint16(2), uint16(16)})
	buf.WriteString("data")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(len(data)))
	buf.Write(data)
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeBarcodeClip writes an 8 s 1280×720 30 fps clip whose frame n shows the
// number 1000·k + n as e2eBits black/white blocks (LSB first) on a grey frame.
func writeBarcodeClip(t *testing.T, ffmpeg, path string, k int) {
	t.Helper()
	expr := fmt.Sprintf("if(between(Y\\,%d\\,%d)*lt(X\\,%d)\\,255*mod(floor((%d+N)/pow(2\\,floor(X/%d)))\\,2)\\,128)",
		e2eBarTop, e2eBarBottom, e2eBits*e2eBlockW, 1000*k, e2eBlockW)
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=gray:s=%dx%d:r=%d:d=%d", e2eClipW, e2eClipH, e2eFPS, e2eClipMs/1000),
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%d:sample_rate=48000:duration=%d", 300+100*k, e2eClipMs/1000),
		"-vf", "format=yuv444p,geq=lum='"+expr+"':cb=128:cr=128,format=yuv420p",
		"-c:v", "libx264", "-crf", "8", "-preset", "veryfast", "-c:a", "aac", "-shortest", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("barcode clip %d: %v\n%s", k, err, out)
	}
}

// e2eSegment is one 2 s slot of the cuts project.
type e2eSegment struct {
	startMs, endMs, inMs int64
	clip                 int // 0..2 video clips, -1 the photo
}

func e2eSegments() []e2eSegment {
	var out []e2eSegment
	for i := 0; i*e2eSegMs < e2eSongMs; i++ {
		s := e2eSegment{startMs: int64(i * e2eSegMs), endMs: int64((i + 1) * e2eSegMs), clip: i % 3, inMs: int64((i * 700) % 5000)}
		if i%4 == 3 {
			s.clip, s.inMs = -1, 0
		}
		out = append(out, s)
	}
	return out
}

func e2eClip(id, kind, path string, start, end, in int64) editstudio.Clip {
	return editstudio.Clip{ID: id, Kind: kind, Path: path, StartMs: start, EndMs: end, InMs: in, Fit: "fit", FitColor: "#000000", Blend: "normal", FxTarget: "clip", Volume: 0}
}

func TestEditE2EPrepare(t *testing.T) {
	dir := e2eDir(t)
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	song := filepath.Join(dir, "click.wav")
	writeClickTrack(t, song)
	clips := make([]string, 3)
	for k := range clips {
		clips[k] = filepath.Join(dir, fmt.Sprintf("clip%d.mp4", k))
		writeBarcodeClip(t, ffmpeg, clips[k], k)
	}
	photo := filepath.Join(dir, "photo.jpg")
	writeOrientedJPEG(t, photo, 400, 300, 6)

	cuts := editstudio.NewProject("9:16", e2eFPS, 7)
	cuts.Song = &editstudio.Song{Path: song, StartMs: 0, EndMs: e2eSongMs}
	cuts.Sources = []editstudio.Source{{Path: clips[0], Tags: []string{}}, {Path: clips[1], Tags: []string{}}, {Path: clips[2], Tags: []string{}}, {Path: photo, Tags: []string{}}}
	var cl []editstudio.Clip
	for i, s := range e2eSegments() {
		id := fmt.Sprintf("s%d", i)
		if s.clip < 0 {
			cl = append(cl, e2eClip(id, "image", photo, s.startMs, s.endMs, 0))
		} else {
			cl = append(cl, e2eClip(id, "video", clips[s.clip], s.startMs, s.endMs, s.inMs))
		}
	}
	cuts.Tracks[0].Clips = cl

	flash := editstudio.NewProject("9:16", e2eFPS, 7)
	flash.Song = &editstudio.Song{Path: song, StartMs: 0, EndMs: e2eSongMs}
	flash.Tracks[0].Clips = []editstudio.Clip{{
		ID: "black", Kind: "color", Color: "#000000", StartMs: 0, EndMs: e2eSongMs, Fit: "fill", Blend: "normal", FxTarget: "clip",
		Effects: `[{"id":"f","type":"flash","enabled":true,"params":{"amount":{"base":0,"mods":[{"signal":"marker.beat","amount":1,"shape":"gate","attackMs":1,"releaseMs":1}]}}}]`,
	}}

	type entry struct {
		Name    string                 `json:"name"`
		Doc     editstudio.EditProject `json:"doc"`
		Renders int                    `json:"renders"`
	}
	raw, _ := json.MarshalIndent(map[string]any{"projects": []entry{{"E2E cuts", cuts, 1}, {"E2E flash", flash, 2}}}, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "projects.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s", dir)
}

type e2eResult struct {
	Projects []struct {
		Name     string   `json:"name"`
		ID       string   `json:"id"`
		Outputs  []string `json:"outputs"`
		Encoders []string `json:"encoders"`
		Seconds  []float64
		Error    string `json:"error"`
	} `json:"projects"`
}

// frameGray decodes output frame k (0-based) as 8-bit grey.
func frameGray(t *testing.T, ffmpeg, video string, k int) []byte {
	t.Helper()
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-i", video,
		"-vf", fmt.Sprintf("select=eq(n\\,%d),format=gray", k), "-frames:v", "1", "-f", "rawvideo", "-")
	out, err := cmd.Output()
	if err != nil || len(out) != e2eOutW*e2eOutH {
		t.Fatalf("frame %d of %s: %v (%d bytes)", k, filepath.Base(video), err, len(out))
	}
	return out
}

// frameRGB decodes output frame k as RGB24.
func frameRGB(t *testing.T, ffmpeg, video string, k int) []byte {
	t.Helper()
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-i", video,
		"-vf", fmt.Sprintf("select=eq(n\\,%d),format=rgb24", k), "-frames:v", "1", "-f", "rawvideo", "-")
	out, err := cmd.Output()
	if err != nil || len(out) != 3*e2eOutW*e2eOutH {
		t.Fatalf("frame %d of %s: %v", k, filepath.Base(video), err)
	}
	return out
}

// readBarcode reads the number a "fit" barcode clip shows in a 1080×1920 frame.
func readBarcode(g []byte) int {
	scale := float64(e2eOutW) / e2eClipW
	top := (float64(e2eOutH) - e2eClipH*scale) / 2
	y := int(top + float64(e2eBarTop+e2eBarBottom)/2*scale)
	v := 0
	for b := 0; b < e2eBits; b++ {
		x := int((float64(b*e2eBlockW) + e2eBlockW/2) * scale)
		if g[y*e2eOutW+x] > 192 {
			v |= 1 << b
		}
	}
	return v
}

func probeDurationMs(t *testing.T, video string) (int64, int) {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
		"-show_entries", "stream=nb_read_frames:format=duration", "-of", "default=nw=1:nk=1", video).Output()
	if err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(string(out))
	frames, _ := strconv.Atoi(f[0])
	sec, _ := strconv.ParseFloat(f[len(f)-1], 64)
	return int64(sec * 1000), frames
}

func TestEditE2EVerify(t *testing.T) {
	_ = e2eDir(t)
	resPath := os.Getenv("TOOLBOX_EDIT_E2E_RESULT")
	if resPath == "" {
		t.Skip("set TOOLBOX_EDIT_E2E_RESULT to Edit Lab's e2e.json")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	raw, err := os.ReadFile(resPath)
	if err != nil {
		t.Fatal(err)
	}
	var res e2eResult
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatal(err)
	}
	byName := map[string]int{}
	for i, p := range res.Projects {
		if p.Error != "" {
			t.Fatalf("%s failed in the app: %s", p.Name, p.Error)
		}
		byName[p.Name] = i
	}
	wantFrames := e2eSongMs * e2eFPS / 1000

	t.Run("cuts", func(t *testing.T) {
		p := res.Projects[byName["E2E cuts"]]
		if len(p.Outputs) != 1 {
			t.Fatalf("outputs %v", p.Outputs)
		}
		video := p.Outputs[0]
		if _, frames := probeDurationMs(t, video); frames < wantFrames-1 || frames > wantFrames+1 {
			t.Errorf("frames %d, want %d ± 1", frames, wantFrames)
		}
		for _, s := range e2eSegments() {
			for _, off := range []int64{0, e2eSegMs / 2} {
				k := int((s.startMs + off) * e2eFPS / 1000)
				if s.clip < 0 {
					if off != 0 {
						continue
					}
					rgb := frameRGB(t, ffmpeg, video, k+2)
					// Displayed top-left quarter of the photo (blue when upright): the photo is 300×400 shown, fit into 1080×1920.
					i := 3 * (600*e2eOutW + 270)
					r, g, b := rgb[i], rgb[i+1], rgb[i+2]
					if !(b > r && b > g) {
						t.Errorf("photo at %d ms isn't upright: %d,%d,%d", s.startMs, r, g, b)
					}
					continue
				}
				srcFrame := int((s.inMs + off) * e2eFPS / 1000)
				want := 1000*s.clip + srcFrame
				got := readBarcode(frameGray(t, ffmpeg, video, k))
				if got != want && got != want-1 && got != want+1 {
					t.Errorf("frame %d (%d ms): barcode %d, want %d (clip %d, source frame %d)", k, s.startMs+off, got, want, s.clip, srcFrame)
				}
			}
		}
	})

	t.Run("flash sync and determinism", func(t *testing.T) {
		p := res.Projects[byName["E2E flash"]]
		if len(p.Outputs) != 2 {
			t.Fatalf("outputs %v", p.Outputs)
		}
		luma := func(video string) []float64 {
			out, err := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-i", video, "-vf", "scale=32:32,format=gray", "-f", "rawvideo", "-").Output()
			if err != nil {
				t.Fatal(err)
			}
			var m []float64
			for i := 0; i+1024 <= len(out); i += 1024 {
				sum := 0
				for _, b := range out[i : i+1024] {
					sum += int(b)
				}
				m = append(m, float64(sum)/1024)
			}
			return m
		}
		a, b := luma(p.Outputs[0]), luma(p.Outputs[1])
		if len(a) != len(b) {
			t.Fatalf("frame counts differ: %d vs %d", len(a), len(b))
		}
		for i := range a {
			if math.Abs(a[i]-b[i]) > 0.5 {
				t.Fatalf("renders differ at frame %d: %.1f vs %.1f", i, a[i], b[i])
			}
		}
		bright := func(k int) bool { return k >= 0 && k < len(a) && a[k] > 128 }
		for beat := 0; beat*e2eBeatMs < e2eSongMs-e2eBeatMs; beat++ {
			ms := beat * e2eBeatMs
			if ms == e2eSilentBeat {
				continue
			}
			k := ms * e2eFPS / 1000
			if !bright(k-1) && !bright(k) && !bright(k+1) {
				t.Errorf("no flash within ±1 frame of the beat at %d ms (frame %d)", ms, k)
			}
		}
	})
}
