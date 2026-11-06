package editstudio

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
	"toolbox/core/viz"
	"toolbox/modules/videoeditor"
)

const stepOrigin = "http://wails.localhost"

type nopEmitter struct{}

func (nopEmitter) Emit(string, any) {}

func stepBroker(up bool) *viz.RenderBroker {
	b := viz.NewRenderBroker(nopEmitter{}, func(p string) (string, error) { return "/media/x/" + filepath.Base(p), nil }, "")
	b.SetAppOrigins(stepOrigin)
	if up {
		b.HandleRawMessage(viz.RawPrefix+"host|up", stepOrigin, stepOrigin)
	}
	return b
}

func vinfo(path string, ms int64) videoeditor.ClipInfo {
	return videoeditor.ClipInfo{Path: path, Kind: "video", DurationMs: ms, Width: 1920, Height: 1080, HasAudio: true}
}

func pinfo(path string) videoeditor.ClipInfo {
	return videoeditor.ClipInfo{Path: path, Kind: "image", Width: 4000, Height: 3000}
}

func rf(paths ...string) []core.RunFile {
	out := make([]core.RunFile, len(paths))
	for i, p := range paths {
		out[i] = core.RunFile{Path: p, Name: filepath.Base(p)}
	}
	return out
}

func raw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// --- assembleDoc ---------------------------------------------------------------

func TestAssembleNew(t *testing.T) {
	r := DefaultAssembleRequest()
	r.Transition, r.StillMs = "crossfade", 2000
	doc, notes, err := assembleDoc(r, nil, []videoeditor.ClipInfo{vinfo("/a.mp4", 4000), pinfo("/b.jpg"), vinfo("/c.mp4", 300)}, "", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 0 {
		t.Errorf("notes %v", notes)
	}
	clips := doc.Tracks[0].Clips
	if len(clips) != 3 {
		t.Fatalf("clips %+v", clips)
	}
	want := [][2]int64{{0, 4000}, {4000, 6000}, {6000, 6300}}
	for i, c := range clips {
		if c.StartMs != want[i][0] || c.EndMs != want[i][1] {
			t.Errorf("clip %d = %d-%d, want %v", i, c.StartMs, c.EndMs, want[i])
		}
	}
	if clips[0].In != "" || clips[1].In != `{"kind":"crossfade","ms":500}` {
		t.Errorf("transitions %q %q", clips[0].In, clips[1].In)
	}
	if clips[2].In != `{"kind":"crossfade","ms":150}` { // half of the 300 ms clip
		t.Errorf("short clip transition %q", clips[2].In)
	}
	if clips[0].Volume != 1 || clips[1].Volume != 0 {
		t.Errorf("volumes %v %v (photos are silent, camera sound stays without music)", clips[0].Volume, clips[1].Volume)
	}
	if doc.Aspect != "9:16" || doc.FPS != 30 || doc.ExportHeight != 1080 || doc.Song != nil || editLen(doc) != 6300 {
		t.Errorf("doc %+v len %d", doc, editLen(doc))
	}
	if len(doc.Sources) != 3 {
		t.Errorf("sources %+v", doc.Sources)
	}
}

func TestAssembleCutsHaveNoTransition(t *testing.T) {
	doc, _, err := assembleDoc(DefaultAssembleRequest(), nil, []videoeditor.ClipInfo{vinfo("/a.mp4", 2000), vinfo("/b.mp4", 2000)}, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range doc.Tracks[0].Clips {
		if c.In != "" {
			t.Errorf("clip %s has transition %q", c.ID, c.In)
		}
	}
}

func TestAssembleTitleAndMusic(t *testing.T) {
	r := DefaultAssembleRequest()
	r.Title, r.TitleMs = "Summer 2026", 1500
	doc, _, err := assembleDoc(r, nil, []videoeditor.ClipInfo{vinfo("/a.mp4", 1000), vinfo("/b.mp4", 5000)}, "/m/song.mp3", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Tracks) != 2 || doc.Tracks[1].Name != "Title" {
		t.Fatalf("tracks %+v", doc.Tracks)
	}
	tc := doc.Tracks[1].Clips[0]
	if tc.Kind != "text" || tc.StartMs != 0 || tc.EndMs != 1500 || !strings.Contains(tc.Text, "Summer 2026") {
		t.Errorf("title %+v", tc)
	}
	if doc.Song == nil || doc.Song.Path != "/m/song.mp3" || doc.Song.StartMs != 0 || doc.Song.EndMs != 6000 || doc.Song.FadeOutMs != 1500 {
		t.Errorf("song %+v", doc.Song)
	}
	if doc.Tracks[0].Clips[0].Volume != 0 {
		t.Error("camera sound should be off under a music bed")
	}
	// A title can't outlast a short edit.
	r.TitleMs = 10_000
	doc, _, err = assembleDoc(r, nil, []videoeditor.ClipInfo{vinfo("/a.mp4", 2000)}, "", 1)
	if err != nil || doc.Tracks[1].Clips[0].EndMs != 2000 {
		t.Errorf("long title: %v %+v", err, doc.Tracks)
	}
}

func TestAssembleRefusesBadInput(t *testing.T) {
	long := []videoeditor.ClipInfo{vinfo("/a.mp4", 400_000), vinfo("/b.mp4", 400_000)}
	if _, _, err := assembleDoc(DefaultAssembleRequest(), nil, long, "", 1); err == nil {
		t.Error("a 13 minute edit accepted")
	}
	if _, _, err := assembleDoc(DefaultAssembleRequest(), nil, []videoeditor.ClipInfo{vinfo("/z.mp4", 10)}, "", 1); err == nil {
		t.Error("a 10 ms clip accepted")
	}
	if _, _, err := assembleDoc(DefaultAssembleRequest(), nil, nil, "", 1); err == nil {
		t.Error("no clips accepted")
	}
	r := DefaultAssembleRequest()
	r.Title = strings.Repeat("x", MaxClipText+1)
	if err := validateAssemble(r); err == nil {
		t.Error("an over-long title accepted")
	}
}

func templateEdit() EditProject {
	doc := NewProject("16:9", 60, 9)
	doc.Song = &Song{Path: "/t/old.mp3", StartMs: 1000, EndMs: 9000}
	doc.AnalysisKey = "old-key"
	doc.Tracks = []Track{
		{ID: "t1", Kind: "video", Name: "Main", Clips: []Clip{
			{ID: "a", Kind: "video", Path: "/t/1.mov", StartMs: 0, EndMs: 3000, InMs: 700, Effects: `[]`, Matte: &Matte{Mode: "people", ID: "m1"}, FxTarget: "subject", Fit: "fit", Auto: true},
			{ID: "bg", Kind: "color", Color: "#112233", StartMs: 3000, EndMs: 4000},
			{ID: "b", Kind: "image", Path: "/t/2.jpg", StartMs: 4000, EndMs: 6000, In: `{"kind":"flash","ms":200}`},
			{ID: "c", Kind: "video", Path: "/t/3.mov", StartMs: 6000, EndMs: 8000, In: `{"kind":"flash","ms":200}`},
		}},
		{ID: "fx", Kind: "adjust", Name: "FX", Clips: []Clip{{ID: "f1", Kind: "adjust", StartMs: 0, EndMs: 8000, Effects: `[]`}}},
	}
	return doc
}

func TestAssembleIntoTemplate(t *testing.T) {
	tmpl := templateEdit()
	r := DefaultAssembleRequest()
	doc, notes, err := assembleDoc(r, &tmpl, []videoeditor.ClipInfo{pinfo("/n/x.jpg"), vinfo("/n/y.mp4", 9000)}, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if tmpl.Tracks[0].Clips[0].Path != "/t/1.mov" {
		t.Fatal("the template was modified")
	}
	got := doc.Tracks[0].Clips
	// a→x (photo), bg stays, b→y (video), c is dropped: no input for it
	if len(got) != 3 || got[0].Path != "/n/x.jpg" || got[0].Kind != "image" || got[1].ID != "bg" || got[2].Path != "/n/y.mp4" || got[2].Kind != "video" {
		t.Fatalf("clips %+v", got)
	}
	if got[0].StartMs != 0 || got[0].EndMs != 3000 || got[2].StartMs != 4000 || got[2].EndMs != 6000 {
		t.Errorf("the template's timing changed: %+v", got)
	}
	if got[0].Matte != nil || got[0].FxTarget != "clip" || got[0].InMs != 0 || got[0].Auto || got[0].Fit != "fit" {
		t.Errorf("replaced clip %+v", got[0])
	}
	if got[2].In != `{"kind":"flash","ms":200}` {
		t.Errorf("the template's transition was lost: %q", got[2].In)
	}
	if doc.Aspect != "16:9" || doc.FPS != 60 || len(doc.Tracks) != 2 || doc.Song == nil || doc.Song.Path != "/t/old.mp3" {
		t.Errorf("template settings changed: %+v", doc)
	}
	if len(notes) != 0 {
		t.Errorf("notes %v", notes)
	}

	// More inputs than slots: the rest are left out, with a note.
	_, notes, err = assembleDoc(r, &tmpl, []videoeditor.ClipInfo{pinfo("/1.jpg"), pinfo("/2.jpg"), pinfo("/3.jpg"), pinfo("/4.jpg")}, "", 1)
	if err != nil || len(notes) != 1 {
		t.Errorf("extra inputs: %v %v", err, notes)
	}
}

func TestAssembleTemplateMusicTitleAndCrossfade(t *testing.T) {
	tmpl := templateEdit()
	r := DefaultAssembleRequest()
	r.Transition, r.Title = "crossfade", "Hi"
	doc, notes, err := assembleDoc(r, &tmpl, []videoeditor.ClipInfo{vinfo("/1.mp4", 5000), vinfo("/2.mp4", 5000), vinfo("/3.mp4", 5000)}, "/new.mp3", 1)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Song.Path != "/new.mp3" || doc.Song.StartMs != 1000 || doc.Song.EndMs != 9000 {
		t.Errorf("song %+v", doc.Song)
	}
	if doc.AnalysisKey != "" || len(notes) != 1 {
		t.Errorf("stale analysis kept: %q %v", doc.AnalysisKey, notes)
	}
	main := doc.Tracks[0].Clips
	if main[0].In != "" || main[2].In != `{"kind":"crossfade","ms":500}` || main[3].In != `{"kind":"crossfade","ms":500}` {
		t.Errorf("crossfades %q %q %q", main[0].In, main[2].In, main[3].In)
	}
	last := doc.Tracks[len(doc.Tracks)-1]
	if last.Name != "Title" || last.Clips[0].EndMs != 3000 {
		t.Errorf("title track %+v", last)
	}
}

func TestAssembleTemplateWithoutSlots(t *testing.T) {
	tmpl := NewProject("9:16", 30, 1)
	tmpl.Tracks[0].Clips = []Clip{{ID: "c", Kind: "color", Color: "#000000", StartMs: 0, EndMs: 1000}}
	if _, _, err := assembleDoc(DefaultAssembleRequest(), &tmpl, []videoeditor.ClipInfo{pinfo("/a.jpg")}, "", 1); err == nil {
		t.Error("a template without clips accepted")
	}
}

// --- the steps -----------------------------------------------------------------

func TestAssembleDescribe(t *testing.T) {
	m := newTestModule(t)
	v := NewVideoModule(m)
	info, err := v.DescribeStep(raw(DefaultAssembleRequest()))
	if err != nil {
		t.Fatal(err)
	}
	if !info.Together || info.Summary != "Assemble · 9:16 · 1080p30" || len(info.Produces) != 1 || info.Produces[0].Role != "video" ||
		!equalStrings(info.Templates, []string{"/title", "/music", "/name"}) {
		t.Errorf("info %+v", info)
	}
	exts := strings.Join(info.Accepts.Extensions, " ")
	for _, e := range []string{".mp4", ".jpg", ".mp3"} {
		if !strings.Contains(exts, e) {
			t.Errorf("accepts lacks %s", e)
		}
	}
	for name, mut := range map[string]func(*AssembleRequest){
		"transition": func(r *AssembleRequest) { r.Transition = "wipe" },
		"aspect":     func(r *AssembleRequest) { r.Aspect = "2:1" },
		"fps":        func(r *AssembleRequest) { r.FPS = 24 },
		"height":     func(r *AssembleRequest) { r.Height = 480 },
		"template":   func(r *AssembleRequest) { r.TemplateID = "nope" },
	} {
		r := DefaultAssembleRequest()
		mut(&r)
		if _, err := v.DescribeStep(raw(r)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := v.DescribeStep(json.RawMessage(`{"surprise":true}`)); err == nil {
		t.Error("unknown option accepted")
	}
	// An empty options object means the defaults.
	if _, err := v.DescribeStep(json.RawMessage(`{}`)); err != nil {
		t.Errorf("empty options: %v", err)
	}
}

func TestAssemblePrepare(t *testing.T) {
	m := newTestModule(t)
	v := NewVideoModule(m)
	r := DefaultAssembleRequest()
	r.Title, r.Music, r.Name = "{event} {name}", "{bed}", "{event}"
	req := core.StepRequest{Options: raw(r), Items: []core.StepItem{
		{Files: rf("/in/a.mp4", "/in/b.jpg"), Vars: map[string]string{"event": "Trip", "bed": "/m/song.mp3"}},
		{Files: rf("/in/c.mp4")},
	}}
	m.cfg.Broker = stepBroker(false)
	if _, err := v.PrepareStep(context.Background(), req); !core.IsCode(err, core.CodeWaiting) {
		t.Fatalf("without a window: %v", err)
	}
	m.cfg.Broker = stepBroker(true)
	jobs, err := v.PrepareStep(context.Background(), req)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("%v %+v", err, jobs)
	}
	if got := strings.Join(jobs[0].Inputs, ","); got != "/in/a.mp4,/in/b.jpg,/in/c.mp4" {
		t.Errorf("inputs %s", got)
	}
	o := jobs[0].Options.(Options)
	if o.Action != ActionAssemble || o.Assemble.Title != "Trip a" || o.Assemble.Music != "/m/song.mp3" || o.Assemble.Name != "Trip" {
		t.Errorf("options %+v", o.Assemble)
	}
	// The job's options pass the module's own validation.
	if err := v.Validate(jobs[0].Inputs, raw(o)); err != nil {
		t.Errorf("Validate: %v", err)
	}
	// Nothing to do without files.
	if jobs, err := v.PrepareStep(context.Background(), core.StepRequest{Options: raw(r)}); err != nil || len(jobs) != 0 {
		t.Errorf("no files: %v %v", jobs, err)
	}
}

func TestBeatDescribe(t *testing.T) {
	m := newTestModule(t)
	info, err := m.DescribeStep(raw(DefaultBeatRequest()))
	if err != nil {
		t.Fatal(err)
	}
	if !info.Together || info.Produces[0].Role != "video" || !strings.HasPrefix(info.Summary, "Cut to the beat · downbeat") || !equalStrings(info.Templates, []string{"/song", "/name"}) {
		t.Errorf("info %+v", info)
	}
	for name, mut := range map[string]func(*BeatRequest){
		"recipe":  func(r *BeatRequest) { r.RecipeID = "velocity-edit" },
		"order":   func(r *BeatRequest) { r.Order = "random" },
		"length":  func(r *BeatRequest) { r.LengthMs = 500 },
		"start":   func(r *BeatRequest) { r.StartMs = -1 },
		"aspect":  func(r *BeatRequest) { r.Aspect = "3:2" },
		"seed":    func(r *BeatRequest) { r.Seed = -3 },
		"toolong": func(r *BeatRequest) { r.LengthMs = MaxEditMs + 1 },
	} {
		r := DefaultBeatRequest()
		mut(&r)
		if _, err := m.DescribeStep(raw(r)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestBeatPrepare(t *testing.T) {
	m := newTestModule(t)
	req := func(o BeatRequest, files ...string) core.StepRequest {
		return core.StepRequest{Options: raw(o), Items: []core.StepItem{{Files: rf(files...), Vars: map[string]string{"who": "Ana"}}}}
	}
	m.cfg.Broker = stepBroker(true)

	jobs, err := m.PrepareStep(context.Background(), req(DefaultBeatRequest(), "/in/a.mp4", "/in/song.mp3", "/in/b.jpg"))
	if err != nil || len(jobs) != 1 {
		t.Fatalf("%v %+v", err, jobs)
	}
	o := jobs[0].Options.(Options)
	if o.Action != ActionBeat || o.Beat.Song != "/in/song.mp3" || strings.Join(jobs[0].Inputs, ",") != "/in/a.mp4,/in/b.jpg" {
		t.Errorf("job %+v / %+v", jobs[0].Inputs, o.Beat)
	}
	if err := m.Validate(jobs[0].Inputs, raw(o)); err != nil {
		t.Errorf("Validate: %v", err)
	}

	// The song can come from an option (with variables) instead.
	opt := DefaultBeatRequest()
	opt.Song, opt.Name = "/music/{who}.mp3", "{who} cut"
	jobs, err = m.PrepareStep(context.Background(), req(opt, "/in/a.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	if b := jobs[0].Options.(Options).Beat; b.Song != "/music/Ana.mp3" || b.Name != "Ana cut" {
		t.Errorf("beat %+v", b)
	}

	// Problems the user can fix are validation errors; a missing window waits.
	if _, err := m.PrepareStep(context.Background(), req(DefaultBeatRequest(), "/in/a.mp4")); err == nil || core.IsCode(err, core.CodeWaiting) {
		t.Errorf("no song: %v", err)
	}
	if _, err := m.PrepareStep(context.Background(), req(DefaultBeatRequest(), "/in/song.mp3")); err == nil || core.IsCode(err, core.CodeWaiting) {
		t.Errorf("no clips: %v", err)
	}
	m.cfg.Broker = stepBroker(false)
	if _, err := m.PrepareStep(context.Background(), req(DefaultBeatRequest(), "/in/a.mp4", "/in/song.mp3")); !core.IsCode(err, core.CodeWaiting) {
		t.Errorf("no window: %v", err)
	}
}

func TestStepOutputs(t *testing.T) {
	m := newTestModule(t)
	for _, ch := range []core.Chainable{m, NewVideoModule(m)} {
		res, err := ch.StepOutputs(core.Job{Outputs: []core.Output{{Path: "/o/Edit.mp4", Name: "Edit.mp4", ID: "x"}}})
		if err != nil || len(res.Files) != 1 || res.Files[0].Role != "video" || res.Files[0].Kind != core.KindVideo || res.Files[0].OutputID != "x" {
			t.Errorf("%+v %v", res, err)
		}
	}
}

func TestDescriptorsAreSteps(t *testing.T) {
	m := newTestModule(t)
	for _, d := range []core.Descriptor{m.Descriptor(), NewVideoModule(m).Descriptor()} {
		if d.NotAStep || d.JobLess || len(d.Accepts.Extensions) == 0 {
			t.Errorf("%s is not a step: %+v", d.ID, d)
		}
	}
}

func equalStrings(a, b []string) bool { return strings.Join(a, "\x00") == strings.Join(b, "\x00") }

// --- the jobs ------------------------------------------------------------------

func TestRunAssemble(t *testing.T) {
	m := newTestModule(t)
	oProbe, oRender := exportProbeFn, assembleRenderFn
	t.Cleanup(func() { exportProbeFn, assembleRenderFn = oProbe, oRender })
	exportProbeFn = func(_ context.Context, _ string, paths []string) []videoeditor.ClipInfo {
		var out []videoeditor.ClipInfo
		for _, p := range paths {
			switch filepath.Ext(p) {
			case ".mp3":
				out = append(out, videoeditor.ClipInfo{Path: p, Kind: "audio", DurationMs: 60_000})
			case ".jpg":
				out = append(out, pinfo(p))
			default:
				out = append(out, vinfo(p, 3000))
			}
		}
		return out
	}
	var gotDoc EditProject
	var gotName, gotProject string
	assembleRenderFn = func(_ *Module, _ context.Context, _ *core.JobContext, projectID, name string, doc EditProject) error {
		gotDoc, gotName, gotProject = doc, name, projectID
		return nil
	}
	rec := &recorder{}
	job := newJob(t, t.TempDir(), Options{Action: ActionAssemble, Assemble: &AssembleRequest{}}, rec, nil)
	job.Inputs = []string{"/in/a.mp4", "/in/song.mp3", "/in/b.jpg"}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if gotName != "a" || gotProject != "" {
		t.Errorf("name %q project %q", gotName, gotProject)
	}
	if len(gotDoc.Tracks[0].Clips) != 2 || gotDoc.Song == nil || gotDoc.Song.Path != "/in/song.mp3" || gotDoc.Song.EndMs != 6000 {
		t.Errorf("doc %+v", gotDoc)
	}

	// A template supplies the name and the project whose cut-outs it uses.
	info, err := m.docs.Create(context.Background(), "Template", templateEdit())
	if err != nil {
		t.Fatal(err)
	}
	job = newJob(t, t.TempDir(), Options{Action: ActionAssemble, Assemble: &AssembleRequest{TemplateID: info.ID}}, rec, nil)
	job.Inputs = []string{"/in/a.mp4"}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if gotName != "Template" || gotProject != info.ID {
		t.Errorf("template name %q project %q", gotName, gotProject)
	}

	// Unreadable files fail with their name.
	exportProbeFn = func(_ context.Context, _ string, paths []string) []videoeditor.ClipInfo {
		return []videoeditor.ClipInfo{{Path: paths[0], Error: "not a media file"}}
	}
	job = newJob(t, t.TempDir(), Options{Action: ActionAssemble, Assemble: &AssembleRequest{}}, rec, nil)
	job.Inputs = []string{"/in/broken.mp4"}
	if err := m.Run(context.Background(), job); err == nil || !strings.Contains(err.Error(), "broken.mp4") {
		t.Errorf("unreadable: %v", err)
	}
}

func TestRunBeat(t *testing.T) {
	m := newTestModule(t)
	oProbe, oBuild, oRender := exportProbeFn, beatBuildFn, beatRenderFn
	t.Cleanup(func() { exportProbeFn, beatBuildFn, beatRenderFn = oProbe, oBuild, oRender })
	exportProbeFn = func(_ context.Context, _ string, paths []string) []videoeditor.ClipInfo {
		var out []videoeditor.ClipInfo
		for _, p := range paths {
			if filepath.Ext(p) == ".mp3" {
				out = append(out, videoeditor.ClipInfo{Path: p, Kind: "audio", DurationMs: 20_000})
			} else {
				out = append(out, vinfo(p, 8000))
			}
		}
		return out
	}
	ref := viz.AnalysisRef{Key: "k-s1-none-m0", AudioJSON: "/a/audio.json", FeaturesPath: "/a/f.bin"}
	m.analyze = func(_ context.Context, _ *core.JobContext, input string, o viz.AnalyzeOptions) (viz.AnalysisRef, error) {
		if input != "/in/song.mp3" || !o.Stems {
			t.Errorf("analyze %q %+v", input, o)
		}
		return ref, nil
	}
	var plan viz.RecipePlan
	var planRef viz.AnalysisRef
	beatBuildFn = func(_ context.Context, _ *viz.RenderBroker, _ *core.JobContext, p viz.RecipePlan, r viz.AnalysisRef) (string, error) {
		plan, planRef = p, r
		var base EditProject
		if err := json.Unmarshal([]byte(p.ProjectJSON), &base); err != nil {
			t.Fatal(err)
		}
		base.Tracks[0].Clips = []Clip{{ID: "r1", Kind: "video", Path: "/in/a.mp4", StartMs: 0, EndMs: 1000, Fit: "fill", Blend: "normal"}}
		b, _ := json.Marshal(base)
		return string(b), nil
	}
	var rendered EditProject
	var renderName string
	beatRenderFn = func(_ *Module, _ context.Context, _ *core.JobContext, projectID, name string, doc EditProject) error {
		rendered, renderName = doc, name
		if projectID != "" {
			t.Errorf("project id %q", projectID)
		}
		return nil
	}
	req := DefaultBeatRequest()
	req.Song, req.StartMs, req.RecipeID = "/in/song.mp3", 5000, "kick"
	rec := &recorder{}
	job := newJob(t, t.TempDir(), Options{Action: ActionBeat, Beat: &req}, rec, nil)
	job.Inputs = []string{"/in/a.mp4", "/in/b.mp4"}
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if planRef.Key != ref.Key || plan.RecipeID != "kick" || plan.Seed != 1 || plan.Order != "recipe" || len(plan.Sources) != 2 || plan.Sources[0].DurationMs != 8000 {
		t.Errorf("plan %+v ref %+v", plan, planRef)
	}
	var base EditProject
	_ = json.Unmarshal([]byte(plan.ProjectJSON), &base)
	// The song has 20 s; from 5 s a 30 s request is cut to the song's end.
	if base.Song.StartMs != 5000 || base.Song.EndMs != 20_000 || base.AnalysisKey != ref.Key || len(base.Sources) != 2 {
		t.Errorf("base %+v", base)
	}
	if renderName != "song" || len(rendered.Tracks[0].Clips) != 1 || rendered.Song.EndMs != 20_000 {
		t.Errorf("render %q %+v", renderName, rendered)
	}

	// A recipe that makes no cuts is an error, not an empty video.
	beatBuildFn = func(_ context.Context, _ *viz.RenderBroker, _ *core.JobContext, p viz.RecipePlan, _ viz.AnalysisRef) (string, error) {
		return p.ProjectJSON, nil
	}
	job = newJob(t, t.TempDir(), Options{Action: ActionBeat, Beat: &req}, rec, nil)
	job.Inputs = []string{"/in/a.mp4"}
	if err := m.Run(context.Background(), job); err == nil {
		t.Error("an edit without cuts was rendered")
	}

	// The broker's error (for example no window) passes through unchanged.
	waiting := viz.ErrNoHost()
	beatBuildFn = func(context.Context, *viz.RenderBroker, *core.JobContext, viz.RecipePlan, viz.AnalysisRef) (string, error) {
		return "", waiting
	}
	job = newJob(t, t.TempDir(), Options{Action: ActionBeat, Beat: &req}, rec, nil)
	job.Inputs = []string{"/in/a.mp4"}
	if err := m.Run(context.Background(), job); !errors.Is(err, waiting) {
		t.Errorf("error %v", err)
	}
}

func TestRunBeatNeedsASong(t *testing.T) {
	m := newTestModule(t)
	oProbe := exportProbeFn
	t.Cleanup(func() { exportProbeFn = oProbe })
	exportProbeFn = func(_ context.Context, _ string, paths []string) []videoeditor.ClipInfo {
		return []videoeditor.ClipInfo{vinfo(paths[0], 1000)} // the "song" is a video
	}
	req := DefaultBeatRequest()
	req.Song = "/in/not-a-song.mp4"
	job := newJob(t, t.TempDir(), Options{Action: ActionBeat, Beat: &req}, &recorder{}, nil)
	job.Inputs = []string{"/in/a.mp4"}
	if err := m.Run(context.Background(), job); err == nil {
		t.Error("a video was used as the song")
	}
}
