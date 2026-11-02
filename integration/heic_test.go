//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"image"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "golang.org/x/image/webp"

	"toolbox/core"
	"toolbox/core/heic"
	"toolbox/core/imaging"
	"toolbox/modules/converter"
)

// TestHEICThroughFFmpeg converts a real tiled iPhone HEIC (from
// .dev/heic-samples, not in the repo) to WebP with the Converter and builds
// a thumbnail, with no AI engine: FFmpeg stitches the tile grid.
func TestHEICThroughFFmpeg(t *testing.T) {
	src := filepath.Join("..", ".dev", "heic-samples", "hdr-sample.heic")
	if _, err := os.Stat(src); err != nil {
		t.Skip("no tiled HEIC sample in .dev/heic-samples")
	}
	src, _ = filepath.Abs(src)
	e := newPipelineEnv(t) // real store, jobs and FFmpeg
	dec := &heic.Decoder{Resolve: e.resolve, CacheDir: t.TempDir()}
	imaging.SetHEICConverter(dec)
	defer imaging.SetHEICConverter(nil)

	start := time.Now()
	thumb, err := imaging.NewThumbnailer().Thumb(src, 400)
	if err != nil || !strings.HasPrefix(thumb, "data:image/") {
		t.Fatalf("thumb: %.40s, %v", thumb, err)
	}
	t.Logf("first thumbnail (conversion included) in %s", time.Since(start).Round(time.Millisecond))
	if sz, err := imaging.Size(src); err != nil || sz.W != 1512 || sz.H != 850 {
		t.Fatalf("size = %+v, %v", sz, err)
	}

	opts := converter.DefaultOptions()
	opts.Preset = "webp"
	b, _ := json.Marshal(opts)
	jobs, err := e.jobs.Submit(context.Background(), converter.ModuleID, []string{src}, string(b))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Minute)
	var j core.Job
	for {
		j, err = e.jobs.Get(context.Background(), jobs[0].ID)
		if err != nil {
			t.Fatal(err)
		}
		if j.Status.Finished() || time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if j.Status != core.JobDone || len(j.Outputs) != 1 {
		t.Fatalf("convert: %s %s", j.Status, j.Error)
	}
	f, err := os.Open(j.Outputs[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, format, err := image.DecodeConfig(f)
	if err != nil || format != "webp" || cfg.Width != 1512 || cfg.Height != 850 {
		t.Fatalf("output %s %dx%d (%v)", format, cfg.Width, cfg.Height, err)
	}
}
