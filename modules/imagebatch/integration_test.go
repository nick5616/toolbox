//go:build integration

package imagebatch

import (
	"context"
	"encoding/json"
	"image/color"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

const defaultFFDir = `C:\Users\nickb\repos\toolbox\.dev\p5-research\packs\smoke\bin\ffmpeg`

func ffmpegPath(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("TOOLBOX_TEST_FFMPEG_DIR")
	if dir == "" {
		dir = defaultFFDir
	}
	p := filepath.Join(dir, "ffmpeg.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	if lp, err := exec.LookPath("ffmpeg"); err == nil {
		return lp
	}
	t.Skip("FFmpeg not found")
	return ""
}

func runBatch(t *testing.T, ffmpeg string, inputs []string, o Options) (Result, string) {
	t.Helper()
	raw, _ := json.Marshal(o)
	var res Result
	out := filepath.Join(t.TempDir(), "out")
	job := core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: inputs, Options: raw, OutputDir: out, TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) { return core.Output{Path: p}, nil },
		Result: func(b json.RawMessage) { _ = json.Unmarshal(b, &res) },
		Tool:   func(string) (string, error) { return ffmpeg, nil },
	})
	if err := (&Module{}).Run(context.Background(), job); err != nil {
		t.Fatalf("run: %v", err)
	}
	return res, out
}

func TestTextWatermarkAndWebP(t *testing.T) {
	ffmpeg := ffmpegPath(t)
	dir := t.TempDir()
	in := filepath.Join(dir, "plain.png")
	writePNG(t, in, 600, 400, color.NRGBA{0, 0, 0, 255})

	o := DefaultOptions()
	o.Resize = ResizeKeep
	o.Format = FormatPNG
	o.Watermark = Watermark{Kind: WatermarkText, Text: "Sample mark", Font: "Arial", Color: "#ffffff", Corner: CornerBottomRight, Opacity: 1, Size: 10}
	res, _ := runBatch(t, ffmpeg, []string{in}, o)
	if len(res.Files) != 1 {
		t.Fatalf("%+v", res)
	}
	img := decodeOut(t, res.Files[0].Output)
	white := 0
	b := img.Bounds()
	for y := b.Max.Y * 3 / 4; y < b.Max.Y; y++ {
		for x := b.Max.X / 2; x < b.Max.X; x++ {
			if r, _, _, _ := img.At(x, y).RGBA(); r>>8 > 200 {
				white++
			}
		}
	}
	if white < 100 {
		t.Fatalf("no text drawn in the bottom-right corner (%d bright pixels)", white)
	}
	if r, _, _, _ := img.At(10, 10).RGBA(); r>>8 > 10 {
		t.Error("top-left should stay black")
	}

	o.Format = FormatWebP
	o.Watermark = DefaultWatermark()
	res, _ = runBatch(t, ffmpeg, []string{in}, o)
	if len(res.Files) != 1 || !strings.HasSuffix(res.Files[0].Output, ".webp") {
		t.Fatalf("%+v", res)
	}
	if st, err := os.Stat(res.Files[0].Output); err != nil || st.Size() < 50 {
		t.Fatalf("webp not written: %v", err)
	}
	decodeOut(t, res.Files[0].Output) // decodable by the pure-Go webp reader

	// The text preview goes through FFmpeg too.
	o.Watermark = Watermark{Kind: WatermarkText, Text: "Preview", Font: "Georgia", Color: "#ff0000", Corner: CornerCenter, Opacity: 0.8, Size: 12}
	s := NewService(nil, func(string) (string, error) { return ffmpeg, nil }, dir)
	if url, err := s.Preview(in, o); err != nil || !strings.HasPrefix(url, "data:image/") {
		t.Fatalf("preview: %v", err)
	}
}

func TestBatchKeepsGoingAfterABadFile(t *testing.T) {
	ffmpeg := ffmpegPath(t)
	dir := t.TempDir()
	good := filepath.Join(dir, "good.png")
	writePNG(t, good, 50, 50, color.NRGBA{9, 9, 9, 255})
	bad := filepath.Join(dir, "bad.jpg")
	_ = os.WriteFile(bad, []byte("junk"), 0o644)
	res, _ := runBatch(t, ffmpeg, []string{bad, good}, DefaultOptions())
	if len(res.Files) != 1 || len(res.Failed) != 1 || !strings.HasPrefix(res.Failed[0], "bad.jpg") {
		t.Fatalf("%+v", res)
	}
}
