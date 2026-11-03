package editstudio

import (
	"context"
	"slices"
	"strings"
	"testing"
)

func TestParseShots(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		want  []int64
	}{
		{"none", nil, []int64{}},
		{"metadata print output", []string{
			"frame:11   pts:11      pts_time:0.366667",
			"lavfi.scene_score=0.512",
			"frame:60   pts:60      pts_time:2",
			"lavfi.scene_score=0.9",
		}, []int64{367, 2000}},
		{"cuts closer than 500 ms to the previous are dropped", []string{
			"frame:30 pts:30 pts_time:1.0",
			"frame:45 pts:45 pts_time:1.499", // 499 ms after → dropped
			"frame:46 pts:46 pts_time:1.5",   // 500 ms after the kept cut → kept
			"frame:50 pts:50 pts_time:1.8",   // dropped
			"frame:90 pts:90 pts_time:3.0",
		}, []int64{1000, 1500, 3000}},
		{"noise lines are ignored", []string{"hello", "pts_time:abc", "frame:1 pts:1 pts_time:0.5"}, []int64{500}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseShots(tc.lines); !slices.Equal(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestShotArgs(t *testing.T) {
	joined := strings.Join(shotArgs("in.h264", 30), " ")
	for _, want := range []string{"-f h264 -framerate 30 -i in.h264", `-vf select='gt(scene,0.3)',metadata=print:file=-`, "-an -f null -"} {
		if !strings.Contains(joined, want) {
			t.Errorf("%q missing from %s", want, joined)
		}
	}
}

func TestEnsureShotsCaches(t *testing.T) {
	m := newTestModule(t)
	ff := installFakes(t)
	ff.scenes = []string{"frame:30 pts:30 pts_time:1.0"}
	src := srcFile(t, "a.mov")
	var rec recorder
	job := newJob(t, t.TempDir(), Options{}, &rec, fakeTools())
	if m.ShotsFor(src) != nil {
		t.Fatal("not made yet")
	}
	got, err := m.EnsureShots(context.Background(), job, src, 30)
	if err != nil || !slices.Equal(got, []int64{1000}) {
		t.Fatalf("%v %v", got, err)
	}
	calls := ff.count()
	if calls != 2 { // the preview stream, then the scan
		t.Errorf("%d calls", calls)
	}
	if again, err := m.EnsureShots(context.Background(), job, src, 30); err != nil || !slices.Equal(again, []int64{1000}) || ff.count() != calls {
		t.Errorf("cached: %v %v, %d calls", again, err, ff.count())
	}
	if got := m.ShotsFor(src); !slices.Equal(got, []int64{1000}) {
		t.Errorf("ShotsFor = %v", got)
	}
	// A clip with no cuts caches an empty list, distinct from "not made".
	ff.scenes = nil
	src2 := srcFile(t, "b.mov")
	if got, err := m.EnsureShots(context.Background(), job, src2, 30); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("%v %v", got, err)
	}
	if got := m.ShotsFor(src2); got == nil || len(got) != 0 {
		t.Errorf("ShotsFor = %#v, want an empty non-nil list", got)
	}
}
