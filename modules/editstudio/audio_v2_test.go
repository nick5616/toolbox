package editstudio

import (
	"slices"
	"strings"
	"testing"
)

// mixDocAudio is mixDoc plus an audio track holding the given clips.
func mixDocAudio(clips ...Clip) EditProject {
	doc := mixDoc()
	for i := range clips {
		if clips[i].Kind == "" {
			clips[i].Kind = "audio"
		}
		if clips[i].Path == "" {
			clips[i].Path = "/music/voice.wav"
		}
		if clips[i].Volume == 0 {
			clips[i].Volume = 1
		}
	}
	doc.Tracks = append(doc.Tracks, Track{ID: "a1", Kind: "audio", Name: "Audio 1", Clips: clips})
	return doc
}

func TestMixGraphAudioClip(t *testing.T) {
	doc := mixDocAudio(Clip{ID: "x1", StartMs: 1000, EndMs: 3000, InMs: 200, FadeInMs: 500, FadeOutMs: 250})
	inputs, graph := buildMixGraph(doc, allAudio)
	if len(inputs) != 2 || inputs[1].Path != "/music/voice.wav" || !slices.Equal(inputs[1].Pre, []string{"-ss", "0.2", "-t", "2"}) {
		t.Fatalf("inputs = %+v", inputs)
	}
	want := "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=1.75:d=0.25,adelay=1000|1000[c1]"
	if !strings.Contains(graph, want) {
		t.Errorf("graph lacks %q:\n%s", want, graph)
	}
	if !strings.Contains(graph, "[song][c1]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.98,") {
		t.Errorf("tail:\n%s", graph)
	}
}

func TestMixGraphAudioClipDefaultsAndSpeed(t *testing.T) {
	doc := mixDocAudio(Clip{ID: "x1", StartMs: 0, EndMs: 1000, Speed: "2"})
	_, graph := buildMixGraph(doc, allAudio)
	want := "asetpts=PTS-STARTPTS,atempo=2,afade=t=in:st=0:d=0.01,afade=t=out:st=0.99:d=0.01[c1]"
	if !strings.Contains(graph, want) {
		t.Errorf("graph lacks %q:\n%s", want, graph)
	}
}

func TestMixGraphGainKeys(t *testing.T) {
	keys := `{"base":0,"keys":[{"t":0,"v":0,"ease":"linear"},{"t":1000,"v":-12,"ease":"linear"}]}`
	t.Run("keys become an expression evaluated per frame", func(t *testing.T) {
		doc := mixDocAudio(Clip{ID: "x1", StartMs: 0, EndMs: 2000, Gain: keys, Volume: 0.5})
		_, graph := buildMixGraph(doc, allAudio)
		want := "asetpts=PTS-STARTPTS,volume='0.5*pow(10,(lt(t,0)*0+gte(t,0)*lt(t,1)*(0+(-12)*(t-0))+gte(t,1)*(-12))/20)':eval=frame,afade=t=in"
		if !strings.Contains(graph, want) {
			t.Errorf("graph lacks %q:\n%s", want, graph)
		}
	})
	t.Run("a constant gain is a plain volume", func(t *testing.T) {
		doc := mixDocAudio(Clip{ID: "x1", StartMs: 0, EndMs: 2000, Gain: "-6", Volume: 1})
		_, graph := buildMixGraph(doc, allAudio)
		if !strings.Contains(graph, "asetpts=PTS-STARTPTS,volume=0.501187,afade") || strings.Contains(graph, "eval=frame") {
			t.Errorf("graph:\n%s", graph)
		}
	})
	t.Run("video clips take Gain too", func(t *testing.T) {
		doc := mixWithClip(mixDoc(), Clip{StartMs: 0, EndMs: 2000, Gain: "6"})
		_, graph := buildMixGraph(doc, allAudio)
		if !strings.Contains(graph, "volume=1.995262,afade") {
			t.Errorf("graph:\n%s", graph)
		}
	})
	t.Run("keys follow the head cut off a clip", func(t *testing.T) {
		doc := mixWithClip(mixDoc(), Clip{StartMs: 0, EndMs: 2000, Gain: keys})
		doc.CutOffsetFrames = -3 // 100 ms earlier: the first 100 ms of the clip aren't heard
		_, graph := buildMixGraph(doc, allAudio)
		if !strings.Contains(graph, "lt(t,(-0.1))*0") || !strings.Contains(graph, "lt(t,0.9)") {
			t.Errorf("graph:\n%s", graph)
		}
	})
}

func TestMixGraphVolumeZeroIsMuted(t *testing.T) {
	t.Run("audio clip", func(t *testing.T) {
		doc := mixDocAudio(Clip{ID: "x1", StartMs: 0, EndMs: 1000})
		doc.Tracks[1].Clips[0].Volume = 0
		if inputs, _ := buildMixGraph(doc, allAudio); len(inputs) != 1 {
			t.Errorf("inputs = %+v", inputs)
		}
	})
	t.Run("gain at the bottom of the range is not special", func(t *testing.T) {
		doc := mixDocAudio(Clip{ID: "x1", StartMs: 0, EndMs: 1000, Gain: "-60"})
		inputs, graph := buildMixGraph(doc, allAudio)
		if len(inputs) != 2 || !strings.Contains(graph, "volume=0.001") {
			t.Errorf("%d inputs\n%s", len(inputs), graph)
		}
	})
}

func TestMixGraphMuteAndSolo(t *testing.T) {
	twoTracks := func() EditProject {
		doc := mixDocAudio(Clip{ID: "x1", StartMs: 0, EndMs: 1000})
		doc.Tracks[0].Clips = []Clip{{ID: "v1", Kind: "video", Path: "/clips/a.mov", StartMs: 0, EndMs: 1000, Volume: 1}}
		doc.Tracks = append(doc.Tracks, Track{ID: "a2", Kind: "audio", Clips: []Clip{
			{ID: "x2", Kind: "audio", Path: "/music/fx.wav", StartMs: 500, EndMs: 1500, Volume: 1},
		}})
		return doc
	}
	paths := func(doc EditProject) []string {
		in, _ := buildMixGraph(doc, allAudio)
		var out []string
		for _, i := range in[1:] {
			out = append(out, i.Path)
		}
		return out
	}
	if got := paths(twoTracks()); !slices.Equal(got, []string{"/clips/a.mov", "/music/voice.wav", "/music/fx.wav"}) {
		t.Errorf("all heard: %v", got)
	}
	d := twoTracks()
	d.Tracks[1].Muted = true
	if got := paths(d); !slices.Equal(got, []string{"/clips/a.mov", "/music/fx.wav"}) {
		t.Errorf("a1 muted: %v", got)
	}
	d = twoTracks()
	d.Tracks[2].Solo = true
	if got := paths(d); !slices.Equal(got, []string{"/music/fx.wav"}) {
		t.Errorf("a2 solo: %v", got)
	}
	d = twoTracks()
	d.Tracks[1].Solo, d.Tracks[2].Solo = true, true
	if got := paths(d); !slices.Equal(got, []string{"/music/voice.wav", "/music/fx.wav"}) {
		t.Errorf("both solo: %v", got)
	}
	d = twoTracks()
	d.Tracks[2].Solo, d.Tracks[2].Muted = true, true
	if got := paths(d); len(got) != 0 {
		t.Errorf("a muted solo track is still silent: %v", got)
	}
}

func TestMixGraphAudioClipsIgnoreTheCutOffset(t *testing.T) {
	doc := mixDocAudio(Clip{ID: "x1", StartMs: 2000, EndMs: 3000})
	doc.CutOffsetFrames = 3
	_, graph := buildMixGraph(doc, allAudio)
	if !strings.Contains(graph, "adelay=2000|2000") {
		t.Errorf("graph:\n%s", graph)
	}
}

func TestMixGraphWithoutASongUsesSilence(t *testing.T) {
	doc := mixDocAudio(Clip{ID: "x1", StartMs: 0, EndMs: 4000})
	doc.Song = nil
	inputs, graph := buildMixGraph(doc, allAudio)
	if len(inputs) != 2 || inputs[0].Path != "anullsrc=r=48000:cl=stereo" || !slices.Equal(inputs[0].Pre, []string{"-f", "lavfi", "-t", "4"}) {
		t.Fatalf("inputs = %+v", inputs)
	}
	if !strings.Contains(graph, "[song][c1]amix=inputs=2") {
		t.Errorf("graph:\n%s", graph)
	}
}

func TestClipFades(t *testing.T) {
	cases := []struct {
		name    string
		c       Clip
		outLen  float64
		in, out float64
	}{
		{"default de-click", Clip{}, 1000, 10, 10},
		{"too short for the de-click", Clip{}, 15, 0, 0},
		{"own fades", Clip{FadeInMs: 500, FadeOutMs: 250}, 2000, 500, 250},
		{"only a fade in", Clip{FadeInMs: 500}, 2000, 500, 10},
		{"capped at the clip", Clip{FadeInMs: 9000, FadeOutMs: 9000}, 2000, 2000, 2000},
		{"own fade on a short clip", Clip{FadeInMs: 5}, 15, 5, 0},
	}
	for _, tc := range cases {
		in, out := clipFades(tc.c, tc.outLen)
		if in != tc.in || out != tc.out {
			t.Errorf("%s: %v/%v, want %v/%v", tc.name, in, out, tc.in, tc.out)
		}
	}
}

func TestAudibleClips(t *testing.T) {
	doc := mixDocAudio(Clip{ID: "x1", StartMs: 0, EndMs: 1000})
	doc.Tracks[0].Clips = []Clip{
		{ID: "v1", Kind: "video", Path: "/clips/a.mov", StartMs: 0, EndMs: 1000, Volume: 1},
		{ID: "v2", Kind: "image", Path: "/clips/b.jpg", StartMs: 1000, EndMs: 2000, Volume: 1},
		{ID: "v3", Kind: "video", Path: "/clips/c.mov", StartMs: 2000, EndMs: 3000, Volume: 0},
	}
	doc.Tracks = append(doc.Tracks, Track{ID: "adj", Kind: "adjust", Clips: []Clip{{ID: "j1", Kind: "adjust", StartMs: 0, EndMs: 1000, Volume: 1}}})
	var ids []string
	for _, c := range audibleClips(doc) {
		ids = append(ids, c.ID)
	}
	if !slices.Equal(ids, []string{"v1", "x1"}) {
		t.Errorf("audible = %v", ids)
	}
}
