package organize

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math/bits"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/image/draw"

	"toolbox/core"
)

// TestMain turns the test binary into a fake exiftool when FAKE_EXIFTOOL=1.
// It reads file names from stdin and prints the JSON `exiftool -j` would.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_EXIFTOOL") == "1" {
		sc := bufio.NewScanner(os.Stdin)
		var rows []map[string]string
		for sc.Scan() {
			p := strings.TrimSpace(sc.Text())
			if p == "" {
				continue
			}
			row := map[string]string{"SourceFile": filepath.ToSlash(p)}
			if !strings.Contains(p, "nodate") {
				row["DateTimeOriginal"] = "2019:07:04 10:11:12"
				row["Make"] = "Canon"
				row["Model"] = "Canon EOS R5"
			}
			rows = append(rows, row)
		}
		b, _ := json.Marshal(rows)
		fmt.Println(string(b))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func write(t *testing.T, path, content string, mod time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if !mod.IsZero() {
		if err := os.Chtimes(path, mod, mod); err != nil {
			t.Fatal(err)
		}
	}
}

func day(y int, mo time.Month, d int) time.Time { return time.Date(y, mo, d, 12, 0, 0, 0, time.Local) }

func TestExpandPattern(t *testing.T) {
	v := patternVars{Taken: time.Date(2024, 6, 3, 14, 0, 0, 0, time.UTC), Type: "Photos", Camera: "Canon EOS R5", Ext: "jpg"}
	tests := []struct {
		pattern, want string
		wantErr       bool
	}{
		{"{yyyy}/{mm}/{dd}", "2024/06/03", false},
		{DatePattern, "2024/2024-06", false},
		{"{type}", "Photos", false},
		{"{camera}/{ext}", "Canon EOS R5/jpg", false},
		{`{yyyy}\{type}`, "2024/Photos", false},
		{"//{yyyy}//", "", true},
		{"{yyyy} {mm} trip", "2024 06 trip", false},
		{"{year}", "", true},
		{"{yyyy", "", true},
		{"", "", true},
		{"/abs/{yyyy}", "", true},
		{"C:/x", "", true},
		{"{yyyy}/../{mm}", "", true},
		{"a/b/c/d/e/f/g", "", true},
	}
	for _, tt := range tests {
		got, err := expandPattern(tt.pattern, v)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("expandPattern(%q) = %q, %v; want %q (err %v)", tt.pattern, got, err, tt.want, tt.wantErr)
		}
	}
	// Values are sanitised; empty camera and ext have names.
	got, _ := expandPattern("{camera}/{ext}", patternVars{Taken: v.Taken, Camera: "A/B:C"})
	if got != "A_B_C/none" {
		t.Errorf("sanitised = %q", got)
	}
	got, _ = expandPattern("{camera}", patternVars{Taken: v.Taken})
	if got != UnknownCamera {
		t.Errorf("no camera = %q", got)
	}
}

func TestTypeOfAndCamera(t *testing.T) {
	for p, want := range map[string]string{
		"a.JPG": TypePhotos, "a.heic": TypePhotos, "a.cr3": TypePhotos, "a.mp4": TypeVideos,
		"a.mp3": TypeAudio, "a.pdf": TypeDocuments, "a.xyz": TypeOther, "noext": TypeOther,
	} {
		if got := typeOf(p); got != want {
			t.Errorf("typeOf(%s) = %s, want %s", p, got, want)
		}
	}
	if got := cameraName("Canon", "Canon EOS R5"); got != "Canon EOS R5" {
		t.Errorf("camera = %q", got)
	}
	if got := cameraName("Apple", "iPhone 15"); got != "Apple iPhone 15" {
		t.Errorf("camera = %q", got)
	}
}

func TestParseExifJSON(t *testing.T) {
	got, err := parseExifJSON([]byte(`[
	 {"SourceFile":"C:/p/a.jpg","DateTimeOriginal":"2021:02:03 04:05:06","Make":"Apple","Model":"iPhone 12"},
	 {"SourceFile":"C:/p/b.mov","CreateDate":"2020:01:02 03:04:05+01:00"},
	 {"SourceFile":"C:/p/c.mov","CreateDate":"0000:00:00 00:00:00"}]`))
	if err != nil {
		t.Fatal(err)
	}
	a := got[pathKey(filepath.FromSlash("C:/p/a.jpg"))]
	if a.Taken.Year() != 2021 || a.Taken.Hour() != 4 || a.Camera != "Apple iPhone 12" {
		t.Errorf("a = %+v", a)
	}
	if b := got[pathKey(filepath.FromSlash("C:/p/b.mov"))]; b.Taken.Year() != 2020 || b.Taken.Day() != 2 {
		t.Errorf("b = %+v", b)
	}
	if c := got[pathKey(filepath.FromSlash("C:/p/c.mov"))]; !c.Taken.IsZero() {
		t.Errorf("zero date should be unknown: %+v", c)
	}
}

func TestExiftoolReaderRunsTheTool(t *testing.T) {
	t.Setenv("FAKE_EXIFTOOL", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	a := filepath.Join(dir, "ünï cödé", "a.jpg")
	b := filepath.Join(dir, "nodate.jpg")
	got, err := exiftoolReader(exe)(context.Background(), []string{a, b}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m := got[pathKey(a)]; m.Taken.Year() != 2019 || m.Camera != "Canon EOS R5" {
		t.Errorf("a = %+v", m)
	}
	if m := got[pathKey(b)]; !m.Taken.IsZero() {
		t.Errorf("b = %+v", m)
	}
}

// ---- perceptual hash ----

func noise(seed int64, w, h int) *image.NRGBA {
	r := rand.New(rand.NewSource(seed))
	const cell = 20
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for cy := 0; cy*cell < h; cy++ {
		for cx := 0; cx*cell < w; cx++ {
			v := uint8(r.Intn(256))
			for y := cy * cell; y < min((cy+1)*cell, h); y++ {
				for x := cx * cell; x < min((cx+1)*cell, w); x++ {
					img.SetNRGBA(x, y, color.NRGBA{v, v, v, 255})
				}
			}
		}
	}
	return img
}

func resize(src image.Image, w, h int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return dst
}

func TestDHashSimilarity(t *testing.T) {
	a := noise(1, 360, 320)
	smaller := resize(a, 180, 160)
	other := noise(2, 360, 320)
	ha, hs, ho := dHashImage(a), dHashImage(smaller), dHashImage(other)
	dist := func(x, y photoHash) int { return bits.OnesCount64(x.Bits ^ y.Bits) }
	limit := maxDistance(90)
	if d := dist(ha, hs); d > limit || !ha.Alike(hs, limit) {
		t.Errorf("resized copy is %d bits away (limit %d)", d, limit)
	}
	if d := dist(ha, ho); d <= limit || ha.Alike(ho, limit) {
		t.Errorf("a different picture is only %d bits away (limit %d)", d, limit)
	}
	// Flat pictures hash alike but differ in brightness.
	flat := func(v uint8) photoHash {
		img := image.NewNRGBA(image.Rect(0, 0, 64, 64))
		draw.Draw(img, img.Bounds(), &image.Uniform{color.NRGBA{v, v, v, 255}}, image.Point{}, draw.Src)
		return dHashImage(img)
	}
	if flat(20).Alike(flat(230), maxDistance(90)) {
		t.Error("a black and a white picture must not match")
	}
}

func TestMaxDistance(t *testing.T) {
	for sim, want := range map[int]int{99: 0, 90: 6, 80: 12, 70: 19, 50: 19, 100: 0} {
		if got := maxDistance(sim); got != want {
			t.Errorf("maxDistance(%d) = %d, want %d", sim, got, want)
		}
	}
}

func writePNG(t *testing.T, path string, img image.Image) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

// ---- planning ----

func buildPlan(t *testing.T, inputs []string, opts Options) *plan {
	t.Helper()
	pl, err := newPlanner(nil, nil).build(context.Background(), inputs, opts)
	if err != nil {
		t.Fatal(err)
	}
	return pl
}

func entryFor(t *testing.T, pl *plan, name string) *entry {
	t.Helper()
	for _, e := range pl.Entries {
		if filepath.Base(e.Src) == name {
			return e
		}
	}
	t.Fatalf("no entry %s", name)
	return nil
}

func TestGroupingAndExactDuplicates(t *testing.T) {
	src := t.TempDir()
	write(t, filepath.Join(src, "a.jpg"), "same bytes", day(2021, 3, 5))
	write(t, filepath.Join(src, "sub", "copy of a.jpg"), "same bytes", day(2022, 1, 1))
	write(t, filepath.Join(src, "older", "a.jpg"), "same bytes", day(2020, 1, 1)) // same name, oldest: the keeper
	write(t, filepath.Join(src, "b.jpg"), "other bytes", day(2021, 3, 6))
	write(t, filepath.Join(src, "c.mp4"), "video", day(2021, 4, 1))
	write(t, filepath.Join(src, "empty1.txt"), "", day(2021, 4, 1))
	write(t, filepath.Join(src, "empty2.txt"), "", day(2021, 4, 1))
	write(t, filepath.Join(src, ".hidden.jpg"), "h", day(2021, 4, 1))
	write(t, filepath.Join(src, "Thumbs.db"), "t", day(2021, 4, 1))
	write(t, filepath.Join(src, ".git", "x.jpg"), "x", day(2021, 4, 1))

	opts := DefaultOptions()
	pl := buildPlan(t, []string{src}, opts)
	if len(pl.Entries) != 7 {
		t.Fatalf("entries = %d, want 7 (hidden and system files ignored)", len(pl.Entries))
	}
	keep := entryFor(t, pl, "a.jpg") // sorted by path: "a.jpg" at the top comes before "older/a.jpg"
	_ = keep
	var keeper *entry
	dups := 0
	for _, e := range pl.Entries {
		if e.DupOf >= 0 {
			dups++
			keeper = pl.keeper(e)
		}
	}
	if dups != 2 {
		t.Fatalf("duplicates = %d, want 2 (empty files are never duplicates)", dups)
	}
	if !strings.HasSuffix(filepath.ToSlash(keeper.Src), "older/a.jpg") {
		t.Errorf("keeper = %s, want the oldest copy", keeper.Src)
	}
	if keeper.Dest != "2020/2020-01/a.jpg" {
		t.Errorf("keeper dest = %q", keeper.Dest)
	}
	for _, e := range pl.Entries {
		if e.DupOf >= 0 && !strings.HasPrefix(e.Dest, "Duplicates/") {
			t.Errorf("duplicate %s goes to %q", e.Src, e.Dest)
		}
	}
	// Same names in Duplicates/ get numbered, never overwritten.
	seen := map[string]bool{}
	for _, e := range pl.Entries {
		if e.Dest == "" {
			continue
		}
		k := strings.ToLower(e.Dest)
		if seen[k] {
			t.Errorf("destination %q used twice", e.Dest)
		}
		seen[k] = true
	}

	// Skip: not copied.
	opts.DupAction = ActionSkip
	pl = buildPlan(t, []string{src}, opts)
	skipped := 0
	for _, e := range pl.Entries {
		if e.DupOf >= 0 && e.Dest == "" {
			skipped++
		}
	}
	if skipped != 2 {
		t.Errorf("skipped = %d", skipped)
	}

	// Off: nothing is a duplicate and equal names are numbered.
	opts = DefaultOptions()
	opts.Duplicates = DupOff
	opts.GroupBy = GroupType
	pl = buildPlan(t, []string{src}, opts)
	names := map[string]bool{}
	for _, e := range pl.Entries {
		if e.DupOf >= 0 {
			t.Errorf("duplicates off, but %s is a duplicate", e.Src)
		}
		names[e.Dest] = true
	}
	for _, want := range []string{"Photos/a.jpg", "Photos/a (2).jpg", "Photos/copy of a.jpg", "Videos/c.mp4", "Documents/empty1.txt"} {
		if !names[want] {
			t.Errorf("missing %s in %v", want, names)
		}
	}
}

func TestKeepBestPrefersResolutionThenAge(t *testing.T) {
	small := &entry{Src: "/s", W: 100, H: 100, Taken: day(2020, 1, 1), Size: 5}
	big := &entry{Src: "/b", W: 200, H: 100, Taken: day(2022, 1, 1), Size: 5}
	old := &entry{Src: "/o", W: 200, H: 100, Taken: day(2019, 1, 1), Size: 5}
	if !better(big, small) || better(small, big) {
		t.Error("the larger picture must win over the older one")
	}
	if !better(old, big) || better(big, old) {
		t.Error("equal sizes: the oldest wins")
	}
	same1 := &entry{Src: "/a", Taken: day(2020, 1, 1), Size: 5}
	same2 := &entry{Src: "/b", Taken: day(2020, 1, 1), Size: 5}
	if !better(same1, same2) {
		t.Error("ties fall back to the path")
	}
}

func TestSimilarPhotos(t *testing.T) {
	src := t.TempDir()
	a := noise(7, 360, 320)
	writePNG(t, filepath.Join(src, "orig.png"), a)
	writePNG(t, filepath.Join(src, "small.png"), resize(a, 180, 160))
	writePNG(t, filepath.Join(src, "other.png"), noise(8, 360, 320))
	write(t, filepath.Join(src, "notes.txt"), "text", day(2021, 1, 1))

	opts := DefaultOptions()
	opts.Duplicates = DupSimilar
	pl := buildPlan(t, []string{src}, opts)
	orig, small, other := entryFor(t, pl, "orig.png"), entryFor(t, pl, "small.png"), entryFor(t, pl, "other.png")
	if orig.DupOf != -1 {
		t.Errorf("the larger copy must stay: %+v", orig)
	}
	if small.DupOf < 0 || pl.keeper(small) != orig || !small.Similar {
		t.Errorf("the resized copy should be a similar duplicate of the original: %+v", small)
	}
	if other.DupOf != -1 {
		t.Errorf("a different picture must not be a duplicate: %+v", other)
	}
	if orig.W != 360 || orig.H != 320 {
		t.Errorf("size = %dx%d", orig.W, orig.H)
	}

	// Exact mode doesn't look at pictures.
	opts.Duplicates = DupExact
	pl = buildPlan(t, []string{src}, opts)
	for _, e := range pl.Entries {
		if e.DupOf >= 0 {
			t.Errorf("exact mode flagged %s", e.Src)
		}
	}
}

func TestMetadataDrivesFolders(t *testing.T) {
	src := t.TempDir()
	write(t, filepath.Join(src, "a.jpg"), "1", day(2001, 1, 1))
	write(t, filepath.Join(src, "nodate.jpg"), "2", day(2001, 2, 1))
	read := func(_ context.Context, paths []string, _ func(done, total int)) (map[string]exifMeta, error) {
		out := map[string]exifMeta{}
		for _, p := range paths {
			if !strings.Contains(p, "nodate") {
				out[pathKey(p)] = exifMeta{Taken: time.Date(2019, 7, 4, 10, 0, 0, 0, time.UTC), Camera: "Canon EOS R5"}
			}
		}
		return out, nil
	}
	opts := DefaultOptions()
	opts.GroupBy = GroupPattern
	opts.Pattern = "{camera}/{yyyy}-{mm}-{dd}"
	pl, err := newPlanner(read, nil).build(context.Background(), []string{src}, opts)
	if err != nil {
		t.Fatal(err)
	}
	if got := entryFor(t, pl, "a.jpg").Dest; got != "Canon EOS R5/2019-07-04/a.jpg" {
		t.Errorf("a = %q", got)
	}
	if got := entryFor(t, pl, "nodate.jpg").Dest; got != "Unknown camera/2001-02-01/nodate.jpg" {
		t.Errorf("nodate = %q", got)
	}
}

func TestExpandInputs(t *testing.T) {
	src := t.TempDir()
	write(t, filepath.Join(src, "a.txt"), "a", time.Time{})
	write(t, filepath.Join(src, "d", "b.txt"), "b", time.Time{})
	write(t, filepath.Join(src, ".hid", "c.txt"), "c", time.Time{})
	got, err := expandInputs(context.Background(), []string{src, filepath.Join(src, "a.txt")})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range got {
		names = append(names, filepath.Base(p))
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"a.txt", "b.txt"}) {
		t.Errorf("names = %v", names)
	}
	if _, err := expandInputs(context.Background(), []string{filepath.Join(src, "missing")}); err == nil {
		t.Error("a missing input must fail")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := expandInputs(ctx, []string{src}); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled expand = %v", err)
	}
}

func TestCheckRoot(t *testing.T) {
	base := t.TempDir()
	in := filepath.Join(base, "photos")
	file := filepath.Join(base, "x", "a.jpg")
	write(t, filepath.Join(in, "a.jpg"), "a", time.Time{})
	write(t, file, "a", time.Time{})
	for _, tt := range []struct {
		name, root string
		bad        bool
	}{
		{"sibling", filepath.Join(base, "out"), false},
		{"inside folder input", filepath.Join(in, "sorted"), true},
		{"the folder itself", in, true},
		{"above the folder", base, true},
		{"above a file", filepath.Join(base, "x"), true},
		{"next to a file", filepath.Join(base, "x2"), false},
	} {
		err := checkRoot(tt.root, []string{in, file})
		if (err != nil) != tt.bad {
			t.Errorf("%s: err = %v, bad = %v", tt.name, err, tt.bad)
		}
	}
}

func TestValidate(t *testing.T) {
	m := New(nil)
	dir := t.TempDir()
	in := filepath.Join(dir, "in")
	write(t, filepath.Join(in, "a.jpg"), "a", time.Time{})
	opts := func(f func(*Options)) json.RawMessage {
		o := DefaultOptions()
		if f != nil {
			f(&o)
		}
		b, _ := json.Marshal(o)
		return b
	}
	if err := m.Validate([]string{in}, opts(nil)); err != nil {
		t.Errorf("defaults: %v", err)
	}
	for name, tt := range map[string]struct {
		inputs []string
		opts   json.RawMessage
		field  string
	}{
		"none":        {nil, opts(nil), "inputs"},
		"relative":    {[]string{"a.jpg"}, opts(nil), "inputs.0"},
		"missing":     {[]string{filepath.Join(dir, "nope")}, opts(nil), "inputs.0"},
		"group":       {[]string{in}, opts(func(o *Options) { o.GroupBy = "x" }), "groupBy"},
		"pattern":     {[]string{in}, opts(func(o *Options) { o.GroupBy = GroupPattern; o.Pattern = "{nope}" }), "pattern"},
		"dups":        {[]string{in}, opts(func(o *Options) { o.Duplicates = "x" }), "duplicates"},
		"similarity":  {[]string{in}, opts(func(o *Options) { o.Duplicates = DupSimilar; o.Similarity = 10 }), "similarity"},
		"action":      {[]string{in}, opts(func(o *Options) { o.DupAction = "x" }), "dupAction"},
		"relative to": {[]string{in}, opts(func(o *Options) { o.Destination = "out" }), "destination"},
		"inside":      {[]string{in}, opts(func(o *Options) { o.Destination = filepath.Join(in, "out") }), "destination"},
		"above":       {[]string{in}, opts(func(o *Options) { o.Destination = dir }), "destination"},
		"run name":    {[]string{in}, opts(func(o *Options) { o.RunName = "a/b" }), "runName"},
	} {
		err := m.Validate(tt.inputs, tt.opts)
		ae := core.AsAppError(err)
		if ae == nil || ae.Code != core.CodeValidation {
			t.Errorf("%s: err = %v", name, err)
			continue
		}
		if _, ok := ae.Fields[tt.field]; !ok {
			t.Errorf("%s: fields = %v, want %s", name, ae.Fields, tt.field)
		}
	}
	if err := m.Validate([]string{in}, opts(func(o *Options) { o.Destination = filepath.Join(dir, "out") })); err != nil {
		t.Errorf("a separate destination: %v", err)
	}
	if err := m.Validate([]string{in}, json.RawMessage(`{"bogus":1}`)); err == nil {
		t.Error("unknown fields must fail")
	}
}

// ---- running ----

type recorder struct {
	mu       sync.Mutex
	outputs  []string
	progress []float64
	result   json.RawMessage
}

func (r *recorder) job(inputs []string, out, tmp string, opts Options) *core.JobContext {
	raw, _ := json.Marshal(opts)
	return core.NewJobContext(core.JobContext{ID: "j", ModuleID: ModuleID, Inputs: inputs, Options: raw, OutputDir: out, TempDir: tmp}, core.JobHooks{
		Progress: func(pct float64, _ string) { r.mu.Lock(); r.progress = append(r.progress, pct); r.mu.Unlock() },
		Output: func(path string) (core.Output, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.outputs = append(r.outputs, path)
			return core.NewOutput(path, "j", ModuleID)
		},
		Result: func(b json.RawMessage) { r.result = b },
	})
}

func snapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p)
			st, _ := d.Info()
			out[p] = fmt.Sprintf("%s|%d", b, st.ModTime().UnixNano())
		}
		return nil
	})
	return out
}

func TestRunCopiesAndWritesReport(t *testing.T) {
	src := t.TempDir()
	lib := t.TempDir()
	write(t, filepath.Join(src, "a.jpg"), "same", day(2021, 3, 5))
	write(t, filepath.Join(src, "dir", "b.jpg"), "same", day(2022, 3, 5))
	write(t, filepath.Join(src, "dir", "c, d.pdf"), "doc", day(2021, 3, 9))
	before := snapshot(t, src)

	rec := &recorder{}
	m := New(nil)
	opts := DefaultOptions()
	opts.RunName = "trip"
	if err := m.Run(context.Background(), rec.job([]string{src}, lib, t.TempDir(), opts)); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(t, src); !reflect.DeepEqual(before, after) {
		t.Fatal("the input folder changed")
	}
	root := filepath.Join(lib, "trip")
	for _, want := range []string{"2021/2021-03/a.jpg", "2021/2021-03/c, d.pdf", "Duplicates/b.jpg", "report.csv"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(want))); err != nil {
			t.Errorf("missing %s: %v", want, err)
		}
	}
	// Modified times are kept.
	if st, _ := os.Stat(filepath.Join(root, "2021", "2021-03", "a.jpg")); st == nil || !st.ModTime().Equal(day(2021, 3, 5)) {
		t.Errorf("mod time not kept: %v", st)
	}
	if matches, _ := filepath.Glob(filepath.Join(root, "*", "*.part")); len(matches) != 0 {
		t.Errorf("leftover part files: %v", matches)
	}

	raw, err := os.ReadFile(filepath.Join(root, "report.csv"))
	if err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(raw), "\xEF\xBB\xBF"))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 4 || !reflect.DeepEqual(rows[0], []string{"original", "copy", "group", "duplicate_of", "match"}) {
		t.Fatalf("rows = %v", rows)
	}
	for _, r := range rows[1:] {
		if strings.HasSuffix(r[0], "b.jpg") {
			if r[3] != filepath.Join(src, "a.jpg") || r[2] != "Duplicates" || r[4] != "exact" || !strings.Contains(r[1], "Duplicates") {
				t.Errorf("duplicate row = %v", r)
			}
		}
	}

	var sum Summary
	if err := json.Unmarshal(rec.result, &sum); err != nil {
		t.Fatal(err)
	}
	if sum.Copied != 2 || sum.Duplicates != 1 || sum.Skipped != 0 || sum.Failed != 0 || sum.Root != root || sum.Report != filepath.Join(root, "report.csv") {
		t.Errorf("summary = %+v", sum)
	}
	if len(rec.outputs) != 4 || filepath.Base(rec.outputs[3]) != "report.csv" {
		t.Errorf("outputs = %v", rec.outputs)
	}

	// StepOutputs reads the roles back.
	var outs []core.Output
	for _, p := range rec.outputs {
		o, _ := core.NewOutput(p, "j", ModuleID)
		outs = append(outs, o)
	}
	res, err := m.StepOutputs(core.Job{Outputs: outs})
	if err != nil {
		t.Fatal(err)
	}
	roles := map[string]int{}
	for _, f := range res.Files {
		roles[f.Role]++
	}
	if !reflect.DeepEqual(roles, map[string]int{"file": 2, "duplicate": 1, "report": 1}) || res.Vars["folder"] != root {
		t.Errorf("roles = %v vars = %v", roles, res.Vars)
	}

	// A second run gets its own folder.
	if err := m.Run(context.Background(), rec.job([]string{src}, lib, t.TempDir(), opts)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(lib, "trip (2)", "report.csv")); err != nil {
		t.Errorf("second run folder: %v", err)
	}
}

func TestRunNeverWritesInsideInputs(t *testing.T) {
	src := t.TempDir()
	write(t, filepath.Join(src, "a.jpg"), "a", day(2021, 3, 5))
	m := New(nil)
	rec := &recorder{}
	before := snapshot(t, src)
	// The library output dir is inside the input folder.
	err := m.Run(context.Background(), rec.job([]string{src}, filepath.Join(src, "Organized"), t.TempDir(), DefaultOptions()))
	if ae := core.AsAppError(err); ae == nil || ae.Code != core.CodeValidation {
		t.Fatalf("err = %v", err)
	}
	// So is an explicit destination.
	o := DefaultOptions()
	o.Destination = src
	if err := m.Run(context.Background(), rec.job([]string{src}, t.TempDir(), t.TempDir(), o)); err == nil {
		t.Fatal("a destination equal to the input must fail")
	}
	if after := snapshot(t, src); !reflect.DeepEqual(before, after) {
		t.Fatal("the input folder changed")
	}
	entries, _ := os.ReadDir(src)
	if len(entries) != 1 {
		t.Errorf("input folder now has %d entries", len(entries))
	}
}

func TestRunWithFakeExiftool(t *testing.T) {
	t.Setenv("FAKE_EXIFTOOL", "1")
	exe, _ := os.Executable()
	src := t.TempDir()
	lib := t.TempDir()
	write(t, filepath.Join(src, "a.jpg"), "a", day(2001, 1, 1))
	write(t, filepath.Join(src, "nodate.jpg"), "b", day(2001, 2, 1))
	m := New(func(string) (string, error) { return exe, nil })
	rec := &recorder{}
	raw, _ := json.Marshal(DefaultOptions())
	job := core.NewJobContext(core.JobContext{ID: "j", ModuleID: ModuleID, Inputs: []string{src}, Options: raw, OutputDir: lib, TempDir: t.TempDir()}, core.JobHooks{
		Output: func(p string) (core.Output, error) {
			rec.outputs = append(rec.outputs, p)
			return core.NewOutput(p, "j", ModuleID)
		},
		Tool: func(string) (string, error) { return exe, nil },
	})
	if err := m.Run(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, p := range rec.outputs {
		rel, _ := filepath.Rel(lib, p)
		found = append(found, filepath.ToSlash(rel))
	}
	joined := strings.Join(found, "|")
	if !strings.Contains(joined, "/2019/2019-07/a.jpg") || !strings.Contains(joined, "/2001/2001-02/nodate.jpg") {
		t.Errorf("outputs = %v", found)
	}
}

func TestRunCancel(t *testing.T) {
	src := t.TempDir()
	lib := t.TempDir()
	for i := 0; i < 20; i++ {
		write(t, filepath.Join(src, fmt.Sprintf("f%02d.txt", i)), fmt.Sprint(i), day(2021, 1, 1))
	}
	ctx, cancel := context.WithCancel(context.Background())
	rec := &recorder{}
	raw, _ := json.Marshal(DefaultOptions())
	n := 0
	job := core.NewJobContext(core.JobContext{ID: "j", ModuleID: ModuleID, Inputs: []string{src}, Options: raw, OutputDir: lib, TempDir: t.TempDir()}, core.JobHooks{
		Progress: func(pct float64, msg string) {
			if strings.HasPrefix(msg, "Copying") {
				if n++; n == 3 {
					cancel()
				}
			}
		},
		Output: func(p string) (core.Output, error) { return core.NewOutput(p, "j", ModuleID) },
	})
	err := New(nil).Run(ctx, job)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	_ = rec
	var copied int
	_ = filepath.WalkDir(lib, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if strings.HasSuffix(p, ".part") {
				t.Errorf("left a partial file: %s", p)
			}
			copied++
		}
		return nil
	})
	if copied >= 20 {
		t.Errorf("cancel did not stop the copy (%d files)", copied)
	}
	// Planning honours cancel too.
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	if _, err := newPlanner(nil, nil).build(ctx2, []string{src}, DefaultOptions()); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled plan = %v", err)
	}
	// And so does hashing.
	if _, err := sha256File(ctx2, filepath.Join(src, "f00.txt"), nil); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled hash = %v", err)
	}
}

func TestPreview(t *testing.T) {
	src := t.TempDir()
	write(t, filepath.Join(src, "a.jpg"), "same", day(2021, 3, 5))
	write(t, filepath.Join(src, "b.jpg"), "same", day(2021, 3, 6))
	write(t, filepath.Join(src, "c.pdf"), "doc", day(2022, 1, 9))
	s := NewService(nil, New(nil))
	p, err := s.Preview([]string{src}, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if p.Total != 3 || p.Duplicates != 1 || p.DateSource != "modified" || len(p.Groups) != 1 || len(p.Groups[0].Others) != 1 || p.Groups[0].Match != "exact" {
		t.Errorf("preview = %+v", p)
	}
	want := []PreviewFolder{{"2021/2021-03", 1}, {"2022/2022-01", 1}, {"Duplicates", 1}}
	if !reflect.DeepEqual(p.Folders, want) {
		t.Errorf("folders = %v", p.Folders)
	}
	if entries, _ := os.ReadDir(src); len(entries) != 3 {
		t.Error("preview must not write anything")
	}
	exp, err := s.Expand([]string{src})
	if err != nil || len(exp) != 3 {
		t.Errorf("expand = %v, %v", exp, err)
	}
}

func TestDescribeAndPrepareStep(t *testing.T) {
	m := New(nil)
	info, err := m.DescribeStep(nil)
	if err != nil {
		t.Fatal(err)
	}
	var roles []string
	for _, p := range info.Produces {
		roles = append(roles, p.Role)
	}
	if !reflect.DeepEqual(roles, []string{"file", "duplicate", "report"}) || !info.Together || !info.Accepts.Any || info.Summary == "" {
		t.Errorf("info = %+v", info)
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"groupBy":"pattern","pattern":"{x}"}`)); err == nil {
		t.Error("a bad pattern must be a problem")
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"nope":1}`)); err == nil {
		t.Error("unknown option must be a problem")
	}

	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.jpg"), filepath.Join(dir, "b.jpg")
	write(t, a, "1", time.Time{})
	write(t, b, "2", time.Time{})
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{Pipeline: "Camera roll", Items: []core.StepItem{
		{Files: []core.RunFile{{Path: a}}}, {Files: []core.RunFile{{Path: b}, {Path: a}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || !reflect.DeepEqual(jobs[0].Inputs, []string{a, b}) {
		t.Fatalf("jobs = %+v", jobs)
	}
	if o, ok := jobs[0].Options.(Options); !ok || o.RunName != "Camera roll" {
		t.Errorf("options = %+v", jobs[0].Options)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{}); err == nil {
		t.Error("no files must fail")
	}
}
