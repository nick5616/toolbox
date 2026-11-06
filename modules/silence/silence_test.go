package silence

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"toolbox/core"
)

func TestParseSilenceDetect(t *testing.T) {
	log := `Input #0, wav, from 'x.wav':
[silencedetect @ 0000021] silence_start: 1.5
[silencedetect @ 0000021] silence_end: 3.25 | silence_duration: 1.75
[silencedetect @ 0000021] silence_start: -0.0021
[silencedetect @ 0000021] silence_end: 0.5 | silence_duration: 0.5
size=N/A time=00:00:10.00 bitrate=N/A speed= 300x
[silencedetect @ 0000021] silence_start: 8.8
`
	got, err := ParseSilenceDetect(strings.NewReader(log), 10_000)
	if err != nil {
		t.Fatal(err)
	}
	want := []Range{{1500, 3250}, {0, 500}, {8800, 10_000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// An unfinished silence with unknown duration is dropped.
	got, _ = ParseSilenceDetect(strings.NewReader("silence_start: 4\n"), 0)
	if len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestPlan(t *testing.T) {
	tests := []struct {
		name          string
		silences      []Range
		dur           int64
		pad           int
		removed, kept []Range
	}{
		{"padding shrinks the cut", []Range{{2000, 4000}}, 10_000, 150, []Range{{2150, 3850}}, []Range{{0, 2150}, {3850, 10_000}}},
		{"leading silence keeps no outer padding", []Range{{0, 1000}}, 5000, 200, []Range{{0, 800}}, []Range{{800, 5000}}},
		{"trailing silence", []Range{{4000, 5000}}, 5000, 200, []Range{{4200, 5000}}, []Range{{0, 4200}}},
		{"silence shorter than twice the padding is not cut", []Range{{1000, 1200}}, 5000, 150, []Range{}, []Range{{0, 5000}}},
		{"overlaps merge", []Range{{3000, 4000}, {1000, 3200}}, 8000, 0, []Range{{1000, 4000}}, []Range{{0, 1000}, {4000, 8000}}},
		{"everything silent", []Range{{0, 3000}}, 3000, 100, []Range{{0, 3000}}, []Range{}},
		{"sliver between cuts merges them", []Range{{1000, 2000}, {2010, 3000}}, 6000, 0, []Range{{1000, 3000}}, []Range{{0, 1000}, {3000, 6000}}},
		{"out of range is clamped", []Range{{-50, 100}, {900, 2000}}, 1000, 0, []Range{{0, 100}, {900, 1000}}, []Range{{100, 900}}},
		{"no silences", nil, 1000, 100, []Range{}, []Range{{0, 1000}}},
		{"no duration", []Range{{0, 10}}, 0, 0, []Range{}, []Range{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rm, kp := Plan(tc.silences, tc.dur, tc.pad)
			if !reflect.DeepEqual(rm, tc.removed) || !reflect.DeepEqual(kp, tc.kept) {
				t.Fatalf("removed %v kept %v; want %v %v", rm, kp, tc.removed, tc.kept)
			}
		})
	}
}

func TestCheck(t *testing.T) {
	if err := check(nil, []Range{{0, 1000}}); err == nil || !strings.Contains(core.AsAppError(err).Message, "nothing silent") {
		t.Fatalf("got %v", err)
	}
	if err := check([]Range{{0, 1000}}, nil); err == nil || !strings.Contains(core.AsAppError(err).Message, "nothing would be left") {
		t.Fatalf("got %v", err)
	}
	if err := check([]Range{{0, 10}}, []Range{{10, 20}}); err != nil {
		t.Fatal(err)
	}
}

func TestBuildGraphAudio(t *testing.T) {
	kept := []Range{{0, 2000}, {3000, 5000}, {6000, 6030}}
	g := BuildGraph(kept, false, true, 20)
	for _, want := range []string{
		"[0:a]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS[a0];",
		"[0:a]atrim=start=3.000:end=5.000,asetpts=PTS-STARTPTS[a1];",
		"[a0][a1]acrossfade=d=0.020:c1=tri:c2=tri[x1];",
		"[x1][a2]acrossfade=d=0.015:c1=tri:c2=tri[a]\n", // limited to half of the 30 ms piece
	} {
		if !strings.Contains(g, want) {
			t.Errorf("graph lacks %q:\n%s", want, g)
		}
	}
	if strings.HasSuffix(g, ";\n") {
		t.Errorf("trailing separator:\n%s", g)
	}
	if got := BuildGraph(kept[:1], false, true, 20); got != "[0:a]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS[a0];\n[a0]anull[a]\n" {
		t.Errorf("single piece: %q", got)
	}
	if g := BuildGraph(kept, false, true, 0); !strings.Contains(g, "concat=n=2:v=0:a=1") || strings.Contains(g, "acrossfade") {
		t.Errorf("no crossfade should concat:\n%s", g)
	}
}

func TestBuildGraphVideo(t *testing.T) {
	kept := []Range{{0, 2000}, {3000, 5000}}
	g := BuildGraph(kept, true, true, 20)
	for _, want := range []string{
		"[0:v]trim=start=0.000:end=2.000,setpts=PTS-STARTPTS[v0];",
		"[0:a]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS,afade=t=out:st=1.990:d=0.010[a0];",
		"[0:a]atrim=start=3.000:end=5.000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.010[a1];",
		"[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]\n",
	} {
		if !strings.Contains(g, want) {
			t.Errorf("graph lacks %q:\n%s", want, g)
		}
	}
	if g := BuildGraph(kept, true, false, 20); !strings.Contains(g, "[v0][v1]concat=n=2:v=1:a=0[v]") || strings.Contains(g, "atrim") {
		t.Errorf("video-only graph:\n%s", g)
	}
	if BuildGraph(nil, true, true, 0) != "" || BuildGraph(kept, false, false, 0) != "" {
		t.Error("empty inputs should give an empty graph")
	}
}

func TestCutListCSV(t *testing.T) {
	got := CutListCSV([]Range{{1000, 2500}}, []Range{{0, 1000}, {2500, 4000}})
	want := "type,start_s,end_s,length_s\nkept,0.000,1.000,1.000\nremoved,1.000,2.500,1.500\nkept,2.500,4.000,1.500\n"
	if got != want {
		t.Fatalf("got %q", got)
	}
}

func TestOptionsValidate(t *testing.T) {
	if err := DefaultOptions().Validate(); err != nil {
		t.Fatal(err)
	}
	bad := []func(*Options){
		func(o *Options) { o.ThresholdDb = -5 },
		func(o *Options) { o.ThresholdDb = -90 },
		func(o *Options) { o.MinSilenceMs = 50 },
		func(o *Options) { o.PaddingMs = 5000 },
		func(o *Options) { o.CrossfadeMs = -1 },
	}
	for i, f := range bad {
		o := DefaultOptions()
		f(&o)
		if o.Validate() == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestAnalysisOf(t *testing.T) {
	a := analysisOf([]Range{{1000, 3000}}, 10_000, 100)
	if a.RemovedMs != 1800 || a.KeptMs != 8200 || len(a.Silences) != 1 {
		t.Fatalf("%+v", a)
	}
	if a := analysisOf(nil, 1000, 0); a.Silences == nil || a.Removed == nil || a.Kept == nil {
		t.Fatalf("slices must be non-nil: %+v", a)
	}
}

func TestPipeline(t *testing.T) {
	m := &Module{}
	info, err := m.DescribeStep(nil)
	if err != nil {
		t.Fatal(err)
	}
	roles := map[string]bool{}
	for _, p := range info.Produces {
		roles[p.Role] = true
	}
	vars := map[string]bool{}
	for _, v := range info.Vars {
		vars[v.Name] = true
	}
	if !roles["cut"] || !roles["cutlist"] || !vars["removed_s"] || !vars["kept_s"] {
		t.Fatalf("%+v", info)
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"thresholdDb":-3}`)); err == nil {
		t.Error("bad threshold accepted")
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"nope":1}`)); err == nil {
		t.Error("unknown field accepted")
	}
	if _, err := m.PrepareStep(nil, core.StepRequest{}); err == nil {
		t.Error("no files accepted")
	}

	res, err := m.StepOutputs(core.Job{
		ResultJSON: `{"output":"/o/a (cut).mp4","removedMs":12345,"keptMs":6789}`,
		Outputs: []core.Output{
			{Path: `/o/a (cut).mp4`, Name: "a (cut).mp4", Kind: core.KindVideo},
			{Path: `/o/a (cut list).csv`, Name: "a (cut list).csv", Kind: core.KindOther},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 || res.Files[0].Role != "cut" || res.Files[1].Role != "cutlist" {
		t.Fatalf("%+v", res.Files)
	}
	if res.Vars["removed_s"] != "12.3" || res.Vars["kept_s"] != "6.8" {
		t.Fatalf("%v", res.Vars)
	}
}

func TestValidate(t *testing.T) {
	m := &Module{}
	if err := m.Validate(nil, nil); err == nil {
		t.Error("no inputs accepted")
	}
	if err := m.Validate([]string{"/x/notes.txt"}, nil); err == nil {
		t.Error("text file accepted")
	}
}
