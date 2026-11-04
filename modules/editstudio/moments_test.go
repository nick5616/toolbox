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
	scores := make([]float64, 300) // 10 s at 30 fps, a duplicate-frame saw tooth
	for i := range scores {
		if i%6 == 5 {
			scores[i] = 0
		} else if i%6 == 0 {
			scores[i] = 0.06
		} else {
			scores[i] = 0.02
		}
	}
	for i := 148; i <= 152; i++ {
		scores[i] = 0.4 // a burst at 5 s
	}
	got := pickMoments(motionCurve{FPS: 30, Scores: scores}, []int64{2000})
	if len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	if got[0].Ms != 2000 || got[0].Kind != "cut" {
		t.Errorf("first = %+v", got[0])
	}
	if d := got[1].Ms - 5000; got[1].Kind != "motion" || d > 100 || d < -100 || got[1].Strength <= 0 || got[1].Strength > 1 {
		t.Errorf("second = %+v", got[1])
	}
	if len(pickMoments(motionCurve{}, nil)) != 0 {
		t.Error("empty curve should give none")
	}
}
