package videoeditor

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/gif"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/media"
)

type memStore struct {
	mu sync.Mutex
	m  map[string]core.StoredProject
}

func (s *memStore) ListProjects(_ context.Context, kind core.ProjectKind) ([]core.StoredProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []core.StoredProject
	for _, p := range s.m {
		if p.Kind == kind {
			out = append(out, p)
		}
	}
	return out, nil
}

func (s *memStore) GetProject(_ context.Context, id string) (core.StoredProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[id]
	if !ok {
		return core.StoredProject{}, core.Errorf(core.CodeNotFound, "Project not found")
	}
	return p, nil
}

func (s *memStore) PutProject(_ context.Context, p core.StoredProject) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[p.ID] = p
	return nil
}

func (s *memStore) DeleteProject(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, id)
	return nil
}

func newTestModule(t *testing.T) *Module {
	t.Helper()
	return New(Config{Store: &memStore{m: map[string]core.StoredProject{}}, ProjectsDir: filepath.Join(t.TempDir(), "projects")})
}

// ---- timeline ----

func TestTimelineVectors(t *testing.T) {
	b, err := os.ReadFile("testdata/timeline.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name  string `json:"name"`
		Clips []Clip `json:"clips"`
		Spans []struct {
			StartMs int64 `json:"startMs"`
			EndMs   int64 `json:"endMs"`
		} `json:"spans"`
		TotalMs int64 `json:"totalMs"`
	}
	if err := json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 5 {
		t.Fatalf("only %d vectors", len(vectors))
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			doc := VideoProject{Clips: v.Clips}
			spans := Timeline(doc)
			if len(spans) != len(v.Spans) {
				t.Fatalf("%d spans, want %d", len(spans), len(v.Spans))
			}
			for i, s := range spans {
				if s.StartMs != v.Spans[i].StartMs || s.EndMs != v.Spans[i].EndMs {
					t.Errorf("span %d = %d–%d, want %d–%d", i, s.StartMs, s.EndMs, v.Spans[i].StartMs, v.Spans[i].EndMs)
				}
			}
			if got := DurationMs(doc); got != v.TotalMs {
				t.Errorf("DurationMs = %d, want %d", got, v.TotalMs)
			}
		})
	}
	if DurationMs(VideoProject{}) != 0 {
		t.Error("an empty project has no length")
	}
}

// ---- validation ----

func validDoc() VideoProject {
	return VideoProject{Version: 1, Aspect: "9:16", Clips: []Clip{
		withTrans(vclip("a", 0, 3000), "fade", 500), vclip("b", 0, 3000),
	}, Titles: []Title{{ID: "t", Text: "hi", StartMs: 0, DurationMs: 1000, Style: "title", Position: "center", Font: "Arial", Color: "#ffffff"}},
		Music: &Music{Path: "song.mp3", Volume: 1}}
}

func TestValidateShape(t *testing.T) {
	if err := validateShape(validDoc()); err != nil {
		t.Fatalf("valid project: %v", err)
	}
	many := func(n int) []Clip {
		cs := make([]Clip, n)
		for i := range cs {
			cs[i] = vclip("a", 0, 1000)
		}
		return cs
	}
	cases := []struct {
		name string
		edit func(d *VideoProject)
		want string // a field name in the error
	}{
		{"aspect", func(d *VideoProject) { d.Aspect = "3:2" }, "aspect"},
		{"too many clips", func(d *VideoProject) { d.Clips = many(201) }, "clips"},
		{"too long", func(d *VideoProject) {
			d.Clips = many(190)
			d.Clips[0] = vclip("a", 0, 1_000_000)
			d.Clips[1] = vclip("a", 0, 1_000_000)
		}, "clips"},
		{"speed", func(d *VideoProject) { d.Clips[0].Speed = 3 }, "clips[0].speed"},
		{"volume", func(d *VideoProject) { d.Clips[0].Volume = 2.5 }, "clips[0].volume"},
		{"fit", func(d *VideoProject) { d.Clips[0].Fit = "stretch" }, "clips[0].fit"},
		{"fit color", func(d *VideoProject) { d.Clips[0].FitColor = "red" }, "clips[0].fitColor"},
		{"zoom", func(d *VideoProject) { d.Clips[0].Zoom = 4 }, "clips[0].zoom"},
		{"pan", func(d *VideoProject) { d.Clips[0].PanX = 1.5 }, "clips[0].pan"},
		{"motion", func(d *VideoProject) { d.Clips[0].Motion = "spin" }, "clips[0].motion"},
		{"look", func(d *VideoProject) { d.Clips[0].Look = "sepia" }, "clips[0].look"},
		{"kind", func(d *VideoProject) { d.Clips[0].Kind = "audio" }, "clips[0].kind"},
		{"out before in", func(d *VideoProject) { d.Clips[0].InMs, d.Clips[0].OutMs = 2000, 1000 }, "clips[0].outMs"},
		{"too short after speed", func(d *VideoProject) { d.Clips[0].InMs, d.Clips[0].OutMs, d.Clips[0].Speed = 0, 500, 2 }, "clips[0].outMs"},
		{"photo too short", func(d *VideoProject) {
			d.Clips[0].Transition = Transition{Kind: "cut"}
			d.Clips[1] = pclip("p", 500, "none")
		}, "clips[1].durationMs"},
		{"photo too long", func(d *VideoProject) {
			d.Clips[0].Transition = Transition{Kind: "cut"}
			d.Clips[1] = pclip("p", 11000, "none")
		}, "clips[1].durationMs"},
		{"transition kind", func(d *VideoProject) { d.Clips[0].Transition.Kind = "wipe" }, "clips[0].transition"},
		{"transition short", func(d *VideoProject) { d.Clips[0].Transition.DurationMs = 100 }, "clips[0].transition"},
		{"transition long", func(d *VideoProject) { d.Clips[0].Transition.DurationMs = 1600 }, "clips[0].transition"},
		{"transition over half", func(d *VideoProject) { d.Clips[1].OutMs = 800; d.Clips[0].Transition.DurationMs = 500 }, "clips[0].transition"},
		{"title text", func(d *VideoProject) { d.Titles[0].Text = " " }, "titles[0].text"},
		{"title long", func(d *VideoProject) { d.Titles[0].Text = strings.Repeat("x", 201) }, "titles[0].text"},
		{"title font", func(d *VideoProject) { d.Titles[0].Font = "Comic Sans" }, "titles[0].font"},
		{"title color", func(d *VideoProject) { d.Titles[0].Color = "white" }, "titles[0].color"},
		{"title style", func(d *VideoProject) { d.Titles[0].Style = "huge" }, "titles[0].style"},
		{"title position", func(d *VideoProject) { d.Titles[0].Position = "left" }, "titles[0].position"},
		{"title length", func(d *VideoProject) { d.Titles[0].DurationMs = 0 }, "titles[0].durationMs"},
		{"too many titles", func(d *VideoProject) {
			d.Titles = make([]Title, 101)
			for i := range d.Titles {
				d.Titles[i] = Title{Text: "x", DurationMs: 1, Style: "title", Position: "top", Color: "#000000"}
			}
		}, "titles"},
		{"music volume", func(d *VideoProject) { d.Music.Volume = 2 }, "music.volume"},
		{"music path", func(d *VideoProject) { d.Music.Path = "" }, "music.path"},
		{"max size", func(d *VideoProject) { d.MaxSizeMB = -1 }, "maxSizeMB"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := validDoc()
			tc.edit(&d)
			err := validateShape(d)
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
				t.Fatalf("err = %v, want a validation error", err)
			}
			if _, ok := ae.Fields[tc.want]; !ok {
				t.Errorf("fields = %v, want %q", ae.Fields, tc.want)
			}
		})
	}
}

func TestValidateDocFiles(t *testing.T) {
	dir := t.TempDir()
	clip := filepath.Join(dir, "a.mp4")
	song := filepath.Join(dir, "s.mp3")
	for _, p := range []string{clip, song} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	c := vclip("a", 0, 3000)
	c.Path = clip
	doc := VideoProject{Version: 1, Aspect: "1:1", Clips: []Clip{c}, Music: &Music{Path: song, Volume: 1}}
	if err := validateDoc(doc); err != nil {
		t.Fatalf("valid: %v", err)
	}
	doc.Clips[0].Path = filepath.Join(dir, "gone.mp4")
	var ae *core.AppError
	if err := validateDoc(doc); !errors.As(err, &ae) || ae.Code != core.CodeNotFound || ae.Fields["clips[0].path"] == "" {
		t.Errorf("missing clip: %v", err)
	}
	doc.Clips[0].Path = clip
	doc.Music.Path = filepath.Join(dir, "gone.mp3")
	if err := validateDoc(doc); !errors.As(err, &ae) || ae.Fields["music.path"] == "" {
		t.Errorf("missing song: %v", err)
	}
	if err := validateDoc(VideoProject{Version: 1, Aspect: "1:1"}); err == nil {
		t.Error("no clips should fail to render")
	}
	// Save-time validation doesn't need the files or any clips.
	if err := validateShape(VideoProject{Version: 1, Aspect: "1:1"}); err != nil {
		t.Errorf("empty project shape: %v", err)
	}
}

func TestValidatePlan(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "a.mp4")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ok := PlanRequest{Paths: []string{f}, Aspect: "9:16", Order: "date-taken", Transition: "fade"}
	if err := validatePlan(ok); err != nil {
		t.Fatalf("valid: %v", err)
	}
	for name, edit := range map[string]func(r *PlanRequest){
		"no paths":        func(r *PlanRequest) { r.Paths = nil },
		"too many paths":  func(r *PlanRequest) { r.Paths = make([]string, 201) },
		"missing file":    func(r *PlanRequest) { r.Paths = []string{filepath.Join(dir, "no.mp4")} },
		"beat without":    func(r *PlanRequest) { r.BeatCut = true },
		"missing song":    func(r *PlanRequest) { r.MusicPath = filepath.Join(dir, "no.mp3") },
		"bad aspect":      func(r *PlanRequest) { r.Aspect = "2:1" },
		"bad order":       func(r *PlanRequest) { r.Order = "random" },
		"bad target":      func(r *PlanRequest) { r.TargetMs = -1 },
		"bad transition":  func(r *PlanRequest) { r.Transition = "wipe" },
		"target too long": func(r *PlanRequest) { r.TargetMs = MaxTotalMs + 1 },
	} {
		r := ok
		edit(&r)
		if err := validatePlan(r); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestModuleValidate(t *testing.T) {
	m := newTestModule(t)
	raw := func(o Options) json.RawMessage { b, _ := json.Marshal(o); return b }
	if err := m.Validate(nil, raw(Options{Action: "dance"})); err == nil {
		t.Error("unknown action")
	}
	if err := m.Validate(nil, raw(Options{Action: ActionRender, ProjectID: "nope"})); err == nil {
		t.Error("unknown project")
	}
	if err := m.Validate(nil, raw(Options{Action: ActionPlan})); err == nil {
		t.Error("plan without a request")
	}
	if err := m.Validate(nil, json.RawMessage(`{"action":"plan","bogus":1}`)); err == nil {
		t.Error("unknown option fields are rejected")
	}
	// A stored project with a missing file fails at submit.
	svc := NewService(nil, m)
	info, err := svc.Create("Trip", "9:16")
	if err != nil {
		t.Fatal(err)
	}
	c := vclip("a", 0, 3000)
	c.Path = filepath.Join(t.TempDir(), "gone.mp4")
	if _, err := svc.Save(info.ID, "Trip", VideoProject{Aspect: "9:16", Clips: []Clip{c}}); err != nil {
		t.Fatal(err)
	}
	var ae *core.AppError
	if err := m.Validate(nil, raw(Options{Action: ActionPreview, ProjectID: info.ID})); !errors.As(err, &ae) || ae.Code != core.CodeNotFound {
		t.Errorf("missing file: %v", err)
	}
}

func TestDescriptor(t *testing.T) {
	d := newTestModule(t).Descriptor()
	if d.ID != ModuleID || d.OutputSubdir != "Edits" || len(d.Requires) != 2 {
		t.Errorf("descriptor = %+v", d)
	}
}

// ---- service ----

func TestServiceProjects(t *testing.T) {
	m := newTestModule(t)
	svc := NewService(nil, m)
	if _, err := svc.Create("x", "5:4"); err == nil {
		t.Error("Create should validate the aspect")
	}
	info, err := svc.Create("  My   trip ", "4:5")
	if err != nil || info.Name != "My trip" {
		t.Fatalf("Create = %+v, %v", info, err)
	}
	doc, err := svc.Get(info.ID)
	if err != nil || doc.Aspect != "4:5" || doc.Music != nil || doc.Version != 1 || doc.Clips == nil || doc.Titles == nil {
		t.Errorf("new project = %+v, %v", doc, err)
	}
	// Save keeps missing files but rejects a broken shape.
	c := vclip("a", 0, 3000)
	c.Path = "Z:/nowhere/a.mp4"
	doc.Clips = []Clip{c}
	if _, err := svc.Save(info.ID, "Renamed", doc); err != nil {
		t.Fatalf("Save with a missing file: %v", err)
	}
	doc.Clips[0].Speed = 7
	if _, err := svc.Save(info.ID, "Renamed", doc); err == nil {
		t.Error("Save should reject a bad speed")
	}
	list, _ := svc.List()
	if len(list) != 1 || list[0].Name != "Renamed" || list[0].Items != 1 || list[0].Missing != 1 {
		t.Errorf("List = %+v", list)
	}
	// Preview path.
	if p := svc.PreviewPath(info.ID); p != "" {
		t.Errorf("PreviewPath = %q before any preview", p)
	}
	dir := m.docs.Dir(info.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "preview.mp4"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if p := svc.PreviewPath(info.ID); p != filepath.Join(dir, "preview.mp4") {
		t.Errorf("PreviewPath = %q", p)
	}
	// A preview made after the last save is fresh; saving again makes it stale.
	if p := svc.FreshPreviewPath(info.ID); p != filepath.Join(dir, "preview.mp4") {
		t.Errorf("FreshPreviewPath = %q, want the new preview", p)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "preview.mp4"), old, old); err != nil {
		t.Fatal(err)
	}
	if p := svc.FreshPreviewPath(info.ID); p != "" {
		t.Errorf("FreshPreviewPath = %q for a preview older than the last save", p)
	}
	if err := svc.Delete(info.ID); err != nil {
		t.Fatal(err)
	}
	if svc.PreviewPath(info.ID) != "" {
		t.Error("the preview goes with the project")
	}
	if _, err := svc.Probe(make([]string, 201)); err == nil {
		t.Error("Probe caps its input")
	}
	if rows, err := svc.Probe(nil); err != nil || rows == nil {
		t.Errorf("Probe(nil) = %v, %v", rows, err)
	}
}

// ---- probing ----

func TestTagTakenAt(t *testing.T) {
	want := time.Date(2024, 5, 1, 10, 0, 0, 0, time.UTC).UnixMilli()
	for name, tags := range map[string]map[string]string{
		"creation_time": {"creation_time": "2024-05-01T10:00:00.000000Z"},
		"apple":         {"com.apple.quicktime.creationdate": "2024-05-01T12:00:00+0200", "creation_time": "1990-01-01T00:00:00Z"},
	} {
		if got := tagTakenAt(tags); got != want {
			t.Errorf("%s: %d, want %d", name, got, want)
		}
	}
	for _, tags := range []map[string]string{nil, {"creation_time": "garbage"}, {"creation_time": "1970-01-01T00:00:00Z"}} {
		if got := tagTakenAt(tags); got != 0 {
			t.Errorf("tagTakenAt(%v) = %d", tags, got)
		}
	}
}

// exifJPEG builds a JPEG header with an Exif block holding DateTimeOriginal.
func exifJPEG(bo binary.AppendByteOrder, order string, date string) []byte {
	var tiff []byte
	put16 := func(v uint16) { tiff = bo.AppendUint16(tiff, v) }
	put32 := func(v uint32) { tiff = bo.AppendUint32(tiff, v) }
	tiff = append(tiff, order...)
	put16(42)
	put32(8)
	// IFD0 at 8: one entry, the Exif IFD pointer at 26.
	put16(1)
	put16(0x8769)
	put16(4)
	put32(1)
	put32(26)
	put32(0)
	// Exif IFD at 26: DateTimeOriginal, string at 44.
	put16(1)
	put16(0x9003)
	put16(2)
	put32(20)
	put32(44)
	put32(0)
	tiff = append(tiff, date...)
	tiff = append(tiff, 0)
	seg := append([]byte("Exif\x00\x00"), tiff...)
	out := []byte{0xFF, 0xD8, 0xFF, 0xE1}
	out = binary.BigEndian.AppendUint16(out, uint16(len(seg)+2))
	out = append(out, seg...)
	return append(out, 0xFF, 0xDA, 0, 2)
}

func TestExifTakenAt(t *testing.T) {
	want := time.Date(2023, 8, 14, 9, 30, 5, 0, time.Local).UnixMilli()
	dir := t.TempDir()
	for name, b := range map[string][]byte{
		"little": exifJPEG(binary.LittleEndian, "II", "2023:08:14 09:30:05"),
		"big":    exifJPEG(binary.BigEndian, "MM", "2023:08:14 09:30:05"),
	} {
		p := filepath.Join(dir, name+".jpg")
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		if got := exifTakenAt(p); got != want {
			t.Errorf("%s: %d, want %d", name, got, want)
		}
	}
	junk := filepath.Join(dir, "junk.jpg")
	if err := os.WriteFile(junk, []byte("not a jpeg at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	if exifTakenAt(junk) != 0 || exifTakenAt(filepath.Join(dir, "none.jpg")) != 0 {
		t.Error("unreadable files have no date")
	}
}

func TestProbeFile(t *testing.T) {
	dir := t.TempDir()
	vid := filepath.Join(dir, "v.mp4")
	pic := filepath.Join(dir, "p.jpg")
	aud := filepath.Join(dir, "a.mp3")
	for _, p := range []string{vid, pic, aud} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := probeMedia
	defer func() { probeMedia = old }()
	probeMedia = func(_ context.Context, _ string, path string) (media.Info, error) {
		switch path {
		case vid:
			return media.Info{DurationMs: 5000, Video: &media.VideoStream{Width: 1080, Height: 1920, FPS: 29.97, Rotation: 90}, Audio: []media.AudioStream{{}},
				Tags: map[string]string{"creation_time": "2024-05-01T10:00:00Z"}}, nil
		case aud:
			return media.Info{DurationMs: 9000, Audio: []media.AudioStream{{}}}, nil
		}
		return media.Info{}, errors.New("nope")
	}
	v := probeFile(context.Background(), "ffprobe", vid)
	if v.Kind != "video" || v.DurationMs != 5000 || !v.HasAudio || v.Width != 1080 || v.Rotation != 90 || v.TakenAt != time.Date(2024, 5, 1, 10, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("video = %+v", v)
	}
	if a := probeFile(context.Background(), "ffprobe", aud); a.Kind != "audio" || a.TakenAt == 0 {
		t.Errorf("audio = %+v", a)
	}
	if p := probeFile(context.Background(), "ffprobe", pic); p.Kind != "image" || p.TakenAt == 0 || p.Error != "" {
		t.Errorf("photo = %+v", p)
	}
	if g := probeFile(context.Background(), "ffprobe", filepath.Join(dir, "gone.mp4")); g.Error == "" {
		t.Error("a missing file has an error")
	}
	bad := filepath.Join(dir, "bad.mp4")
	_ = os.WriteFile(bad, []byte("x"), 0o644)
	if b := probeFile(context.Background(), "ffprobe", bad); b.Error == "" || b.Kind != "" {
		t.Errorf("unreadable = %+v", b)
	}
}

// ---- titles ----

func TestTitlesASS(t *testing.T) {
	titles := []Title{
		{Text: "Late", StartMs: 9000, DurationMs: 1000, Style: "caption", Position: "bottom", Color: "#ffffff"},
		{Text: "Early {x\\b1}", StartMs: 500, DurationMs: 99000, Style: "lower-third", Position: "top", Font: "Georgia", Color: "#ff8800"},
	}
	a, ok := buildTitlesASS(titles, 1080, 1920, 5000)
	if !ok {
		t.Fatal("no ASS")
	}
	for _, want := range []string{"PlayResX: 1080", "PlayResY: 1920", "Style: Title,", "Style: LowerThird,", "Style: Caption,", "Style: Label,",
		`\an7`, `\fnGeorgia`, `\1c&H0088FF&`, "0:00:05.00", "｛x＼b1｝"} {
		if !strings.Contains(a, want) {
			t.Errorf("ASS lacks %q:\n%s", want, a)
		}
	}
	if strings.Contains(a, "Late") {
		t.Error("a title after the end must be dropped")
	}
	if _, ok := buildTitlesASS(titles[:1], 1080, 1920, 5000); ok {
		t.Error("only a late title: nothing to burn")
	}
	if _, ok := buildTitlesASS(nil, 1080, 1920, 5000); ok {
		t.Error("no titles")
	}
}

// ---- plan ----

func vitem(name string, durMs int64) planItem {
	return planItem{Path: name + ".mp4", Kind: "video", DurationMs: durMs}
}

func pitem(name string) planItem { return planItem{Path: name + ".jpg", Kind: "image"} }

// everyBar makes bars from 0 to endMs every stepMs.
func everyBar(stepMs, endMs int64) []int64 {
	var b []int64
	for t := int64(0); t <= endMs; t += stepMs {
		b = append(b, t)
	}
	return b
}

func lensOf(d VideoProject) []int64 {
	var out []int64
	for _, c := range d.Clips {
		out = append(out, clipLenMs(c))
	}
	return out
}

func eqInts(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestPlanWithoutBeats(t *testing.T) {
	req := PlanRequest{Aspect: "9:16"}
	d, err := buildPlanDoc(req, []planItem{vitem("a", 10000), vitem("b", 10000), vitem("c", 10000), pitem("p")}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := lensOf(d); !eqInts(got, []int64{3000, 3000, 3000, 2500}) {
		t.Errorf("lengths = %v", got)
	}
	if d.Clips[0].InMs != 3500 || d.Clips[0].OutMs != 6500 {
		t.Errorf("the middle of a 10 s clip: in %d out %d", d.Clips[0].InMs, d.Clips[0].OutMs)
	}
	if d.Music != nil || d.Aspect != "9:16" || d.Version != 1 || len(d.Clips) != 4 {
		t.Errorf("doc = %+v", d)
	}
	for _, c := range d.Clips {
		if c.Speed != 1 || c.Volume != 1 || c.Fit != "fill" || c.Transition.Kind != "cut" || c.ID == "" {
			t.Errorf("clip defaults = %+v", c)
		}
	}

	// A target scales every length; a short video can't be stretched past itself.
	d, err = buildPlanDoc(PlanRequest{Aspect: "1:1", TargetMs: 3000}, []planItem{vitem("a", 10000), vitem("b", 10000)}, nil, 0)
	if err != nil || DurationMs(d) != 3000 {
		t.Errorf("target 3 s: %d, %v", DurationMs(d), err)
	}
	d, _ = buildPlanDoc(PlanRequest{Aspect: "1:1", TargetMs: 20000}, []planItem{vitem("a", 4000), vitem("b", 10000)}, nil, 0)
	if got := lensOf(d); got[0] != 4000 || got[1] != 10000 {
		t.Errorf("lengths cap at the clips: %v", got)
	}
	if d.Clips[0].InMs != 0 {
		t.Errorf("a whole clip starts at 0, got %d", d.Clips[0].InMs)
	}
}

func TestPlanTransitions(t *testing.T) {
	// Transitions overlap, so the plan still adds up to the target.
	d, err := buildPlanDoc(PlanRequest{Aspect: "9:16", TargetMs: 3000, Transition: "fade"}, []planItem{vitem("a", 10000), vitem("b", 10000)}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if d.Clips[0].Transition.Kind != "fade" || d.Clips[0].Transition.DurationMs != 500 || d.Clips[1].Transition.Kind != "cut" {
		t.Errorf("transitions = %+v %+v", d.Clips[0].Transition, d.Clips[1].Transition)
	}
	if got := DurationMs(d); got != 3000 {
		t.Errorf("duration = %d", got)
	}
	// Clips too short for a transition get a cut.
	d, _ = buildPlanDoc(PlanRequest{Aspect: "9:16", Transition: "dip"}, []planItem{vitem("a", 350), vitem("b", 10000)}, nil, 0)
	if d.Clips[0].Transition.Kind != "cut" {
		t.Errorf("350 ms clip: %+v", d.Clips[0].Transition)
	}
}

func TestPlanOnBeats(t *testing.T) {
	bars := everyBar(2000, 60000)
	items := []planItem{vitem("a", 10000), vitem("b", 10000), vitem("c", 2500), pitem("p"), vitem("d", 10000)}
	// 2 bars for long clips, 1 bar for clips of 3 s or less and photos.
	d, err := buildPlanDoc(PlanRequest{Aspect: "9:16", BeatCut: true, MusicPath: "s.mp3"}, items, bars, 16000)
	if err != nil {
		t.Fatal(err)
	}
	if got := lensOf(d); !eqInts(got, []int64{4000, 4000, 2000, 2000, 4000}) {
		t.Errorf("lengths = %v", got)
	}
	// Every cut lands on a bar.
	for _, s := range Timeline(d) {
		if s.StartMs%2000 != 0 {
			t.Errorf("clip %d starts at %d, off the bars", s.Index, s.StartMs)
		}
	}
	if d.Music == nil || d.Music.Path != "s.mp3" || !d.Music.Duck {
		t.Errorf("music = %+v", d.Music)
	}

	// A longer song stretches the cuts, still on bars; the last clip ends with the song.
	long := []planItem{vitem("a", 20000), vitem("b", 20000), pitem("p"), vitem("d", 20000)}
	d, err = buildPlanDoc(PlanRequest{Aspect: "9:16", BeatCut: true, MusicPath: "s.mp3"}, long, bars, 28000)
	if err != nil {
		t.Fatal(err)
	}
	if got := DurationMs(d); got != 28000 {
		t.Errorf("duration = %d, want the song's 28000", got)
	}
	if got := lensOf(d); !eqInts(got, []int64{8000, 8000, 4000, 8000}) {
		t.Errorf("stretched lengths = %v", got)
	}
	for _, s := range Timeline(d) {
		if s.StartMs%2000 != 0 {
			t.Errorf("clip %d starts at %d, off the bars", s.Index, s.StartMs)
		}
	}

	// A clip shorter than its bars can't be stretched.
	d, _ = buildPlanDoc(PlanRequest{Aspect: "9:16", BeatCut: true, MusicPath: "s.mp3"}, []planItem{vitem("a", 1500), vitem("b", 10000)}, bars, 8000)
	if got := lensOf(d)[0]; got != 1500 {
		t.Errorf("short clip = %d", got)
	}
}

func TestPlanPhotoMotionAndOrder(t *testing.T) {
	d, _ := buildPlanDoc(PlanRequest{Aspect: "4:5"}, []planItem{pitem("p1"), vitem("v", 5000), pitem("p2"), pitem("p3")}, nil, 0)
	var motions []string
	for _, c := range d.Clips {
		if c.Kind == "image" {
			motions = append(motions, c.Motion)
			if c.DurationMs < MinPhotoMs || c.DurationMs > MaxPhotoMs {
				t.Errorf("photo length %d", c.DurationMs)
			}
		} else if c.Motion != "none" {
			t.Errorf("video motion %q", c.Motion)
		}
	}
	if strings.Join(motions, ",") != "in,out,in" {
		t.Errorf("photo motion = %v", motions)
	}
	if _, err := buildPlanDoc(PlanRequest{Aspect: "4:5"}, nil, nil, 0); err == nil {
		t.Error("no items")
	}
	var many []planItem
	for i := 0; i < 200; i++ {
		many = append(many, vitem("a", 600_000))
	}
	if _, err := buildPlanDoc(PlanRequest{Aspect: "4:5"}, many, nil, 0); err != nil {
		t.Errorf("200 clips of 3 s = 10 min is fine: %v", err)
	}
}

func TestFileStem(t *testing.T) {
	for in, want := range map[string]string{"My: trip?": "My_ trip_", "a/b\\c": "a_b_c", "  ..  ": "Video", "Vlog 2024-06-01": "Vlog 2024-06-01"} {
		if got := fileStem(in); got != want {
			t.Errorf("fileStem(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPreparePhoto(t *testing.T) {
	dir := t.TempDir()
	img := image.NewRGBA(image.Rect(0, 0, 8, 4))
	write := func(name string, enc func(f *os.File) error) string {
		p := filepath.Join(dir, name)
		f, err := os.Create(p)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := enc(f); err != nil {
			t.Fatal(err)
		}
		return p
	}
	upright := write("a.png", func(f *os.File) error { return png.Encode(f, img) })
	gif1 := write("b.gif", func(f *os.File) error { return gif.Encode(f, img, nil) })
	m := newTestModule(t)
	job := core.NewJobContext(core.JobContext{TempDir: t.TempDir()}, core.JobHooks{})
	if got, err := m.preparePhoto(context.Background(), job, upright, 1); err != nil || got != upright {
		t.Errorf("an upright PNG is read as is: %q, %v", got, err)
	}
	got, err := m.preparePhoto(context.Background(), job, gif1, 2)
	if err != nil || got == gif1 || filepath.Ext(got) != ".png" {
		t.Fatalf("a GIF is converted: %q, %v", got, err)
	}
	if fi, err := os.Stat(got); err != nil || fi.Size() == 0 {
		t.Errorf("converted file: %v", err)
	}
	if _, err := m.preparePhoto(context.Background(), job, filepath.Join(dir, "x.heic"), 3); err == nil {
		t.Error("HEIC without the engine must fail")
	}
	if _, err := m.preparePhoto(context.Background(), job, filepath.Join(dir, "gone.gif"), 4); err == nil {
		t.Error("a missing photo must fail")
	}
}

func TestOrderItems(t *testing.T) {
	items := []planItem{{Path: "c", TakenAt: 300}, {Path: "none", TakenAt: 0}, {Path: "a", TakenAt: 100}, {Path: "b", TakenAt: 200}}
	got := orderItems(items, "date-taken")
	var names []string
	for _, i := range got {
		names = append(names, i.Path)
	}
	if strings.Join(names, ",") != "a,b,c,none" {
		t.Errorf("by date = %v", names)
	}
	if g := orderItems(items, "as-given"); g[0].Path != "c" || g[3].Path != "b" {
		t.Errorf("as given = %v", g)
	}
	if items[0].Path != "c" {
		t.Error("the input was reordered")
	}
}

func TestBarStarts(t *testing.T) {
	if got := barStarts(10000, 120, []int64{0, 2000, 1900, 4000}); !eqInts(got, []int64{0, 2000, 4000}) {
		t.Errorf("downbeats = %v", got)
	}
	if got := barStarts(9000, 120, nil); !eqInts(got, []int64{0, 2000, 4000, 6000, 8000}) {
		t.Errorf("from tempo = %v", got)
	}
	if got := barStarts(5000, 0, nil); !eqInts(got, []int64{0, 2000, 4000}) {
		t.Errorf("no tempo = %v", got)
	}
}

func TestRunPlan(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	mk := func(name string, mtime time.Time) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
		return p
	}
	base := time.Date(2024, 6, 1, 12, 0, 0, 0, time.Local)
	late := mk("late.mp4", base)
	early := mk("early.mp4", base.Add(-48*time.Hour))
	photo := mk("mid.jpg", base.Add(-24*time.Hour))
	bad := mk("bad.mp4", base)
	tiny := mk("tiny.mp4", base)
	song := mk("song.mp3", base)

	old := probeMedia
	defer func() { probeMedia = old }()
	probeMedia = func(_ context.Context, _ string, path string) (media.Info, error) {
		switch path {
		case late, early:
			return media.Info{DurationMs: 30000, Video: &media.VideoStream{Width: 1920, Height: 1080}}, nil
		case tiny:
			return media.Info{DurationMs: 100, Video: &media.VideoStream{Width: 1920, Height: 1080}}, nil
		case song:
			return media.Info{DurationMs: 20000, Audio: []media.AudioStream{{}}}, nil
		}
		return media.Info{}, errors.New("unreadable")
	}
	var calls []string
	m.bars = func(_ context.Context, _ *core.JobContext, s string) ([]int64, int64, error) {
		calls = append(calls, s)
		return everyBar(2000, 20000), 20000, nil
	}
	var result json.RawMessage
	var logs []string
	job := core.NewJobContext(core.JobContext{ID: "j", TempDir: t.TempDir()}, core.JobHooks{
		Tool:     func(id string) (string, error) { return id, nil },
		Progress: func(float64, string) {},
		Log:      func(_ core.LogStream, l string) { logs = append(logs, l) },
		Result:   func(r json.RawMessage) { result = r },
	})
	req := PlanRequest{Paths: []string{late, photo, early, bad, tiny}, MusicPath: song, Aspect: "9:16", Order: "date-taken", BeatCut: true, Transition: "fade"}
	if err := m.runPlan(context.Background(), job, req); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0] != song {
		t.Errorf("bars calls = %v", calls)
	}
	var res PlanResult
	if err := json.Unmarshal(result, &res); err != nil || res.ProjectID == "" {
		t.Fatalf("result = %s, %v", result, err)
	}
	doc, err := m.Get(context.Background(), res.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, c := range doc.Clips {
		order = append(order, filepath.Base(c.Path))
	}
	if strings.Join(order, ",") != "early.mp4,mid.jpg,late.mp4" {
		t.Errorf("clips = %v (unusable files are skipped, the rest ordered by date)", order)
	}
	if got := DurationMs(doc); got != 20000 {
		t.Errorf("duration = %d, want the song's 20000", got)
	}
	if len(logs) < 2 {
		t.Errorf("skips should be logged: %v", logs)
	}
	list, _ := m.docs.List(context.Background())
	if len(list) != 1 || !strings.HasPrefix(list[0].Name, "Vlog "+time.Now().Format("2006-01-02")) {
		t.Errorf("projects = %+v", list)
	}

	// Without beats the song only sets the length.
	calls = nil
	req.BeatCut, req.Transition = false, ""
	if err := m.runPlan(context.Background(), job, req); err != nil || len(calls) != 0 {
		t.Fatalf("no beats: %v %v", err, calls)
	}
	// Nothing usable.
	req.Paths = []string{bad}
	if err := m.runPlan(context.Background(), job, req); err == nil {
		t.Error("only unusable files")
	}
	// Cancelled.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req.Paths = []string{late}
	if err := m.runPlan(ctx, job, req); !errors.Is(err, context.Canceled) {
		t.Errorf("cancel: %v", err)
	}
}
