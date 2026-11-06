package editstudio

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The same table as editLength in frontend/src/viz/edit/emptyAnalysis.test.ts.
func TestEditLen(t *testing.T) {
	song := &Song{Path: "/s.wav", StartMs: 2000, EndMs: 12_000}
	tr := func(ends ...int64) []Track {
		var cl []Clip
		for _, e := range ends {
			cl = append(cl, Clip{EndMs: e})
		}
		return []Track{{Clips: cl}}
	}
	cases := []struct {
		name   string
		song   *Song
		tracks []Track
		want   int64
	}{
		{"song range", song, tr(50_000), 10_000},
		{"no song, no clips", nil, nil, 1000},
		{"no song, empty track", nil, tr(), 1000},
		{"no song, short clip", nil, tr(400), 1000},
		{"no song, last clip end over tracks", nil, append(tr(3000, 7000), tr(9000)...), 9000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := editLen(EditProject{Song: c.song, Tracks: c.tracks}); got != c.want {
				t.Errorf("editLen = %d, want %d", got, c.want)
			}
		})
	}
}

func TestValidateDocWithoutSong(t *testing.T) {
	env := newExportEnv(t)
	doc := env.doc
	doc.Song, doc.AnalysisKey = nil, ""
	if err := env.m.validateDoc(context.Background(), env.id, doc); err != nil {
		t.Fatalf("no song, no analysis: %v", err)
	}
	doc.AnalysisKey = "nope-s1-none-m0"
	if err := env.m.validateDoc(context.Background(), env.id, doc); err == nil {
		t.Error("an analysis key that isn't cached must fail")
	}
	doc.AnalysisKey = ""
	doc.Song = &Song{Path: filepath.Join(env.dir, "gone.mp3"), StartMs: 0, EndMs: 5000}
	if err := env.m.validateDoc(context.Background(), env.id, doc); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Errorf("a song file that is gone must fail: %v", err)
	}
}

func TestRunRenderWithoutSongPlan(t *testing.T) {
	env := newExportEnv(t)
	env.doc.Song, env.doc.AnalysisKey = nil, ""
	if _, err := env.m.docs.Save(context.Background(), env.id, "My Edit", env.doc); err != nil {
		t.Fatal(err)
	}
	if err := env.m.runRender(context.Background(), env.job, env.id); err != nil {
		t.Fatalf("runRender: %v", err)
	}
	p := env.plan
	// validDoc's last clip ends at 5000 ms.
	if p.StartMs != 0 || p.EndMs != 5000 {
		t.Errorf("range = %d..%d", p.StartMs, p.EndMs)
	}
	if p.Analysis.Key != "" || p.Analysis.AudioJSON != "" || p.Analysis.FeaturesPath != "" {
		t.Errorf("analysis = %+v, want the zero ref", p.Analysis)
	}
}

func TestMixGraphWithoutSong(t *testing.T) {
	doc := NewProject("9:16", 30, 1)
	doc.Tracks = []Track{{ID: "t1", Kind: "video", Clips: []Clip{
		{ID: "c1", Kind: "video", Path: "/clips/a.mov", StartMs: 0, EndMs: 4000, Volume: 1},
	}}}
	inputs, graph := buildMixGraph(doc, allAudio)
	if len(inputs) != 2 {
		t.Fatalf("inputs = %+v", inputs)
	}
	if inputs[0].Path != "anullsrc=r=48000:cl=stereo" || !slices.Equal(inputs[0].Pre, []string{"-f", "lavfi", "-t", "4"}) {
		t.Errorf("base input = %+v", inputs[0])
	}
	if !strings.HasPrefix(graph, "[0:a]aformat=sample_rates=48000:channel_layouts=stereo[song];") || !strings.Contains(graph, "[1:a]") || !strings.Contains(graph, "amix=inputs=2") {
		t.Errorf("graph:\n%s", graph)
	}
	if !strings.Contains(graph, "apad=whole_dur=4,atrim=start=0:end=4[out]") {
		t.Errorf("tail:\n%s", graph)
	}

	// No clips at all: 1 s of silence.
	doc.Tracks[0].Clips = nil
	inputs, graph = buildMixGraph(doc, allAudio)
	if len(inputs) != 1 || !slices.Equal(inputs[0].Pre, []string{"-f", "lavfi", "-t", "1"}) || !strings.Contains(graph, "[song]alimiter") {
		t.Errorf("empty: %+v\n%s", inputs, graph)
	}
}

func TestJobAttribution(t *testing.T) {
	cases := []struct {
		name        string
		action      Action
		hasAnalysis bool
		want        string
	}{
		{"plain render", ActionRender, false, VideoModuleID},
		{"plain prepare", ActionPrepare, false, VideoModuleID},
		{"plain matte", ActionMatte, false, VideoModuleID},
		{"plain interp", ActionInterp, false, VideoModuleID},
		{"analysed render", ActionRender, true, ModuleID},
		{"analyze", ActionAnalyze, false, ModuleID},
		{"text", ActionText, false, ModuleID},
		{"text on analysed", ActionText, true, ModuleID},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := jobModuleFor(c.action, c.hasAnalysis); got != c.want {
				t.Errorf("module = %s, want %s", got, c.want)
			}
		})
	}
}

func TestModuleForOptionsLooksTheProjectUp(t *testing.T) {
	env := newExportEnv(t) // validDoc has an analysis key
	s := &Service{m: env.m}
	ctx := context.Background()
	o := Options{Action: ActionRender, ProjectID: env.id}
	if got := s.moduleForOptions(ctx, o); got != ModuleID {
		t.Errorf("analysed project: %s", got)
	}
	env.doc.AnalysisKey = ""
	if _, err := env.m.docs.Save(ctx, env.id, "My Edit", env.doc); err != nil {
		t.Fatal(err)
	}
	if got := s.moduleForOptions(ctx, o); got != VideoModuleID {
		t.Errorf("plain project: %s", got)
	}
	if got := s.moduleForOptions(ctx, Options{Action: ActionRender, ProjectID: "missing"}); got != ModuleID {
		t.Errorf("unknown project: %s", got)
	}
}
