package editstudio

import "testing"

func TestParseSceneScores(t *testing.T) {
	lines := []string{
		"frame:0    pts:0       pts_time:0",
		"lavfi.scene_score=0.000000",
		"frame:1    pts:1       pts_time:0.033",
		"lavfi.scene_score=0.512300",
		"noise",
		"lavfi.scene_score=1.7",
	}
	got := parseSceneScores(lines)
	if len(got) != 3 || got[0] != 0 || got[1] != 0.5123 || got[2] != 1 {
		t.Fatalf("got %v", got)
	}
}

func TestPickMoments(t *testing.T) {
	scores := make([]float64, 300) // 10 s at 30 fps
	for i := range scores {
		scores[i] = 0.01
	}
	scores[60] = 0.5   // a cut at 2 s
	scores[150] = 0.12 // a burst at 5 s
	scores[155] = 0.11 // too close to the burst: dropped
	scores[240] = 0.02 // too small to count
	got := pickMoments(motionCurve{FPS: 30, Scores: scores})
	if len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	if got[0].Ms != 2000 || got[0].Kind != "cut" {
		t.Errorf("first = %+v", got[0])
	}
	if got[1].Ms != 5000 || got[1].Kind != "motion" || got[1].Strength <= 0 || got[1].Strength > 1 {
		t.Errorf("second = %+v", got[1])
	}
	if len(pickMoments(motionCurve{})) != 0 {
		t.Error("empty curve should give none")
	}
}
