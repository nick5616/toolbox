package trimmer

import (
	"strings"
	"testing"

	"toolbox/core/media"
)

func videoInfo() media.Info {
	return media.Info{DurationMs: 60000, Video: &media.VideoStream{Width: 1920, Height: 1080}, Audio: []media.AudioStream{{}}}
}

func audioInfo() media.Info {
	return media.Info{DurationMs: 60000, Audio: []media.AudioStream{{}}}
}

func opt(f func(*Options)) Options {
	o := DefaultOptions()
	o.Segments = []Segment{{1000, 5000}}
	if f != nil {
		f(&o)
	}
	return o
}

func TestValidateAgainst(t *testing.T) {
	tests := []struct {
		name string
		o    Options
		info media.Info
		want string // substring of the error, "" = ok
	}{
		{"ok fast", opt(nil), videoInfo(), ""},
		{"ok precise all", opt(func(o *Options) {
			o.Mode, o.Aspect, o.MaxSizeMB, o.MaxHeight = ModePrecise, AspectPortrait, 50, 720
		}), videoInfo(), ""},
		{"no segments", opt(func(o *Options) { o.Segments = nil }), videoInfo(), "between 1 and 50"},
		{"51 segments", opt(func(o *Options) {
			o.Segments = nil
			for i := range 51 {
				o.Segments = append(o.Segments, Segment{int64(i) * 1000, int64(i)*1000 + 500})
			}
		}), videoInfo(), "between 1 and 50"},
		{"too short", opt(func(o *Options) { o.Segments = []Segment{{0, 99}} }), videoInfo(), "shorter"},
		{"min length ok", opt(func(o *Options) { o.Segments = []Segment{{0, 100}} }), videoInfo(), ""},
		{"negative start", opt(func(o *Options) { o.Segments = []Segment{{-5, 1000}} }), videoInfo(), "before the beginning"},
		{"unsorted", opt(func(o *Options) { o.Segments = []Segment{{5000, 6000}, {1000, 2000}} }), videoInfo(), "overlaps"},
		{"overlap", opt(func(o *Options) { o.Segments = []Segment{{1000, 3000}, {2000, 4000}} }), videoInfo(), "overlaps"},
		{"touching ok", opt(func(o *Options) { o.Segments = []Segment{{1000, 3000}, {3000, 4000}} }), videoInfo(), ""},
		{"past end", opt(func(o *Options) { o.Segments = []Segment{{59000, 60001}} }), videoInfo(), "after the end"},
		{"to end ok", opt(func(o *Options) { o.Segments = []Segment{{59000, 60000}} }), videoInfo(), ""},
		{"bad mode", opt(func(o *Options) { o.Mode = "x" }), videoInfo(), "Fast or Precise"},
		{"bad join", opt(func(o *Options) { o.Join = "x" }), videoInfo(), "join"},
		{"bad aspect", opt(func(o *Options) { o.Mode, o.Aspect = ModePrecise, "3:2" }), videoInfo(), "frame shape"},
		{"crop out of range", opt(func(o *Options) { o.CropX = 1.1 }), videoInfo(), "crop"},
		{"crop negative y", opt(func(o *Options) { o.CropY = -0.1 }), videoInfo(), "crop"},
		{"size 0 ok", opt(func(o *Options) { o.MaxSizeMB = 0 }), videoInfo(), ""},
		{"size 4001", opt(func(o *Options) { o.Mode, o.MaxSizeMB = ModePrecise, 4001 }), videoInfo(), "between 1 and 4000"},
		{"size -1", opt(func(o *Options) { o.Mode, o.MaxSizeMB = ModePrecise, -1 }), videoInfo(), "between 1 and 4000"},
		{"height 600", opt(func(o *Options) { o.Mode, o.MaxHeight = ModePrecise, 600 }), videoInfo(), "maximum height"},
		{"fast + aspect", opt(func(o *Options) { o.Aspect = AspectSquare }), videoInfo(), "need Precise mode"},
		{"fast + size", opt(func(o *Options) { o.MaxSizeMB = 20 }), videoInfo(), "need Precise mode"},
		{"fast + height", opt(func(o *Options) { o.MaxHeight = 720 }), videoInfo(), "need Precise mode"},
		{"audio crop", opt(func(o *Options) { o.Mode, o.Aspect = ModePrecise, AspectSquare }), audioInfo(), "needs a video"},
		{"audio removeAudio", opt(func(o *Options) { o.RemoveAudio = true }), audioInfo(), "no video to keep"},
		{"video removeAudio ok", opt(func(o *Options) { o.RemoveAudio = true }), videoInfo(), ""},
		{"audio size", opt(func(o *Options) { o.Mode, o.MaxSizeMB = ModePrecise, 5 }), audioInfo(), "need a video"},
		{"too long for size", opt(func(o *Options) {
			o.Mode, o.MaxSizeMB = ModePrecise, 1
			o.Segments = []Segment{{0, 60000}}
		}), videoInfo(), "too long to fit in 1 MB"},
		{"separate checks per segment", opt(func(o *Options) {
			o.Mode, o.MaxSizeMB, o.Join = ModePrecise, 1, JoinSeparate
			o.Segments = []Segment{{0, 5000}, {6000, 11000}}
		}), videoInfo(), ""},
	}
	for _, tc := range tests {
		err := validateAgainst(tc.o, tc.info)
		switch {
		case tc.want == "" && err != nil:
			t.Errorf("%s: unexpected %v", tc.name, err)
		case tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)):
			t.Errorf("%s: err = %v, want %q", tc.name, err, tc.want)
		}
	}
}
