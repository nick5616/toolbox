package gif

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
)

func writeFile(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestTileTimes(t *testing.T) {
	got := tileTimes(10_000, 4)
	if want := []int64{1250, 3750, 6250, 8750}; !reflect.DeepEqual(got, want) {
		t.Errorf("tileTimes = %v, want %v", got, want)
	}
	if got := tileTimes(9000, 1); got[0] != 4500 {
		t.Errorf("one tile = %v", got)
	}
	for _, ms := range tileTimes(7777, 100) {
		if ms < 0 || ms >= 7777 {
			t.Fatalf("time %d outside the video", ms)
		}
	}
}

func TestCellSizeAndTimecode(t *testing.T) {
	if w, h := cellSize(320, 1920, 1080); w != 320 || h != 180 {
		t.Errorf("16:9 cell = %d×%d", w, h)
	}
	if w, h := cellSize(321, 1080, 1920); w != 320 || h != 568 {
		t.Errorf("portrait cell = %d×%d", w, h)
	}
	if w, h := cellSize(200, 0, 0); w != 200 || h != 112 {
		t.Errorf("unknown source cell = %d×%d", w, h)
	}
	for ms, want := range map[int64]string{0: "0:00", 61_000: "1:01", 3_599_000: "59:59", 3_723_000: "1:02:03"} {
		if got := timecode(ms); got != want {
			t.Errorf("timecode(%d) = %q, want %q", ms, got, want)
		}
	}
}

func TestArgs(t *testing.T) {
	p := strings.Join(paletteArgs("in.mp4", "p.png", 1.5, 4, 12, 480), " ")
	for _, want := range []string{"-ss 1.500 -t 4.000 -i in.mp4", "fps=12", "min(480,iw)", "palettegen=stats_mode=diff", "-update 1", "p.png"} {
		if !strings.Contains(p, want) {
			t.Errorf("palette args %q lack %q", p, want)
		}
	}
	g := strings.Join(gifArgs("in.mp4", "p.png", "o.gif", 0, 5, 10, 320, true), " ")
	for _, want := range []string{"-i in.mp4 -i p.png", "paletteuse", "-loop 0"} {
		if !strings.Contains(g, want) {
			t.Errorf("gif args %q lack %q", g, want)
		}
	}
	if once := strings.Join(gifArgs("in.mp4", "p.png", "o.gif", 0, 5, 10, 320, false), " "); !strings.Contains(once, "-loop -1") {
		t.Errorf("once: %q", once)
	}
	w := strings.Join(webpArgs("in.mp4", "o.webp", 0, 5, 10, 320, false), " ")
	if !strings.Contains(w, "libwebp_anim") || !strings.Contains(w, "-loop 1") {
		t.Errorf("webp args: %q", w)
	}
	f := strings.Join(frameArgs("in.mp4", "t001.png", 3.25, 320, 180, "t001.ass"), " ")
	if !strings.Contains(f, "scale=320:180") || !strings.Contains(f, "ass=t001.ass") || !strings.Contains(f, "-ss 3.250") {
		t.Errorf("frame args: %q", f)
	}
	if nolabel := strings.Join(frameArgs("in.mp4", "t001.png", 3, 320, 180, ""), " "); strings.Contains(nolabel, "ass=") {
		t.Errorf("label-less frame has ass: %q", nolabel)
	}
	s := strings.Join(sheetArgs("t%03d.png", "sheet.jpg", 4, 3), " ")
	if !strings.Contains(s, "tile=4x3:") || !strings.Contains(s, "-start_number 1 -i t%03d.png") {
		t.Errorf("sheet args: %q", s)
	}
}

func TestLabelDoc(t *testing.T) {
	var b bytes.Buffer
	if _, err := labelDoc("1:02:03", 320, 180).WriteTo(&b); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	for _, want := range []string{"PlayResX: 320", "PlayResY: 180", "Style: Tc,Arial,", "Dialogue: 0,0:00:00.00,", ",Tc,,0,0,0,,1:02:03"} {
		if !strings.Contains(out, want) {
			t.Errorf("ass lacks %q:\n%s", want, out)
		}
	}
}

func TestCheckOptions(t *testing.T) {
	tests := []struct {
		name string
		mod  func(*Options)
		msg  string
	}{
		{"defaults", func(*Options) {}, ""},
		{"too long", func(o *Options) { o.LengthSec = 31 }, "A GIF can be 0.5 to 30 seconds long; trim a shorter part"},
		{"too short", func(o *Options) { o.LengthSec = 0.1 }, "A GIF can be 0.5 to 30 seconds long; trim a shorter part"},
		{"negative start", func(o *Options) { o.StartSec = -1 }, "The start must be between 0 and 36,000 seconds"},
		{"fps", func(o *Options) { o.FPS = 60 }, "Frames per second must be between 1 and 30"},
		{"width", func(o *Options) { o.Width = 4000 }, "Width must be between 120 and 1280 pixels"},
		{"webp ok", func(o *Options) { o.Mode = ModeWebP }, ""},
		{"mode", func(o *Options) { o.Mode = "mp4" }, "Choose GIF, WebP or contact sheet"},
		{"sheet ok", func(o *Options) { o.Mode = ModeSheet; o.LengthSec = 99 }, ""},
		{"sheet columns", func(o *Options) { o.Mode = ModeSheet; o.Columns = 11 }, "Columns must be between 1 and 10"},
		{"sheet rows", func(o *Options) { o.Mode = ModeSheet; o.Rows = 0 }, "Rows must be between 1 and 10"},
		{"sheet cell", func(o *Options) { o.Mode = ModeSheet; o.CellWidth = 50 }, "Frame width must be between 120 and 1280 pixels"},
		{"sheet 10x10", func(o *Options) { o.Mode = ModeSheet; o.Columns, o.Rows = 10, 10 }, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := DefaultOptions()
			tt.mod(&o)
			err := checkOptions(o)
			if tt.msg == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || core.AsAppError(err).Message != tt.msg {
				t.Fatalf("err = %v, want %q", err, tt.msg)
			}
		})
	}
}

func TestValidate(t *testing.T) {
	dir := t.TempDir()
	v := writeFile(t, dir, "a.mov")
	raw, _ := json.Marshal(DefaultOptions())
	m := &Module{}
	if err := m.Validate([]string{v}, raw); err != nil {
		t.Fatal(err)
	}
	if err := m.Validate([]string{v, v}, raw); err == nil {
		t.Error("two files accepted")
	}
	if err := m.Validate([]string{writeFile(t, dir, "a.png")}, raw); err == nil {
		t.Error("an image was accepted")
	}
	if err := m.Validate([]string{v}, json.RawMessage(`{"mode":"gif","bogus":1}`)); err == nil {
		t.Error("unknown field accepted")
	}
}

func TestDescribeStep(t *testing.T) {
	m := &Module{}
	tests := []struct {
		opts    string
		role    string
		ext     string
		summary string
	}{
		{``, "gif", ".gif", "GIF · 5 s from 0 s · 12 fps · 480 px"},
		{`{"mode":"webp","loop":false}`, "gif", ".webp", "WebP · 5 s from 0 s · 12 fps · 480 px · plays once"},
		{`{"mode":"sheet","columns":3,"rows":2,"labels":false}`, "sheet", ".jpg", "Contact sheet · 3 × 2"},
	}
	for _, tt := range tests {
		info, err := m.DescribeStep(json.RawMessage(tt.opts))
		if err != nil {
			t.Fatalf("%s: %v", tt.opts, err)
		}
		if len(info.Produces) != 1 || info.Produces[0].Role != tt.role || info.Produces[0].Exts[0] != tt.ext {
			t.Errorf("%s: produces = %+v", tt.opts, info.Produces)
		}
		if info.Summary != tt.summary {
			t.Errorf("summary = %q, want %q", info.Summary, tt.summary)
		}
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"lengthSec":90}`)); err == nil {
		t.Error("90 s accepted")
	}
}

func TestPrepareStepAndOutputs(t *testing.T) {
	file := writeFile(t, t.TempDir(), "a.mp4")
	m := &Module{}
	jobs, err := m.PrepareStep(t.Context(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: file}, {Path: file}}}})
	if err != nil || len(jobs) != 2 {
		t.Fatalf("jobs = %+v, err = %v", jobs, err)
	}
	if _, err := m.PrepareStep(t.Context(), core.StepRequest{}); err == nil {
		t.Error("no files accepted")
	}
	res, err := m.StepOutputs(core.Job{Outputs: []core.Output{{Path: "/o/a.gif"}, {Path: "/o/a (sheet).jpg"}, {Path: "/o/b.webp"}}})
	if err != nil {
		t.Fatal(err)
	}
	roles := []string{res.Files[0].Role, res.Files[1].Role, res.Files[2].Role}
	if !reflect.DeepEqual(roles, []string{"gif", "sheet", "gif"}) || res.Files[2].RoleLabel != "Animated WebP" {
		t.Errorf("files = %+v", res.Files)
	}
}
