package editstudio

import (
	"strings"
	"testing"
)

func TestValidateShapeAcceptsTheFixture(t *testing.T) {
	if err := validateShape(validDoc()); err != nil {
		t.Fatalf("valid doc rejected: %v", err)
	}
	if err := validateShape(NewProject("16:9", 60, 1)); err != nil {
		t.Fatalf("new project rejected: %v", err)
	}
}

func TestValidateShapeRejects(t *testing.T) {
	big := strings.Repeat("x", MaxFieldBytes)
	cases := []struct {
		name  string
		field string
		edit  func(d *EditProject)
	}{
		{"aspect", "aspect", func(d *EditProject) { d.Aspect = "2:1" }},
		{"fps", "fps", func(d *EditProject) { d.FPS = 48 }},
		{"export height", "exportHeight", func(d *EditProject) { d.ExportHeight = 480 }},
		{"background", "background", func(d *EditProject) { d.Background = "black" }},
		{"cut offset", "cutOffsetFrames", func(d *EditProject) { d.CutOffsetFrames = 4 }},
		{"song too short", "song.endMs", func(d *EditProject) { d.Song.EndMs = d.Song.StartMs + 500 }},
		{"song too long", "song.endMs", func(d *EditProject) { d.Song.EndMs = d.Song.StartMs + MaxEditMs + 1 }},
		{"gain", "song.gainDb", func(d *EditProject) { d.Song.GainDb = 13 }},
		{"fade", "song.fadeOutMs", func(d *EditProject) { d.Song.FadeOutMs = 10_001 }},
		{"unknown lane", "markers.lanes.cowbell", func(d *EditProject) { d.Markers.Lanes["cowbell"] = LaneSettings{Every: 1} }},
		{"every", "markers.lanes.kick.every", func(d *EditProject) { l := d.Markers.Lanes["kick"]; l.Every = 0; d.Markers.Lanes["kick"] = l }},
		{"nudge", "markers.lanes.kick.nudgeMs", func(d *EditProject) { l := d.Markers.Lanes["kick"]; l.NudgeMs = 300; d.Markers.Lanes["kick"] = l }},
		{"bar offset", "markers.barOffset", func(d *EditProject) { d.Markers.BarOffset = 4 }},
		{"custom id", "markers.custom[0].id", func(d *EditProject) { d.Markers.Custom = []CustomMarker{{ID: "", Ms: 1}} }},
		{"custom dup", "markers.custom[1].id", func(d *EditProject) { d.Markers.Custom = []CustomMarker{{ID: "a", Ms: 1}, {ID: "a", Ms: 2}} }},
		{"tag", "sources[0].tags", func(d *EditProject) { d.Sources[0].Tags = []string{"Hero!"} }},
		{"no tracks", "tracks", func(d *EditProject) { d.Tracks = nil }},
		{"too many tracks", "tracks", func(d *EditProject) {
			for len(d.Tracks) <= MaxTracks {
				d.Tracks = append(d.Tracks, Track{ID: "x" + string(rune('a'+len(d.Tracks))), Kind: "video"})
			}
		}},
		{"dup track", "tracks[1].id", func(d *EditProject) { d.Tracks[1].ID = "t1" }},
		{"track kind", "tracks[0].kind", func(d *EditProject) { d.Tracks[0].Kind = "music" }},
		{"dup clip", "tracks[1].clips[0].id", func(d *EditProject) { d.Tracks[1].Clips[0].ID = "c1" }},
		{"adjust on video", "tracks[0].clips[0].kind", func(d *EditProject) { d.Tracks[0].Clips[0].Kind = "adjust" }},
		{"video on adjust", "tracks[1].clips[0].kind", func(d *EditProject) { d.Tracks[1].Clips[0].Kind = "color"; d.Tracks[1].Clips[0].Color = "#ffffff" }},
		{"no path", "tracks[0].clips[0].path", func(d *EditProject) { d.Tracks[0].Clips[0].Path = "" }},
		{"color", "tracks[0].clips[2].color", func(d *EditProject) { d.Tracks[0].Clips[2].Color = "" }},
		{"empty clip", "tracks[0].clips[0].endMs", func(d *EditProject) { d.Tracks[0].Clips[0].EndMs = 0 }},
		{"overlap", "tracks[0].clips[1].startMs", func(d *EditProject) { d.Tracks[0].Clips[1].StartMs = 1500 }},
		{"in", "tracks[0].clips[0].inMs", func(d *EditProject) { d.Tracks[0].Clips[0].InMs = -1 }},
		{"volume", "tracks[0].clips[0].volume", func(d *EditProject) { d.Tracks[0].Clips[0].Volume = 3 }},
		{"fit", "tracks[0].clips[0].fit", func(d *EditProject) { d.Tracks[0].Clips[0].Fit = "stretch" }},
		{"slow", "tracks[0].clips[0].slow", func(d *EditProject) { d.Tracks[0].Clips[0].Slow = "rife" }},
		{"blend", "tracks[0].clips[0].blend", func(d *EditProject) { d.Tracks[0].Clips[0].Blend = "vivid" }},
		{"track matte", "tracks[0].matte", func(d *EditProject) { d.Tracks[0].Matte = "luma-ish" }},
		{"text clip without text", "tracks[0].clips[0].text", func(d *EditProject) { d.Tracks[0].Clips[0].Kind = "text"; d.Tracks[0].Clips[0].Path = "" }},
		{"visual clip without a visual", "tracks[0].clips[0].visual", func(d *EditProject) { d.Tracks[0].Clips[0].Kind = "visual"; d.Tracks[0].Clips[0].Path = "" }},
		{"text JSON", "tracks[0].clips[0].text", func(d *EditProject) { d.Tracks[0].Clips[0].Kind = "text"; d.Tracks[0].Clips[0].Text = "{" }},
		{"fx target", "tracks[0].clips[0].fxTarget", func(d *EditProject) { d.Tracks[0].Clips[0].FxTarget = "sky" }},
		{"bad json", "tracks[0].clips[0].effects", func(d *EditProject) { d.Tracks[0].Clips[0].Effects = "[{" }},
		{"big json", "tracks[0].clips[0].transform", func(d *EditProject) { d.Tracks[0].Clips[0].Transform = `"` + big + `"` }},
		{"matte mode", "tracks[0].clips[0].matte.mode", func(d *EditProject) { d.Tracks[0].Clips[0].Matte.Mode = "magic" }},
		{"image matte on video", "tracks[0].clips[0].matte.mode", func(d *EditProject) { d.Tracks[0].Clips[0].Matte.Mode = "image" }},
		{"matte range", "tracks[0].clips[0].matte.toMs", func(d *EditProject) { d.Tracks[0].Clips[0].Matte.ToMs = -1 }},
		{"matte click", "tracks[0].clips[0].matte.clicks", func(d *EditProject) {
			d.Tracks[0].Clips[0].Matte.Clicks = []MatteClick{{X: 2, Y: 0.5, Positive: true}}
		}},
		{"stroke", "tracks[0].clips[0].matte.stroke.px", func(d *EditProject) { d.Tracks[0].Clips[0].Matte.Stroke.Px = 41 }},
		{"stroke colour", "tracks[0].clips[0].matte.stroke.color", func(d *EditProject) { d.Tracks[0].Clips[0].Matte.Stroke.Color = "red" }},
		{"look", "look", func(d *EditProject) { d.Look = "{" }},
		{"caption lines", "captions.lines", func(d *EditProject) { d.Captions.Lines = "[" }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := validDoc()
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

func TestValidateRequests(t *testing.T) {
	ok := []error{
		validateAnalyze(AnalyzeRequest{Song: "/a.mp3", Words: "detect"}),
		validateAnalyze(AnalyzeRequest{Song: "/a.mp3", Words: "align", LyricsText: "la la"}),
		validatePrepare(PrepareRequest{Paths: []string{"/a.mov"}, FPS: 30}),
		validateInterp(InterpRequest{Path: "/a.mov", FromMs: 0, ToMs: 30_000, FPS: 60}),
		validateMatte(MatteRequest{ClipID: "c1", MatteID: "m1", Mode: "people", Path: "/a.mov", FromMs: 0, ToMs: 1000}),
		validateMatte(MatteRequest{ClipID: "c1", MatteID: "m1", Mode: "image", Path: "/a.jpg"}),
		validateMatte(MatteRequest{ClipID: "c1", MatteID: "m1", Mode: "select", Path: "/a.mov", FromMs: 0, ToMs: 1000,
			Clicks: []MatteClick{{Ms: 0, X: 0.5, Y: 0.5, Positive: true}}, Preview: true}),
		validateText(TextRequest{Kind: "srt", Name: "x", Cues: make([]lineT, 1)}),
		validateText(TextRequest{Kind: "markers-csv", Name: "x", Markers: []MarkerRow{{Lane: "kick"}}}),
	}
	for i, err := range ok {
		if err != nil {
			t.Errorf("ok case %d: %v", i, err)
		}
	}
	bad := []error{
		validateAnalyze(AnalyzeRequest{}),
		validateAnalyze(AnalyzeRequest{Song: "/a.mp3", Words: "align"}),
		validateAnalyze(AnalyzeRequest{Song: "/a.mp3", Words: "file"}),
		validatePrepare(PrepareRequest{FPS: 30}),
		validatePrepare(PrepareRequest{Paths: []string{"/a"}, FPS: 48}),
		validateInterp(InterpRequest{Path: "/a.mov", FromMs: 0, ToMs: 30_001, FPS: 30}),
		validateMatte(MatteRequest{ClipID: "c1", MatteID: "m1", Mode: "select", Path: "/a.mov", FromMs: 0, ToMs: 1000}),
		validateMatte(MatteRequest{ClipID: "c1", MatteID: "m1", Mode: "select", Path: "/a.mov", FromMs: 0, ToMs: 61_000,
			Clicks: []MatteClick{{X: 0.5, Y: 0.5, Positive: true}}}),
		validateMatte(MatteRequest{ClipID: "c1", MatteID: "m1", Mode: "select", Path: "/a.mov", FromMs: 0, ToMs: 1000,
			Clicks: []MatteClick{{X: 0.5, Y: 0.5}}}),
		validateMatte(MatteRequest{ClipID: "c1", MatteID: "m1", Mode: "people", Path: "/a.mov", FromMs: 0, ToMs: 1000, Preview: true}),
		validateMatte(MatteRequest{ClipID: "c 1", MatteID: "m1", Mode: "people", Path: "/a.mov", ToMs: 1}),
		validateText(TextRequest{Kind: "pdf", Name: "x"}),
		validateText(TextRequest{Kind: "srt", Name: "x"}),
		validateText(TextRequest{Kind: "markers-json", Name: " ", Markers: []MarkerRow{{}}}),
	}
	for i, err := range bad {
		if err == nil {
			t.Errorf("bad case %d accepted", i)
		}
	}
}
