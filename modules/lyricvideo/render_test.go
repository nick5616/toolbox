package lyricvideo

import (
	"slices"
	"strings"
	"testing"
)

func planFor(bg, aspect, vis string) renderPlan {
	o := normalize(DefaultOptions())
	o.Look.Background = bg
	o.Look.Visualizer = vis
	o.Aspect, o.Height = aspect, 720
	w, h := canvasSize(aspect, 720)
	return renderPlan{
		O: o, Lay: computeLayout(o, w, h), Audio: "song.mp3", Cover: "cover.png", BgPath: "bg.file",
		DurMs: 5000, ASSName: "subs.ass", OutName: "out.mp4", BgKind: bg,
	}
}

func TestFilterGraphs(t *testing.T) {
	tests := []struct {
		bg, aspect, vis string
		contains        []string
		absent          []string
	}{
		{"blur-cover", "16:9", "none", []string{
			"[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=40,eq=brightness=-0.12,setsar=1,fps=30,format=yuv420p[bg]",
			"[bg]ass=subs.ass[v]"}, []string{"overlay", "asplit"}},
		{"cover", "16:9", "none", []string{"[1:v]split=2[ca][cb]", "[ca]scale=1280:720", "gblur=sigma=40", "[cb]scale=", "[bgb][cv]overlay=x=", "[bg]ass=subs.ass[v]"}, nil},
		{"cover", "9:16", "none", []string{"scale=720:1280", "crop=720:1280"}, nil},
		{"cover", "1:1", "none", []string{"scale=720:720"}, nil},
		{"color", "16:9", "none", []string{"[1:v]setsar=1,format=yuv420p[bg]"}, []string{"gblur"}},
		{"gradient", "9:16", "none", []string{"[1:v]setsar=1,format=yuv420p[bg]"}, nil},
		{"image", "1:1", "none", []string{"[1:v]scale=720:720:force_original_aspect_ratio=increase,crop=720:720,setsar=1,fps=30"}, []string{"gblur"}},
		{"video", "16:9", "none", []string{"[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30"}, nil},
		{"color", "16:9", "wave", []string{"[0:a]asplit=2[aout][avis]", "[avis]showwaves=s=1280x129:mode=cline:colors=0xffd166@0.6:r=30,format=yuva420p[vis]", "[bg][vis]overlay=x=0:y=591[bgv]", "[bgv]ass=subs.ass[v]"}, nil},
		{"color", "16:9", "bars", []string{"[avis]showfreqs=s=1280x129:mode=bar:fscale=log:colors=0xffd166@0.6:rate=30,format=yuva420p[vis]"}, []string{"showwaves"}},
	}
	for _, tc := range tests {
		p := planFor(tc.bg, tc.aspect, tc.vis)
		g, out := p.filterGraph()
		if out != "[v]" {
			t.Errorf("%s %s: out = %s", tc.bg, tc.aspect, out)
		}
		for _, c := range tc.contains {
			if !strings.Contains(g, c) {
				t.Errorf("%s %s %s: graph lacks %q:\n%s", tc.bg, tc.aspect, tc.vis, c, g)
			}
		}
		for _, c := range tc.absent {
			if strings.Contains(g, c) {
				t.Errorf("%s %s %s: graph has %q:\n%s", tc.bg, tc.aspect, tc.vis, c, g)
			}
		}
		// Filtergraphs never contain a path: only the relative ASS name.
		if strings.ContainsAny(g, `\`) || strings.Contains(g, "song.mp3") || strings.Contains(g, ":/") {
			t.Errorf("%s %s: graph contains a path:\n%s", tc.bg, tc.aspect, g)
		}
	}
}

func argIndex(a []string, v string) int { return slices.Index(a, v) }

func TestRenderArgs(t *testing.T) {
	p := planFor("blur-cover", "16:9", "none")
	a := p.args()
	if a[len(a)-1] != "out.mp4" {
		t.Errorf("last = %s", a[len(a)-1])
	}
	for _, want := range [][]string{
		{"-c:v", "libx264"}, {"-preset", "veryfast"}, {"-crf", "20"}, {"-pix_fmt", "yuv420p"}, {"-r", "30"},
		{"-c:a", "aac"}, {"-b:a", "192k"}, {"-movflags", "+faststart"}, {"-map", "[v]"}, {"-map", "0:a"},
		{"-loop", "1"}, {"-i", "cover.png"}, {"-i", "song.mp3"},
	} {
		i := argIndex(a, want[0])
		found := false
		for ; i >= 0 && i+1 < len(a); i++ {
			if a[i] == want[0] && a[i+1] == want[1] {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("args lack %v: %v", want, a)
		}
	}
	if !slices.Contains(a, "-shortest") || slices.Contains(a, "-ss") {
		t.Errorf("args: %v", a)
	}
	// The audio is input 0 and the background input 1.
	if argIndex(a, "song.mp3") > argIndex(a, "cover.png") {
		t.Errorf("input order: %v", a)
	}

	// Preview: -ss/-t on the audio input, 10 s.
	p.StartMs, p.DurMs, p.OutName = 12500, 10000, "preview.mp4"
	a = p.args()
	i := argIndex(a, "-ss")
	if i < 0 || a[i+1] != "12.500" || a[i+2] != "-t" || a[i+3] != "10.000" || a[i+4] != "-i" || a[i+5] != "song.mp3" {
		t.Errorf("preview args: %v", a)
	}

	// The visualiser maps the split audio.
	p = planFor("color", "16:9", "wave")
	a = p.args()
	if i := argIndex(a, "[aout]"); i < 1 || a[i-1] != "-map" {
		t.Errorf("visualiser args: %v", a)
	}

	// Background inputs.
	for bg, want := range map[string][]string{
		"color":    {"-f", "lavfi", "-i", "color=c=0x1b1f2a:s=1280x720:r=30:d=5.000"},
		"gradient": {"-f", "lavfi", "-i", "gradients=s=1280x720:c0=0x1b1f2a:c1=0x3a2f5b:x0=0:y0=0:x1=0:y1=720:speed=0:r=30:d=5.000"},
		"image":    {"-loop", "1", "-framerate", "30", "-t", "5.000", "-i", "bg.file"},
		"video":    {"-stream_loop", "-1", "-t", "5.000", "-i", "bg.file"},
	} {
		a := planFor(bg, "16:9", "none").args()
		if !strings.Contains(strings.Join(a, " "), strings.Join(want, " ")) {
			t.Errorf("%s: args %v lack %v", bg, a, want)
		}
	}
}

func TestEffectiveBackground(t *testing.T) {
	for _, bg := range []string{"blur-cover", "cover"} {
		if k, fell := effectiveBackground(Look{Background: bg}, false); k != "gradient" || !fell {
			t.Errorf("%s without a cover = %s, %v", bg, k, fell)
		}
		if k, fell := effectiveBackground(Look{Background: bg}, true); k != bg || fell {
			t.Errorf("%s with a cover = %s, %v", bg, k, fell)
		}
	}
	if k, fell := effectiveBackground(Look{Background: "color"}, false); k != "color" || fell {
		t.Errorf("color = %s, %v", k, fell)
	}
}

func TestNormalizeFillsDefaults(t *testing.T) {
	o := normalize(Options{})
	if o.Look.Background != "blur-cover" || o.Look.Font != "Arial" || o.Look.TextColor != "#ffffff" || o.Look.HighlightColor != "#ffd166" ||
		o.Aspect != "16:9" || o.Height != 1080 || o.Audio != "original" || o.Look.Visualizer != "none" || o.Look.Position != "center" {
		t.Errorf("normalize = %+v", o)
	}
	keep := normalize(Options{Aspect: "1:1", Height: 720, Look: Look{TextColor: "#000000"}})
	if keep.Aspect != "1:1" || keep.Height != 720 || keep.Look.TextColor != "#000000" {
		t.Errorf("normalize overwrote: %+v", keep)
	}
}
