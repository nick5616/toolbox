//go:build integration

package lyricvideo

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// ffCaller is an engine stand-in whose stems are real (generated) audio.
type ffCaller struct {
	t      *testing.T
	ffmpeg string
	calls  []string
}

func (c *ffCaller) Call(_ context.Context, method string, params any, _ func(sidecar.Event)) (json.RawMessage, error) {
	c.calls = append(c.calls, method)
	dir := params.(map[string]any)["outputDir"].(string)
	v, i := filepath.Join(dir, "stem - Vocals.flac"), filepath.Join(dir, "stem - Instrumental.flac")
	ff(c.t, c.ffmpeg, "-f", "lavfi", "-i", "sine=f=220:d=6", v)
	ff(c.t, c.ffmpeg, "-f", "lavfi", "-i", "sine=f=660:d=6", i)
	return json.Marshal(map[string]any{"stems": []map[string]string{{"name": "Vocals", "path": v}, {"name": "Instrumental", "path": i}}})
}

func TestInstrumentalAudio(t *testing.T) {
	f := newFixture(t)
	caller := &ffCaller{t: t, ffmpeg: f.ffmpeg}
	m := &Module{sc: caller, cacheDir: filepath.Join(t.TempDir(), "cache")}
	o := DefaultOptions()
	o.Action, o.Lines, o.Height, o.Audio = ActionRender, testLines(), 720, "instrumental"
	o.Look.Background = "color"
	raw, _ := json.Marshal(o)
	var outs []string
	job := core.NewJobContext(core.JobContext{
		ID: "j", Inputs: []string{f.plain}, Options: raw, OutputDir: t.TempDir(), TempDir: t.TempDir(),
	}, core.JobHooks{
		Output: func(p string) (core.Output, error) { outs = append(outs, p); return core.Output{Path: p}, nil },
		Tool: func(id string) (string, error) {
			switch id {
			case "ffmpeg":
				return f.ffmpeg, nil
			case "ffprobe":
				return f.ffprobe, nil
			}
			return "", nil
		},
	})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(caller.calls) != 1 || caller.calls[0] != "stems.separate" || len(outs) != 2 {
		t.Fatalf("calls %v outs %v", caller.calls, outs)
	}
	if got := probeVal(t, f.ffprobe, outs[0], "-select_streams", "a:0", "-show_entries", "stream=codec_name"); got != "aac" {
		t.Errorf("audio codec = %s", got)
	}
	// A second render reuses the cached stems.
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if len(caller.calls) != 1 {
		t.Errorf("stems should be cached: %v", caller.calls)
	}
}
