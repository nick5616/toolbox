package editstudio

import (
	"strings"
	"testing"
)

// audioDoc is validDoc plus an audio track holding one audio clip.
func audioDoc() EditProject {
	d := validDoc()
	d.Tracks = append(d.Tracks, Track{ID: "a1", Kind: "audio", Name: "Audio 1", Height: "l", Clips: []Clip{
		{ID: "x1", Kind: "audio", Path: "/music/voice.wav", StartMs: 500, EndMs: 4500, InMs: 100, Volume: 1,
			Gain:     `{"base":-3,"keys":[{"t":0,"v":-60,"ease":"linear"},{"t":1000,"v":0,"ease":"ease"}]}`,
			FadeInMs: 250, FadeOutMs: 10_000, Link: "pair-1"},
	}})
	return d
}

func TestValidateV2Accepts(t *testing.T) {
	cases := []struct {
		name string
		edit func(d *EditProject)
	}{
		{"audio track and clip", func(d *EditProject) {}},
		{"linked pair", func(d *EditProject) {
			d.Tracks[0].Clips[0].Link = "pair-1"
			d.Tracks[2].Clips[0].Link = "pair-1"
		}},
		{"single link", func(d *EditProject) { d.Tracks[0].Clips[0].Link = strings.Repeat("l", 40) }},
		{"solo", func(d *EditProject) { d.Tracks[2].Solo = true }},
		{"heights", func(d *EditProject) { d.Tracks[0].Height = "s"; d.Tracks[1].Height = "m" }},
		{"twelve tracks, four audio", func(d *EditProject) {
			for i := 0; len(d.Tracks) < 12; i++ {
				kind := "video"
				if len(d.Tracks) >= 8 {
					kind = "audio"
				}
				d.Tracks = append(d.Tracks, Track{ID: "x" + string(rune('a'+i)), Kind: kind})
			}
		}},
		{"gain as a number", func(d *EditProject) { d.Tracks[2].Clips[0].Gain = "-6" }},
		{"project fps 24", func(d *EditProject) { d.FPS = 24 }},
		{"project fps 25", func(d *EditProject) { d.FPS = 25 }},
		{"export height 2160", func(d *EditProject) { d.ExportHeight = 2160 }},
		{"export defaults", func(d *EditProject) { d.Export = &ExportSettings{} }},
		{"export all set", func(d *EditProject) {
			d.Export = &ExportSettings{FPS: 24, Codec: "h265", Quality: "best", AudioKbps: 320, InMs: 1000, OutMs: 5000}
		}},
		{"export range to the end", func(d *EditProject) { d.Export = &ExportSettings{InMs: 0, OutMs: 30_000} }},
		{"depth", func(d *EditProject) { d.Tracks[0].Clips[0].Depth = &DepthRef{ID: "d1", FromMs: 0, ToMs: 2000} }},
		{"size", func(d *EditProject) { d.Size = &Size{W: 1280, H: 720} }},
		{"big size", func(d *EditProject) { d.Size = &Size{W: 8192, H: 8192} }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := audioDoc()
			c.edit(&d)
			if err := validateShape(d); err != nil {
				t.Fatalf("rejected: %v", err)
			}
		})
	}
}

func TestValidateV2Rejects(t *testing.T) {
	manyKeys := `{"base":0,"keys":[` + strings.Repeat(`{"t":1,"v":0,"ease":"linear"},`, 64) + `{"t":2,"v":0,"ease":"linear"}]}`
	cases := []struct {
		name  string
		field string
		edit  func(d *EditProject)
	}{
		{"thirteen tracks", "tracks", func(d *EditProject) {
			for len(d.Tracks) < 13 {
				d.Tracks = append(d.Tracks, Track{ID: "x" + string(rune('a'+len(d.Tracks))), Kind: "audio"})
			}
		}},
		{"nine video tracks", "tracks", func(d *EditProject) {
			for i := 0; i < 7; i++ {
				d.Tracks = append(d.Tracks, Track{ID: "v" + string(rune('a'+i)), Kind: "video"})
			}
		}},
		{"unknown track kind", "tracks[0].kind", func(d *EditProject) { d.Tracks[0].Kind = "sound" }},
		{"track height", "tracks[0].height", func(d *EditProject) { d.Tracks[0].Height = "xl" }},
		{"audio clip on a video track", "tracks[0].clips[0].kind", func(d *EditProject) { d.Tracks[0].Clips[0].Kind = "audio" }},
		{"audio clip on an adjust track", "tracks[1].clips[0].kind", func(d *EditProject) { d.Tracks[1].Clips[0].Kind = "audio" }},
		{"video clip on an audio track", "tracks[2].clips[0].kind", func(d *EditProject) { d.Tracks[2].Clips[0].Kind = "video" }},
		{"adjust clip on an audio track", "tracks[2].clips[0].kind", func(d *EditProject) { d.Tracks[2].Clips[0].Kind = "adjust" }},
		{"audio clip without a file", "tracks[2].clips[0].path", func(d *EditProject) { d.Tracks[2].Clips[0].Path = "" }},
		{"gain JSON", "tracks[2].clips[0].gain", func(d *EditProject) { d.Tracks[2].Clips[0].Gain = "{" }},
		{"gain not a curve", "tracks[2].clips[0].gain", func(d *EditProject) { d.Tracks[2].Clips[0].Gain = `"loud"` }},
		{"gain base", "tracks[2].clips[0].gain", func(d *EditProject) { d.Tracks[2].Clips[0].Gain = `{"base":13}` }},
		{"gain key", "tracks[2].clips[0].gain", func(d *EditProject) {
			d.Tracks[2].Clips[0].Gain = `{"base":0,"keys":[{"t":0,"v":-61,"ease":"linear"}]}`
		}},
		{"gain keys", "tracks[2].clips[0].gain", func(d *EditProject) { d.Tracks[2].Clips[0].Gain = manyKeys }},
		{"fade in", "tracks[2].clips[0].fadeInMs", func(d *EditProject) { d.Tracks[2].Clips[0].FadeInMs = 10_001 }},
		{"fade out", "tracks[2].clips[0].fadeOutMs", func(d *EditProject) { d.Tracks[2].Clips[0].FadeOutMs = -1 }},
		{"link", "tracks[2].clips[0].link", func(d *EditProject) { d.Tracks[2].Clips[0].Link = strings.Repeat("l", 41) }},
		{"depth id", "tracks[0].clips[0].depth", func(d *EditProject) { d.Tracks[0].Clips[0].Depth = &DepthRef{ID: "a b"} }},
		{"export height", "exportHeight", func(d *EditProject) { d.ExportHeight = 1081 }},
		{"project fps", "fps", func(d *EditProject) { d.FPS = 48 }},
		{"export fps", "export.fps", func(d *EditProject) { d.Export = &ExportSettings{FPS: 48} }},
		{"export codec", "export.codec", func(d *EditProject) { d.Export = &ExportSettings{Codec: "av1"} }},
		{"export quality", "export.quality", func(d *EditProject) { d.Export = &ExportSettings{Quality: "ultra"} }},
		{"export audio", "export.audioKbps", func(d *EditProject) { d.Export = &ExportSettings{AudioKbps: 256} }},
		{"range backwards", "export.outMs", func(d *EditProject) { d.Export = &ExportSettings{InMs: 5000, OutMs: 4000} }},
		{"range negative in", "export.outMs", func(d *EditProject) { d.Export = &ExportSettings{InMs: -1, OutMs: 4000} }},
		{"range empty", "export.outMs", func(d *EditProject) {
			d.Export = &ExportSettings{InMs: 0, OutMs: 0, FPS: 24}
			d.Export.InMs = 3000
			d.Export.OutMs = 3000
		}},
		{"range past the end", "export.outMs", func(d *EditProject) { d.Export = &ExportSettings{InMs: 0, OutMs: 30_001} }},
		{"range under a frame", "export.outMs", func(d *EditProject) { d.Export = &ExportSettings{InMs: 1000, OutMs: 1020} }},
		{"range under a frame at export fps", "export.outMs", func(d *EditProject) { d.Export = &ExportSettings{FPS: 24, InMs: 1000, OutMs: 1040} }},
		{"size odd", "size", func(d *EditProject) { d.Size = &Size{W: 1281, H: 720} }},
		{"size small", "size", func(d *EditProject) { d.Size = &Size{W: 32, H: 720} }},
		{"size large", "size", func(d *EditProject) { d.Size = &Size{W: 8194, H: 720} }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := audioDoc()
			c.edit(&d)
			err := validateShape(d)
			if err == nil {
				t.Fatal("accepted")
			}
			ae := asApp(t, err)
			if _, ok := ae.Fields[c.field]; !ok {
				t.Errorf("fields %v, want %q", ae.Fields, c.field)
			}
		})
	}
}

func TestValidateVideoSize(t *testing.T) {
	for _, tc := range []struct {
		w, h int
		ok   bool
	}{{3840, 2160, true}, {2160, 3840, true}, {1080, 1920, true}, {3842, 2160, false}, {2160, 4096, false}} {
		if err := validateVideoSize(tc.w, tc.h); (err == nil) != tc.ok {
			t.Errorf("%dx%d: %v", tc.w, tc.h, err)
		}
	}
}

func TestValidatePrepareV2(t *testing.T) {
	for _, fps := range []int{24, 25, 30, 60} {
		if err := validatePrepare(PrepareRequest{Paths: []string{"/a/song.mp3", "/a/b.mov"}, FPS: fps}); err != nil {
			t.Errorf("fps %d: %v", fps, err)
		}
	}
	if validatePrepare(PrepareRequest{Paths: []string{"/a.mp3"}, FPS: 50}) == nil {
		t.Error("fps 50 accepted")
	}
}

func TestDocOutputSize(t *testing.T) {
	d := NewProject("9:16", 30, 1)
	d.ExportHeight = 2160
	if w, h := docOutputSize(d); w != 2160 || h != 3840 {
		t.Errorf("2160 9:16 = %dx%d", w, h)
	}
	d.Aspect = "16:9"
	if w, h := docOutputSize(d); w != 3840 || h != 2160 {
		t.Errorf("2160 16:9 = %dx%d", w, h)
	}
	d.Size = &Size{W: 1000, H: 500}
	if w, h := docOutputSize(d); w != 1000 || h != 500 {
		t.Errorf("Size = %dx%d", w, h)
	}
}
