package pdf

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/store"
)

func TestParseRanges(t *testing.T) {
	tests := []struct {
		in    string
		total int
		want  []pageRange
		err   bool
	}{
		{"1-3, 5, 8-", 10, []pageRange{{1, 3}, {5, 5}, {8, 10}}, false},
		{" 2 ; 4-4 ", 5, []pageRange{{2, 2}, {4, 4}}, false},
		{"3-1", 5, nil, true},
		{"0", 5, nil, true},
		{"6", 5, nil, true},
		{"1-6", 5, nil, true},
		{"a", 5, nil, true},
		{"1--2", 5, nil, true},
		{"", 5, nil, true},
		{" , ", 5, nil, true},
		{"7-", 5, nil, true},
		{"1-3, 9", 0, []pageRange{{1, 3}, {9, 9}}, false}, // syntax only
		{"4-", 0, []pageRange{{4, 0}}, false},
	}
	for _, tc := range tests {
		got, err := parseRanges(tc.in, tc.total)
		if (err != nil) != tc.err {
			t.Errorf("parseRanges(%q, %d) err = %v", tc.in, tc.total, err)
			continue
		}
		if !tc.err && len(got) != len(tc.want) {
			t.Errorf("parseRanges(%q) = %v, want %v", tc.in, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("parseRanges(%q)[%d] = %v, want %v", tc.in, i, got[i], tc.want[i])
			}
		}
	}
	if got := pagesOf([]pageRange{{1, 2}, {5, 5}}); len(got) != 3 || got[2] != 5 {
		t.Errorf("pagesOf = %v", got)
	}
}

func TestSecrets(t *testing.T) {
	s := newSecrets()
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }
	ref := s.put("a", "b")
	if pw, np, ok := s.get(ref); !ok || pw != "a" || np != "b" {
		t.Fatalf("get = %q %q %v", pw, np, ok)
	}
	s.setJobs(ref, 2)
	s.jobDone(ref)
	if _, _, ok := s.get(ref); !ok {
		t.Fatal("secret dropped before the last job")
	}
	s.jobDone(ref)
	if _, _, ok := s.get(ref); ok {
		t.Fatal("secret kept after the last job")
	}
	// A job that finishes before setJobs is counted.
	ref = s.put("a", "")
	s.jobDone(ref)
	s.setJobs(ref, 1)
	if _, _, ok := s.get(ref); ok {
		t.Fatal("early completion not counted")
	}
	// TTL purge on the next put.
	old := s.put("x", "")
	now = now.Add(secretTTL + time.Second)
	s.put("y", "")
	if _, _, ok := s.get(old); ok {
		t.Fatal("expired secret kept")
	}
}

func TestValidate(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	a := writePDF(t, dir, "a.pdf", 2, 612, 792)
	b := writePDF(t, dir, "b.pdf", 2, 612, 792)
	img := gradientPNG(t, dir, "i.png", 10, 10)
	txt := filepath.Join(dir, "n.txt")
	if err := os.WriteFile(txt, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	withOpts := func(a Action, f func(*Options)) json.RawMessage {
		o := opts(a)
		if f != nil {
			f(&o)
		}
		return mustJSON(t, o)
	}
	tests := []struct {
		name   string
		inputs []string
		opts   json.RawMessage
		ok     bool
	}{
		{"merge ok", []string{a, b}, withOpts(ActionMerge, nil), true},
		{"merge one", []string{a}, withOpts(ActionMerge, nil), false},
		{"merge image", []string{a, img}, withOpts(ActionMerge, nil), false},
		{"images ok", []string{img}, withOpts(ActionImagesToPDF, nil), true},
		{"images with pdf", []string{a}, withOpts(ActionImagesToPDF, nil), false},
		{"images bad page size", []string{img}, withOpts(ActionImagesToPDF, func(o *Options) { o.PageSize = "b5" }), false},
		{"pdf action on txt", []string{txt}, withOpts(ActionCompress, nil), false},
		{"no inputs", nil, withOpts(ActionCompress, nil), false},
		{"unknown action", []string{a}, withOpts("explode", nil), false},
		{"unknown field", []string{a}, json.RawMessage(`{"action":"merge","nope":1}`), false},
		{"split ranges ok", []string{a}, withOpts(ActionSplit, func(o *Options) { o.SplitMode, o.Ranges = SplitRanges, "1-2, 4-" }), true},
		{"split ranges bad", []string{a}, withOpts(ActionSplit, func(o *Options) { o.SplitMode, o.Ranges = SplitRanges, "x" }), false},
		{"split every 0", []string{a}, withOpts(ActionSplit, func(o *Options) { o.Every = 0 }), false},
		{"organize ok", []string{a}, withOpts(ActionOrganize, func(o *Options) { o.Pages = []PageEdit{{1, 90}} }), true},
		{"organize two inputs", []string{a, b}, withOpts(ActionOrganize, func(o *Options) { o.Pages = []PageEdit{{1, 0}} }), false},
		{"organize no pages", []string{a}, withOpts(ActionOrganize, nil), false},
		{"organize bad rotation", []string{a}, withOpts(ActionOrganize, func(o *Options) { o.Pages = []PageEdit{{1, 45}} }), false},
		{"compress bad level", []string{a}, withOpts(ActionCompress, func(o *Options) { o.Level = "x" }), false},
		{"to images ok", []string{a}, withOpts(ActionPDFToImages, func(o *Options) { o.DPI, o.PageRange = 300, "1-2" }), true},
		{"to images bad dpi", []string{a}, withOpts(ActionPDFToImages, func(o *Options) { o.DPI = 100 }), false},
		{"protect without password", []string{a}, withOpts(ActionProtect, nil), false},
		{"unlock without password", []string{a}, withOpts(ActionUnlock, nil), false},
		{"missing file", []string{filepath.Join(dir, "missing.pdf")}, withOpts(ActionCompress, nil), false},
	}
	for _, tc := range tests {
		err := m.Validate(tc.inputs, tc.opts)
		if (err == nil) != tc.ok {
			t.Errorf("%s: err = %v, ok = %v", tc.name, err, tc.ok)
		}
		if err != nil && core.AsAppError(err).Code != core.CodeValidation && core.AsAppError(err).Code != core.CodeNotFound {
			t.Errorf("%s: code = %v", tc.name, core.AsAppError(err).Code)
		}
	}
	// Secret-dependent checks pass once the secret exists.
	o := opts(ActionProtect)
	o.PasswordRef = m.state.sec.put("", "pw")
	if err := m.Validate([]string{a}, mustJSON(t, o)); err != nil {
		t.Errorf("protect with secret: %v", err)
	}
}

func TestInfo(t *testing.T) {
	m := newTestModule(t)
	dir := t.TempDir()
	src := writePDF(t, dir, "doc.pdf", 3, 595, 842)
	in := mustInfo(t, m, src, "")
	if in.Pages != 3 || in.Encrypted || in.NeedsPassword || in.Restricted || in.HasBookmarks || len(in.PageSizes) != 3 ||
		in.PageSizes[0] != (PageSize{595, 842}) || in.Bytes == 0 || in.Path != src {
		t.Errorf("info = %+v", in)
	}
	if _, err := m.info(context.Background(), filepath.Join(dir, "nope.pdf"), ""); !isCode(err, core.CodeNotFound) {
		t.Errorf("missing err = %v", err)
	}
	bad := filepath.Join(dir, "bad.pdf")
	if err := os.WriteFile(bad, []byte("this is not a pdf"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := m.info(context.Background(), bad, ""); !isCode(err, core.CodeValidation) || !strings.Contains(core.AsAppError(err).Message, "damaged") {
		t.Errorf("bad err = %v", err)
	}
}

func TestThumbnail(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 3, 612, 792)
	url, err := m.thumbnail(context.Background(), src, 2, 200, "")
	if err != nil {
		t.Fatal(err)
	}
	b64, ok := strings.CutPrefix(url, "data:image/jpeg;base64,")
	if !ok {
		t.Fatalf("not a jpeg data url: %.40s", url)
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 200 || b.Dy() != 259 {
		t.Errorf("thumbnail = %dx%d, want 200x259", b.Dx(), b.Dy())
	}
	// Second call is served from the cache.
	if again, err := m.thumbnail(context.Background(), src, 2, 200, ""); err != nil || again != url {
		t.Errorf("cached thumbnail differs (err %v)", err)
	}
	for _, tc := range []struct{ page, width int }{{0, 200}, {4, 200}, {1, 79}, {1, 1201}} {
		if _, err := m.thumbnail(context.Background(), src, tc.page, tc.width, ""); !isCode(err, core.CodeValidation) {
			t.Errorf("thumbnail(%d,%d) err = %v", tc.page, tc.width, err)
		}
	}
}

func TestThumbnailEncrypted(t *testing.T) {
	m := newTestModule(t)
	src := writePDF(t, t.TempDir(), "doc.pdf", 2, 612, 792)
	o := opts(ActionProtect)
	o.PasswordRef = m.state.sec.put("", "pw")
	r, _, err := runJob(t, m, []string{src}, o)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.thumbnail(context.Background(), r.outputs[0], 1, 100, ""); !isCode(err, core.CodeValidation) {
		t.Errorf("no password err = %v", err)
	}
	if _, err := m.thumbnail(context.Background(), r.outputs[0], 1, 100, "bad"); err == nil || core.AsAppError(err).Message != "Wrong password" {
		t.Errorf("wrong password err = %v", err)
	}
	if _, err := m.thumbnail(context.Background(), r.outputs[0], 1, 100, "pw"); err != nil {
		t.Errorf("right password: %v", err)
	}
}

// End to end through the real job manager: passwords stay out of the stored
// options and are dropped once every job of the batch succeeded.
func TestEnqueueEndToEnd(t *testing.T) {
	support := t.TempDir()
	paths := core.NewPaths(support)
	if err := paths.Ensure(); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(paths.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	em := nopEmitter{}
	library := filepath.Join(t.TempDir(), "Library")
	settings, err := core.NewSettingsService(db, em, library)
	if err != nil {
		t.Fatal(err)
	}
	settings.SetSupportDir(paths.SupportDir)

	m := newTestModule(t)
	reg := core.NewRegistry()
	if err := Register(reg, m); err != nil {
		t.Fatal(err)
	}
	jobs := core.NewJobs(db, db, reg, em, func(string) (string, error) { return "", nil }, settings.Current, paths.TmpDir)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := jobs.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer jobs.Shutdown(5 * time.Second)
	svc := NewService(jobs, m)

	dir := t.TempDir()
	a := writePDF(t, dir, "a.pdf", 2, 612, 792)
	b := writePDF(t, dir, "b.pdf", 3, 612, 792)

	wait := func(js []core.Job) []core.Job {
		t.Helper()
		var done []core.Job
		for _, j := range js {
			for {
				cur, err := jobs.Get(ctx, j.ID)
				if err != nil {
					t.Fatal(err)
				}
				if cur.Status.Finished() {
					done = append(done, cur)
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
		}
		return done
	}

	// One job per input for protect; the password is not in the stored options.
	o := DefaultOptions()
	o.Action = ActionProtect
	js, err := svc.Enqueue([]string{a, b}, o, "", "topsecret")
	if err != nil {
		t.Fatal(err)
	}
	if len(js) != 2 {
		t.Fatalf("jobs = %d, want 2", len(js))
	}
	for _, j := range js {
		if strings.Contains(j.OptionsJSON, "topsecret") || !strings.Contains(j.OptionsJSON, `"passwordRef":"`) {
			t.Errorf("options = %s", j.OptionsJSON)
		}
	}
	done := wait(js)
	var protected []string
	for _, j := range done {
		if j.Status != core.JobDone {
			t.Fatalf("job %s: %s %s", j.ID, j.Status, j.Error)
		}
		stored, _ := jobs.Get(ctx, j.ID)
		if strings.Contains(stored.OptionsJSON, "topsecret") || strings.Contains(stored.ResultJSON, "topsecret") {
			t.Error("password leaked into the stored job")
		}
		for _, o := range stored.Outputs {
			protected = append(protected, o.Path)
		}
	}
	if len(protected) != 2 {
		t.Fatalf("protected outputs = %v", protected)
	}
	var opts Options
	_ = json.Unmarshal([]byte(js[0].OptionsJSON), &opts)
	if _, _, ok := m.state.sec.get(opts.PasswordRef); ok {
		t.Error("secret kept after all jobs succeeded")
	}

	// Merge needs the password up front (submit-time check), and a wrong one is refused.
	mo := DefaultOptions()
	if _, err := svc.Enqueue(protected, mo, "", ""); !isCode(err, core.CodeValidation) {
		t.Errorf("merge without password err = %v", err)
	}
	if _, err := svc.Enqueue(protected, mo, "nope", ""); !isCode(err, core.CodeValidation) {
		t.Errorf("merge wrong password err = %v", err)
	}
	js, err = svc.Enqueue(protected, mo, "topsecret", "")
	if err != nil || len(js) != 1 {
		t.Fatalf("merge enqueue: %v %v", js, err)
	}
	if j := wait(js)[0]; j.Status != core.JobDone {
		t.Fatalf("merge job: %s %s", j.Status, j.Error)
	}

	// Page references are checked against the document at submit time.
	so := DefaultOptions()
	so.Action, so.SplitMode, so.Ranges = ActionSplit, SplitRanges, "1-9"
	if _, err := svc.Enqueue([]string{a}, so, "", ""); !isCode(err, core.CodeValidation) {
		t.Errorf("split out of range err = %v", err)
	}
	if _, err := svc.Enqueue(nil, so, "", ""); !isCode(err, core.CodeValidation) {
		t.Errorf("no inputs err = %v", err)
	}
	uo := DefaultOptions()
	uo.Action = ActionUnlock
	if _, err := svc.Enqueue(protected[:1], uo, "", ""); !isCode(err, core.CodeValidation) {
		t.Errorf("unlock without password err = %v", err)
	}
}

type nopEmitter struct{}

func (nopEmitter) Emit(string, any) {}
