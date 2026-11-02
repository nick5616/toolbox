package heic

import (
	"context"
	"encoding/json"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func mustProbe(t *testing.T, js string) probe {
	t.Helper()
	var p probe
	if err := json.Unmarshal([]byte(js), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestBuildArgsGrid(t *testing.T) {
	p := mustProbe(t, `{"streams":[{"index":0,"codec_type":"video","width":512,"height":512},{"index":1,"codec_type":"video","width":512,"height":512},{"index":2,"codec_type":"video","width":756,"height":426,"pix_fmt":"gray"}],
	"stream_groups":[{"type":"Tile Grid","side_data_list":[{"rotation":-90}],"components":[{"width":1000,"height":500,"horizontal_offset":0,"vertical_offset":0,
	"subcomponents":[{"stream_index":0,"tile_horizontal_offset":0,"tile_vertical_offset":0},{"stream_index":1,"tile_horizontal_offset":512,"tile_vertical_offset":0}]}]}]}`)
	args, err := buildArgs(p, "in.heic", "out.png")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	want := "[0:0][0:1]xstack=inputs=2:layout=0_0|512_0:fill=black,crop=1000:500:0:0,transpose=clock[o]"
	if !strings.Contains(joined, want) || !slices.Contains(args, "[o]") {
		t.Fatalf("args = %s", joined)
	}
	if i := slices.Index(args, "-noautorotate"); i < 0 || i > slices.Index(args, "-i") {
		t.Fatalf("autorotate must be an input option: %s", joined)
	}
}

func TestBuildArgsSingleSkipsGrayAndThumbnails(t *testing.T) {
	p := mustProbe(t, `{"streams":[{"index":0,"codec_type":"video","width":320,"height":212},{"index":1,"codec_type":"video","width":1280,"height":854,"side_data_list":[{},{"rotation":90}]},{"index":2,"codec_type":"video","width":4000,"height":3000,"pix_fmt":"gray"}]}`)
	args, err := buildArgs(p, "in.heic", "out.png")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-map 0:1") || !strings.Contains(joined, "-vf transpose=cclock") {
		t.Fatalf("args = %s", joined)
	}
	if _, err := buildArgs(mustProbe(t, `{"streams":[]}`), "a", "b"); err == nil {
		t.Fatal("no stream should fail")
	}
}

func TestRotateFilter(t *testing.T) {
	for deg, want := range map[float64]string{0: "", -90: "transpose=clock", 90: "transpose=cclock", 180: "hflip,vflip", -180: "hflip,vflip", 270: "transpose=clock", 89.6: "transpose=cclock"} {
		if got := rotateFilter(deg); got != want {
			t.Errorf("rotateFilter(%v) = %q, want %q", deg, got, want)
		}
	}
}

// TestRealSamples decodes the HEIC samples in .dev/heic-samples (not in the
// repo) with the FFmpeg on PATH; it skips when either is missing.
func TestRealSamples(t *testing.T) {
	dir := filepath.Join("..", "..", ".dev", "heic-samples")
	ffmpeg, err1 := exec.LookPath("ffmpeg")
	ffprobe, err2 := exec.LookPath("ffprobe")
	if err1 != nil || err2 != nil {
		t.Skip("ffmpeg not on PATH")
	}
	cases := map[string][2]int{"hdr-sample.heic": {1512, 850}, "example.heic": {1280, 854}}
	d := &Decoder{CacheDir: t.TempDir(), Resolve: func(id string) (string, error) {
		if id == "ffprobe" {
			return ffprobe, nil
		}
		return ffmpeg, nil
	}}
	ran := 0
	for name, size := range cases {
		src := filepath.Join(dir, name)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		ran++
		out, err := d.ToPNG(context.Background(), src)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		f, err := os.Open(out)
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := png.DecodeConfig(f)
		f.Close()
		if err != nil || cfg.Width != size[0] || cfg.Height != size[1] {
			t.Fatalf("%s: %dx%d (%v), want %dx%d", name, cfg.Width, cfg.Height, err, size[0], size[1])
		}
		again, err := d.ToPNG(context.Background(), src)
		if err != nil || again != out {
			t.Fatalf("%s: cache miss (%s vs %s, %v)", name, again, out, err)
		}
	}
	if ran == 0 {
		t.Skip("no samples in .dev/heic-samples")
	}
}

func TestMissingToolsSaysWhatToInstall(t *testing.T) {
	src := filepath.Join(t.TempDir(), "a.heic")
	if err := os.WriteFile(src, []byte("not heic"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := &Decoder{CacheDir: t.TempDir(), Resolve: func(string) (string, error) { return "", os.ErrNotExist }}
	_, err := d.ToPNG(context.Background(), src)
	if err == nil || !strings.Contains(err.Error(), "dependency_missing") {
		t.Fatalf("err = %v", err)
	}
}
