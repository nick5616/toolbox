package videoeditor

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden")

func vclip(name string, in, out int64) Clip {
	return Clip{ID: name, Kind: "video", Path: name + ".mp4", InMs: in, OutMs: out, Speed: 1, Volume: 1,
		Fit: "fill", FitColor: "#000000", Zoom: 1, Motion: "none", Look: "none", Transition: Transition{Kind: "cut"}}
}

func pclip(name string, ms int64, motion string) Clip {
	c := vclip(name, 0, 0)
	c.Kind, c.Path, c.DurationMs, c.Motion = "image", name+".png", ms, motion
	return c
}

func withTrans(c Clip, kind string, ms int64) Clip {
	c.Transition = Transition{Kind: kind, DurationMs: ms}
	return c
}

func project(clips ...Clip) VideoProject {
	return VideoProject{Version: 1, Aspect: "9:16", Clips: clips, Titles: []Title{}}
}

func infosFor(doc VideoProject) map[string]ClipInfo {
	m := map[string]ClipInfo{}
	for _, c := range doc.Clips {
		if c.Kind == "video" {
			m[c.Path] = ClipInfo{Path: c.Path, Kind: "video", DurationMs: 60000, Width: 1920, Height: 1080, FPS: 30, HasAudio: true}
		}
	}
	if doc.Music != nil {
		m[doc.Music.Path] = ClipInfo{Path: doc.Music.Path, Kind: "audio", DurationMs: 30000, HasAudio: true}
	}
	return m
}

func render(t *testing.T, doc VideoProject, preview bool, maxMs int64) string {
	t.Helper()
	doc = normalize(doc)
	w, h := frameSize(doc.Aspect, preview)
	p, err := buildPlan(graphIn{Doc: doc, Infos: infosFor(doc), W: w, H: h, Preview: preview, MaxMs: maxMs,
		GraphFile: "graph.txt", ASSName: "titles.ass", OutputPath: "OUT.mp4"})
	if err != nil {
		t.Fatal(err)
	}
	s := strings.Join(p.Args, "\n") + "\n--- graph.txt\n" + p.Graph
	if p.ASS != "" {
		s += "--- titles.ass\n" + p.ASS
	}
	return s
}

func TestGolden(t *testing.T) {
	speed := func(c Clip, s float64) Clip { c.Speed = s; return c }
	fit := func(c Clip, f string) Clip {
		c.Fit = f
		if f == "fit-color" {
			c.FitColor = "#223344"
		}
		return c
	}
	music := &Music{Path: "song.mp3", OffsetMs: 12000, Volume: 0.8, FadeInMs: 1000, FadeOutMs: 2000, Duck: true}
	titled := project(vclip("a", 0, 6000))
	titled.Titles = []Title{
		{ID: "1", Text: "Day one\nLisbon {draft}", StartMs: 500, DurationMs: 2500, Style: "title", Position: "center", Font: "Georgia", Color: "#ffcc00"},
		{ID: "2", Text: "Alfama", StartMs: 3000, DurationMs: 2000, Style: "lower-third", Position: "bottom", Color: "#ffffff"},
		{ID: "3", Text: "so good", StartMs: 4000, DurationMs: 9000, Style: "caption", Position: "bottom", Color: "#ffffff"},
		{ID: "4", Text: "08:41", StartMs: 100, DurationMs: 1500, Style: "label", Position: "top", Color: "#ffffff"},
	}
	moved := vclip("a", 1000, 5000)
	moved.PanX, moved.PanY, moved.Zoom, moved.Look = 0.5, -0.25, 1.4, "vivid"
	cases := []struct {
		name    string
		doc     VideoProject
		preview bool
		maxMs   int64
	}{
		{"cuts", project(vclip("a", 0, 3000), vclip("b", 1000, 4000), vclip("c", 0, 2000)), false, 0},
		{"fade", project(withTrans(vclip("a", 0, 3000), "fade", 500), vclip("b", 0, 3000)), false, 0},
		{"dip", project(withTrans(vclip("a", 0, 3000), "dip", 400), vclip("b", 0, 3000)), false, 0},
		{"slide", project(withTrans(vclip("a", 0, 3000), "slide", 300), vclip("b", 0, 3000)), false, 0},
		{"mixed-joins", project(vclip("a", 0, 3000), withTrans(vclip("b", 0, 3000), "fade", 500), vclip("c", 0, 3000), withTrans(vclip("d", 0, 3000), "slide", 400), vclip("e", 0, 3000)), false, 0},
		{"fill", project(moved), false, 0},
		{"fit-blur", project(fit(vclip("a", 0, 3000), "fit-blur")), false, 0},
		{"fit-color", project(fit(vclip("a", 0, 3000), "fit-color")), false, 0},
		{"image-motion", project(pclip("p1", 3000, "in"), pclip("p2", 3000, "out"), pclip("p3", 2000, "left"), pclip("p4", 2000, "right"), pclip("p5", 2000, "none")), false, 0},
		{"image-fit-blur", project(fit(pclip("p1", 3000, "in"), "fit-blur")), false, 0},
		{"speed", project(speed(vclip("a", 0, 4000), 0.5), speed(vclip("b", 0, 4000), 2), speed(vclip("c", 0, 3000), 1.5), speed(vclip("d", 0, 3000), 0.75)), false, 0},
		{"mute", project(func() Clip { c := vclip("a", 0, 3000); c.Volume = 0; return c }(), func() Clip { c := vclip("b", 0, 3000); c.Volume = 1.5; return c }()), false, 0},
		{"music-duck", func() VideoProject { d := project(vclip("a", 0, 6000), vclip("b", 0, 6000)); d.Music = music; return d }(), false, 0},
		{"music-plain-end-with-music", func() VideoProject {
			d := project(vclip("a", 0, 6000))
			m := *music
			m.Duck, m.EndWithMusic, m.OffsetMs = false, true, 27000
			d.Music = &m
			return d
		}(), false, 0},
		{"titles", titled, false, 0},
		{"max-size", func() VideoProject { d := project(vclip("a", 0, 30000)); d.MaxSizeMB = 20; return d }(), false, 0},
		{"preview-16x9-max-seconds", func() VideoProject { d := project(vclip("a", 0, 30000)); d.Aspect = "16:9"; return d }(), true, 10000},
		{"looks", project(func() Clip { c := vclip("a", 0, 1000); c.Look = "warm"; return c }(), func() Clip { c := vclip("b", 0, 1000); c.Look = "cool"; return c }(),
			func() Clip { c := vclip("c", 0, 1000); c.Look = "mono"; return c }(), func() Clip { c := vclip("d", 0, 1000); c.Look = "fade"; return c }(),
			func() Clip { c := vclip("e", 0, 1000); c.Look = "noir"; return c }()), false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := render(t, tc.doc, tc.preview, tc.maxMs)
			path := filepath.Join("testdata", tc.name+".golden")
			if *update {
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("%v (run with -update)", err)
			}
			if string(want) != got {
				t.Errorf("%s differs from the golden file (run with -update to accept)\n--- got\n%s", tc.name, got)
			}
		})
	}
}

func TestBuildPlanErrors(t *testing.T) {
	small := project(vclip("a", 0, 30000))
	small.MaxSizeMB = 1 // 1 MB for 30 s: below 150 kbit/s
	p := vclip("p", 0, 0)
	p.Kind, p.DurationMs = "image", 1000
	tooShort := project(p)
	for name, doc := range map[string]VideoProject{"size too small": small, "no clips": project(), "output too short": tooShort} {
		_, err := buildPlan(graphIn{Doc: normalize(doc), Infos: infosFor(doc), W: 1080, H: 1920, MaxMs: map[bool]int64{true: 100}[name == "output too short"],
			GraphFile: "g", ASSName: "a", OutputPath: "o"})
		if err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestAtempoChain(t *testing.T) {
	for speed, want := range map[float64]string{0.5: "atempo=0.5", 2: "atempo=2", 1.5: "atempo=1.5", 0.25: "atempo=0.5,atempo=0.5", 4: "atempo=2,atempo=2"} {
		if got := strings.Join(atempoChain(speed), ","); got != want {
			t.Errorf("atempoChain(%v) = %s, want %s", speed, got, want)
		}
	}
}

func TestFrameSize(t *testing.T) {
	for _, tc := range []struct {
		aspect  string
		preview bool
		w, h    int
	}{
		{"9:16", false, 1080, 1920}, {"4:5", false, 1080, 1350}, {"1:1", false, 1080, 1080}, {"16:9", false, 1920, 1080},
		{"9:16", true, 540, 960}, {"4:5", true, 540, 674}, {"16:9", true, 960, 540},
	} {
		if w, h := frameSize(tc.aspect, tc.preview); w != tc.w || h != tc.h {
			t.Errorf("frameSize(%s,%v) = %dx%d, want %dx%d", tc.aspect, tc.preview, w, h, tc.w, tc.h)
		}
	}
}
