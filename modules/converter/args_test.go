package converter

import (
	"slices"
	"testing"
)

func TestBuildArgsEveryPreset(t *testing.T) {
	for _, p := range presets {
		for _, keep := range []bool{true, false} {
			opts := Options{Preset: p.ID, MaxHeight: HeightKeep, KeepMetadata: keep}
			got := buildArgs(opts, "/in/a.x", "/tmp/out"+p.Ext)
			want := []string{"-hide_banner", "-nostdin", "-y", "-i", "/in/a.x"}
			if keep {
				want = append(want, "-map_metadata", "0")
			} else {
				want = append(want, "-map_metadata", "-1")
			}
			want = append(want, p.Args...)
			if p.Group == "Image" {
				want = append(want, "-frames:v", "1")
			}
			want = append(want, "-progress", "pipe:1", "-nostats", "/tmp/out"+p.Ext)
			if !slices.Equal(got, want) {
				t.Errorf("%s keep=%v:\n got %q\nwant %q", p.ID, keep, got, want)
			}
		}
	}
}

func TestBuildArgsScale(t *testing.T) {
	tests := []struct {
		preset Preset
		height MaxHeight
		scale  bool
	}{
		{"mp4-h264", Height720, true},
		{"webm-vp9", Height480, true},
		{"mp4-h265", HeightKeep, false},
		{"mp4-h264", "", false},
		{"mp3-320", Height720, false}, // audio ignores height
		{"png", Height720, false},     // images ignore height
	}
	for _, tt := range tests {
		got := buildArgs(Options{Preset: tt.preset, MaxHeight: tt.height}, "i", "o")
		i := slices.Index(got, "-vf")
		if tt.scale != (i >= 0) {
			t.Fatalf("%s/%s: -vf present = %v", tt.preset, tt.height, i >= 0)
		}
		if tt.scale {
			want := `scale=-2:min(ih\,` + string(tt.height) + `)`
			if got[i+1] != want {
				t.Errorf("scale = %q, want %q", got[i+1], want)
			}
		}
	}
}

func TestBuildArgsUnknownPreset(t *testing.T) {
	if got := buildArgs(Options{Preset: "nope"}, "i", "o"); got != nil {
		t.Errorf("got %q", got)
	}
}
