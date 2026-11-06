package scenes

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
)

const cannedScores = `frame:0    pts:0       pts_time:0
lavfi.scene_score=0.000000
frame:1    pts:1000    pts_time:1
lavfi.scene_score=0.010000
frame:2    pts:2000    pts_time:2
lavfi.scene_score=0.030000
frame:3    pts:3000    pts_time:3
lavfi.scene_score=0.650000
frame:4    pts:4000    pts_time:4
lavfi.scene_score=0.200000
frame:5    pts:4500    pts_time:4.5
lavfi.scene_score=0.700000
frame:6    pts:5000    pts_time:5
lavfi.scene_score=0.020000
garbage line
frame:7    pts:7000    pts_time:7
lavfi.scene_score=nan
frame:8    pts:8000    pts_time:8
lavfi.scene_score=0.610000
frame:9    pts:9000    pts_time:9
lavfi.scene_score=0.040000
`

func TestParseScores(t *testing.T) {
	got := parseScores(cannedScores)
	if len(got) != 9 { // the nan score is dropped
		t.Fatalf("len = %d, want 9: %+v", len(got), got)
	}
	if got[3].ms != 3000 || got[3].score != 0.65 {
		t.Errorf("frame 3 = %+v", got[3])
	}
	if got[5].ms != 4500 {
		t.Errorf("fractional pts_time = %d, want 4500", got[5].ms)
	}
	if n := len(parseScores("")); n != 0 {
		t.Errorf("empty input gave %d frames", n)
	}
}

func TestBuildScenes(t *testing.T) {
	frames := parseScores(cannedScores)
	tests := []struct {
		name   string
		thresh float64
		minMs  int64
		want   [][2]int64
	}{
		// cuts at 3, 4.5, 8 (0.2 at 4 is below the threshold)
		{"all cuts", 0.5, 0, [][2]int64{{0, 3000}, {3000, 4500}, {4500, 8000}, {8000, 10000}}},
		// 3–4.5 is 1.5 s: merges into the scene before it
		{"min length merges short scene back", 0.5, 2000, [][2]int64{{0, 4500}, {4500, 8000}, {8000, 10000}}},
		{"high threshold", 0.9, 0, [][2]int64{{0, 10000}}},
		{"low threshold adds the 0.2 cut", 0.1, 0, [][2]int64{{0, 3000}, {3000, 4000}, {4000, 4500}, {4500, 8000}, {8000, 10000}}},
		{"short first scene merges forward, short last back", 0.5, 3500, [][2]int64{{0, 4500}, {4500, 10000}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildScenes(append([]frameScore{}, frames...), tt.thresh, tt.minMs, 0, 10000)
			var spans [][2]int64
			for i, s := range got {
				spans = append(spans, [2]int64{s.StartMs, s.EndMs})
				if s.N != i+1 {
					t.Errorf("scene %d has N = %d", i, s.N)
				}
			}
			if !reflect.DeepEqual(spans, tt.want) {
				t.Errorf("spans = %v, want %v", spans, tt.want)
			}
		})
	}
	if got := buildScenes(nil, 0.3, 0, 0, 0); len(got) != 0 {
		t.Errorf("zero duration gave %d scenes", len(got))
	}
	if got := buildScenes(nil, 0.3, 1000, 0, 5000); len(got) != 1 || got[0].EndMs != 5000 {
		t.Errorf("no frames: %+v", got)
	}
}

func TestMotionIsMeanOfInnerFrames(t *testing.T) {
	got := buildScenes(parseScores(cannedScores), 0.5, 0, 0, 10000)
	// scene 1 holds frames at 1 s (0.01) and 2 s (0.03)
	if m := got[0].Motion; m < 0.0199 || m > 0.0201 {
		t.Errorf("motion = %v, want 0.02", m)
	}
	if got[1].Motion < 0.19 || got[1].Motion > 0.21 { // frame at 4 s
		t.Errorf("motion = %v, want 0.2", got[1].Motion)
	}
}

func TestKeepScenes(t *testing.T) {
	all := []Scene{
		{N: 1, StartMs: 0, EndMs: 1000, Motion: 0.1},
		{N: 2, StartMs: 1000, EndMs: 5000, Motion: 0.05},
		{N: 3, StartMs: 5000, EndMs: 7000, Motion: 0.4},
		{N: 4, StartMs: 7000, EndMs: 10000, Motion: 0.3},
	}
	ns := func(s []Scene) []int {
		var o []int
		for _, x := range s {
			o = append(o, x.N)
		}
		return o
	}
	tests := []struct {
		keep Keep
		n    int
		want []int
	}{
		{KeepAll, 1, []int{1, 2, 3, 4}},
		{KeepLongest, 2, []int{2, 4}},
		{KeepActive, 2, []int{3, 4}},
		{KeepLongest, 9, []int{1, 2, 3, 4}},
		{KeepActive, 1, []int{3}},
	}
	for _, tt := range tests {
		if got := ns(keepScenes(all, tt.keep, tt.n)); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("%s %d: %v, want %v", tt.keep, tt.n, got, tt.want)
		}
	}
}

func TestOnKeyframe(t *testing.T) {
	kf := []int64{0, 2000, 4000}
	tests := []struct {
		ms   int64
		want bool
	}{{0, true}, {1950, true}, {2060, true}, {2200, false}, {3000, false}, {4079, true}, {4200, false}}
	for _, tt := range tests {
		if got := onKeyframe(kf, tt.ms, keyframeTolMs); got != tt.want {
			t.Errorf("onKeyframe(%d) = %v", tt.ms, got)
		}
	}
	if onKeyframe(nil, 0, keyframeTolMs) {
		t.Error("no keyframes should not match")
	}
}

func TestArgs(t *testing.T) {
	a := strings.Join(detectArgs("in.mp4"), " ")
	for _, want := range []string{"-i in.mp4", "select='gte(scene,0)'", "metadata=print:file=scores.txt", "-f null -"} {
		if !strings.Contains(a, want) {
			t.Errorf("detect args %q lack %q", a, want)
		}
	}
	if strings.Contains(a, `\`) || strings.Contains(a, ":/") {
		t.Errorf("detect filter holds a path: %q", a)
	}
	c := strings.Join(copyClipArgs("in.mp4", "o.mp4", 1500, 4000), " ")
	if !strings.Contains(c, "-ss 1.500 -to 4.000 -i in.mp4") || !strings.Contains(c, "-c copy") {
		t.Errorf("copy args: %q", c)
	}
	e := strings.Join(encodeClipArgs("in.mp4", "o.mp4", 1500, 4000), " ")
	if !strings.Contains(e, "-t 2.500") || !strings.Contains(e, "libx264") || !strings.Contains(e, "aac") {
		t.Errorf("encode args: %q", e)
	}
	s := strings.Join(stillArgs("in.mp4", "o.jpg", 2750), " ")
	if !strings.Contains(s, "-ss 2.750") || !strings.Contains(s, "-frames:v 1") {
		t.Errorf("still args: %q", s)
	}
	if copyExt(".MTS") != ".ts" || copyExt(".MOV") != ".mov" {
		t.Error("copyExt")
	}
	if sceneName("Clip", 7) != "Clip (scene 007)" {
		t.Errorf("sceneName = %q", sceneName("Clip", 7))
	}
}

func TestValidate(t *testing.T) {
	dir := t.TempDir()
	file := writeFile(t, dir, "a.mp4")
	m := &Module{}
	good := DefaultOptions()
	tests := []struct {
		name   string
		inputs []string
		mod    func(*Options)
		msg    string
	}{
		{"ok", []string{file}, func(*Options) {}, ""},
		{"two files", []string{file, file}, func(*Options) {}, "Choose one video to split"},
		{"threshold low", []string{file}, func(o *Options) { o.Threshold = 0 }, "Sensitivity must be between 0.05 and 0.9"},
		{"min length", []string{file}, func(o *Options) { o.MinSceneSecs = 100 }, "The shortest scene must be between 0.2 and 60 seconds"},
		{"output", []string{file}, func(o *Options) { o.Output = "gif" }, "Choose clips, stills or both"},
		{"keep", []string{file}, func(o *Options) { o.Keep = "none" }, "Choose which scenes to keep"},
		{"keepN", []string{file}, func(o *Options) { o.Keep = KeepLongest; o.KeepN = 0 }, "Keep between 1 and 200 scenes"},
		{"keepN ignored for all", []string{file}, func(o *Options) { o.KeepN = 0 }, ""},
		{"not video", []string{writeFile(t, dir, "a.mp3")}, func(*Options) {}, "x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := good
			tt.mod(&o)
			raw, _ := json.Marshal(o)
			err := m.Validate(tt.inputs, raw)
			switch {
			case tt.msg == "" && err != nil:
				t.Fatalf("unexpected %v", err)
			case tt.msg == "x" && err == nil:
				t.Fatal("expected an error")
			case tt.msg != "" && tt.msg != "x" && (err == nil || core.AsAppError(err).Message != tt.msg):
				t.Fatalf("err = %v, want %q", err, tt.msg)
			}
		})
	}
}

func TestDescribeStep(t *testing.T) {
	m := &Module{}
	info, err := m.DescribeStep(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 1 || info.Produces[0].Role != "still" || !info.Produces[0].Many {
		t.Errorf("default produces = %+v", info.Produces)
	}
	info, err = m.DescribeStep(json.RawMessage(`{"output":"both","keep":"longest","keepN":3}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Produces) != 2 || info.Produces[0].Role != "scene" || info.Produces[1].Role != "still" {
		t.Errorf("produces = %+v", info.Produces)
	}
	if info.Summary != "Clips + stills · sensitivity 0.3 · 3 longest" {
		t.Errorf("summary = %q", info.Summary)
	}
	for _, bad := range []string{`{"threshold":2}`, `{"nope":1}`, `{"keep":"longest","keepN":0}`} {
		if _, err := m.DescribeStep(json.RawMessage(bad)); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestPrepareStepAndOutputs(t *testing.T) {
	dir := t.TempDir()
	file := writeFile(t, dir, "a.mp4")
	m := &Module{}
	jobs, err := m.PrepareStep(t.Context(), core.StepRequest{Item: core.StepItem{Files: []core.RunFile{{Path: file}}}})
	if err != nil || len(jobs) != 1 || jobs[0].Inputs[0] != file {
		t.Fatalf("jobs = %+v, err = %v", jobs, err)
	}
	if o, ok := jobs[0].Options.(Options); !ok || o.Output != OutputStills {
		t.Errorf("options = %#v", jobs[0].Options)
	}
	if _, err := m.PrepareStep(t.Context(), core.StepRequest{}); err == nil {
		t.Error("no files accepted")
	}

	res, err := m.StepOutputs(core.Job{
		Outputs:    []core.Output{{Path: "/o/a (scene 001).mp4", Kind: core.KindVideo}, {Path: "/o/a (scene 001).jpg", Kind: core.KindImage}},
		ResultJSON: `{"found":5,"scenes":[{"n":1},{"n":3}]}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 || res.Files[0].Role != "scene" || res.Files[1].Role != "still" {
		t.Errorf("files = %+v", res.Files)
	}
	if res.Vars["scene"] != "2" || res.Vars["scene_total"] != "5" {
		t.Errorf("vars = %v", res.Vars)
	}
}
