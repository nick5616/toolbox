package editstudio

import (
	"slices"
	"strings"
	"testing"
)

func mixDoc() EditProject {
	doc := NewProject("9:16", 30, 1)
	doc.Song = &Song{Path: "/music/song.mp3", StartMs: 10_000, EndMs: 40_000, GainDb: -3, FadeInMs: 500, FadeOutMs: 500}
	doc.Tracks = []Track{{ID: "t1", Kind: "video", Name: "Video 1"}}
	return doc
}

func mixWithClip(doc EditProject, c Clip) EditProject {
	if c.Kind == "" {
		c.Kind = "video"
	}
	if c.Path == "" {
		c.Path = "/clips/a.mov"
	}
	if c.Volume == 0 {
		c.Volume = 1
	}
	doc.Tracks[0].Clips = append(doc.Tracks[0].Clips, c)
	return doc
}

func allAudio(string) bool { return true }

func TestMixGraphSongOnly(t *testing.T) {
	inputs, graph := buildMixGraph(mixDoc(), allAudio)
	wantGraph := "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=-3dB,afade=t=in:st=0:d=0.5,afade=t=out:st=29.5:d=0.5[song];\n" +
		"[song]alimiter=limit=0.97,apad=whole_dur=30,atrim=start=0:end=30[out]\n"
	if graph != wantGraph {
		t.Fatalf("graph:\n%s\nwant:\n%s", graph, wantGraph)
	}
	if len(inputs) != 1 || inputs[0].Path != "/music/song.mp3" || !slices.Equal(inputs[0].Pre, []string{"-ss", "10", "-t", "30"}) {
		t.Fatalf("inputs = %+v", inputs)
	}
}

func TestMixGraphSongWithoutGainOrFades(t *testing.T) {
	doc := mixDoc()
	doc.Song.GainDb, doc.Song.FadeInMs, doc.Song.FadeOutMs = 0, 0, 0
	_, graph := buildMixGraph(doc, allAudio)
	if !strings.HasPrefix(graph, "[0:a]aformat=sample_rates=48000:channel_layouts=stereo[song];") {
		t.Fatalf("graph = %s", graph)
	}
}

func TestMixGraphClips(t *testing.T) {
	cases := []struct {
		name     string
		clip     Clip
		mutate   func(d *EditProject)
		audible  bool
		wantPre  []string
		wantFrag []string
	}{
		{"speed 1", Clip{StartMs: 2000, EndMs: 4000, InMs: 500}, nil, true,
			[]string{"-ss", "0.5", "-t", "2"},
			[]string{"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.01,afade=t=out:st=1.99:d=0.01,adelay=2000|2000[c1]"}},
		{"speed 2", Clip{StartMs: 1000, EndMs: 3000, InMs: 0, Speed: "2"}, nil, true,
			[]string{"-ss", "0", "-t", "4"},
			[]string{"asetpts=PTS-STARTPTS,atempo=2,afade", "adelay=1000|1000"}},
		{"speed 4 chains", Clip{StartMs: 0, EndMs: 1000, Speed: `{"base":4,"keys":[]}`}, nil, true,
			[]string{"-ss", "0", "-t", "4"},
			[]string{"atempo=2,atempo=2,afade"}},
		{"speed 0.5", Clip{StartMs: 1000, EndMs: 3000, InMs: 100, Speed: "0.5"}, nil, true,
			[]string{"-ss", "0.1", "-t", "1"},
			[]string{"atempo=0.5,afade"}},
		{"constant keys", Clip{StartMs: 0, EndMs: 1000, Speed: `{"base":1,"keys":[{"t":0,"v":2,"ease":"linear"},{"t":500,"v":2,"ease":"hold"}]}`}, nil, true,
			[]string{"-ss", "0", "-t", "2"}, []string{"atempo=2"}},
		{"keyed speed is skipped", Clip{StartMs: 0, EndMs: 2000, Speed: `{"base":1,"keys":[{"t":0,"v":1,"ease":"linear"},{"t":1000,"v":0.5,"ease":"ease"}]}`}, nil, false, nil, nil},
		{"speed 0 is skipped", Clip{StartMs: 0, EndMs: 2000, Speed: "0"}, nil, false, nil, nil},
		{"volume", Clip{StartMs: 0, EndMs: 1000, Volume: 0.5}, nil, true, []string{"-ss", "0", "-t", "1"}, []string{"asetpts=PTS-STARTPTS,volume=0.5,afade"}},
		{"muted track", Clip{StartMs: 0, EndMs: 1000}, func(d *EditProject) { d.Tracks[0].Muted = true }, false, nil, nil},
		{"image clip", Clip{Kind: "image", Path: "/clips/b.jpg", StartMs: 0, EndMs: 1000}, nil, false, nil, nil},
		{"past the end", Clip{StartMs: 30_000, EndMs: 31_000}, nil, false, nil, nil},
		{"cut offset later", Clip{StartMs: 2000, EndMs: 3000}, func(d *EditProject) { d.CutOffsetFrames = 3 }, true,
			[]string{"-ss", "0", "-t", "1"}, []string{"adelay=2100|2100"}},
		{"cut offset earlier trims the head", Clip{StartMs: 0, EndMs: 1000, InMs: 1000}, func(d *EditProject) { d.CutOffsetFrames = -3 }, true,
			[]string{"-ss", "1.1", "-t", "0.9"}, []string{"asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.01,afade=t=out:st=0.89:d=0.01[c1]"}},
		{"clip cut by the end of the edit", Clip{StartMs: 29_000, EndMs: 31_000}, nil, true,
			[]string{"-ss", "0", "-t", "1"}, []string{"adelay=29000|29000"}},
		{"too short for fades", Clip{StartMs: 100, EndMs: 115}, nil, true,
			[]string{"-ss", "0", "-t", "0.015"}, []string{"asetpts=PTS-STARTPTS,adelay=100|100[c1]"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := mixWithClip(mixDoc(), tc.clip)
			if tc.mutate != nil {
				tc.mutate(&doc)
			}
			inputs, graph := buildMixGraph(doc, allAudio)
			if !tc.audible {
				if len(inputs) != 1 || strings.Contains(graph, "amix") {
					t.Fatalf("clip should be skipped: %d inputs\n%s", len(inputs), graph)
				}
				return
			}
			if len(inputs) != 2 {
				t.Fatalf("inputs = %+v\n%s", inputs, graph)
			}
			if !slices.Equal(inputs[1].Pre, tc.wantPre) {
				t.Fatalf("input = %+v, want pre %v", inputs[1], tc.wantPre)
			}
			for _, f := range tc.wantFrag {
				if !strings.Contains(graph, f) {
					t.Errorf("graph lacks %q:\n%s", f, graph)
				}
			}
			if !strings.Contains(graph, "[song][c1]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.97,apad=whole_dur=30,atrim=start=0:end=30[out]") {
				t.Errorf("mix tail wrong:\n%s", graph)
			}
		})
	}
}

func TestMixGraphSkipsSourcesWithoutAudio(t *testing.T) {
	doc := mixWithClip(mixDoc(), Clip{StartMs: 0, EndMs: 1000})
	inputs, _ := buildMixGraph(doc, func(string) bool { return false })
	if len(inputs) != 1 {
		t.Fatalf("inputs = %+v", inputs)
	}
}

func TestMixGraphTwoClipsAndTracks(t *testing.T) {
	doc := mixWithClip(mixDoc(), Clip{StartMs: 0, EndMs: 1000})
	doc = mixWithClip(doc, Clip{ID: "c2", StartMs: 1000, EndMs: 2000, Path: "/clips/c.mov"})
	doc.Tracks = append(doc.Tracks, Track{ID: "t2", Kind: "video", Clips: []Clip{{ID: "c3", Kind: "video", Path: "/clips/d.mov", StartMs: 0, EndMs: 500, Volume: 1}}})
	inputs, graph := buildMixGraph(doc, allAudio)
	if len(inputs) != 4 {
		t.Fatalf("inputs = %d\n%s", len(inputs), graph)
	}
	if !strings.Contains(graph, "[song][c1][c2][c3]amix=inputs=4:") {
		t.Fatalf("graph:\n%s", graph)
	}
}

func TestMixArgs(t *testing.T) {
	inputs, _ := buildMixGraph(mixWithClip(mixDoc(), Clip{StartMs: 0, EndMs: 1000}), allAudio)
	got := strings.Join(mixArgs(inputs, 30_000, "mix.wav"), " ")
	for _, want := range []string{
		"-ss 10 -t 30 -i /music/song.mp3", "-ss 0 -t 1 -i /clips/a.mov",
		"-/filter_complex graph.txt", "-map [out]", "-c:a pcm_s16le -ar 48000 -ac 2 -t 30 mix.wav",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("args lack %q: %s", want, got)
		}
	}
}

func TestSpeedCurve(t *testing.T) {
	cases := []struct {
		raw      string
		at       float64
		want     float64
		constant bool
	}{
		{"", 0, 1, true},
		{"2", 100, 2, true},
		{`{"base":0.5}`, 0, 0.5, true},
		{`{"base":1,"keys":[{"t":0,"v":1,"ease":"linear"},{"t":1000,"v":3,"ease":"linear"}]}`, 500, 2, false},
		{`{"base":1,"keys":[{"t":0,"v":1,"ease":"hold"},{"t":1000,"v":3,"ease":"linear"}]}`, 999, 1, false},
		{`{"base":1,"keys":[{"t":0,"v":0,"ease":"ease"},{"t":1000,"v":2,"ease":"linear"}]}`, 500, 1, false},
		{`{"base":1,"keys":[{"t":100,"v":0,"ease":"linear"},{"t":1000,"v":2,"ease":"linear"}]}`, 5000, 2, false},
		{`{"base":1,"keys":[{"t":100,"v":0,"ease":"linear"},{"t":1000,"v":2,"ease":"linear"}]}`, 0, 0, false},
		{"not json", 0, 1, true},
	}
	for _, tc := range cases {
		c := parseSpeedCurve(tc.raw)
		if got := c.at(tc.at); got != tc.want {
			t.Errorf("%q at %v = %v, want %v", tc.raw, tc.at, got, tc.want)
		}
		if _, ok := c.constant(); ok != tc.constant {
			t.Errorf("%q constant = %v", tc.raw, ok)
		}
	}
}

func TestClipSourceRange(t *testing.T) {
	cases := []struct {
		name     string
		c        Clip
		from, to int64
	}{
		{"1x", Clip{StartMs: 0, EndMs: 2000, InMs: 500}, 500, 2500},
		{"half", Clip{StartMs: 0, EndMs: 2000, InMs: 0, Speed: "0.5"}, 0, 1000},
		{"ramp 1 to 0 over 1 s", Clip{StartMs: 0, EndMs: 1000, InMs: 0, Speed: `{"base":1,"keys":[{"t":0,"v":1,"ease":"linear"},{"t":1000,"v":0,"ease":"linear"}]}`}, 0, 517},
	}
	for _, tc := range cases {
		from, to := clipSourceRange(tc.c, 30)
		if from != tc.from || to != tc.to {
			t.Errorf("%s: %d..%d, want %d..%d", tc.name, from, to, tc.from, tc.to)
		}
	}
}
