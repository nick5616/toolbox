package vault

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

type fixture struct {
	t       *testing.T
	v       *Vault
	lib     string
	openDir string
	src     string
	clock   time.Time
	minutes int
	opened  []string

	mu      sync.Mutex
	states  []core.VaultState
	outputs []string
}

const testPass = "correct horse battery"

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	f := &fixture{
		t: t, lib: filepath.Join(root, "lib"), openDir: filepath.Join(root, "tmp", "vault-open"),
		src: filepath.Join(root, "src"), clock: time.Unix(1_700_000_000, 0), minutes: 10,
	}
	for _, d := range []string{f.lib, f.src} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	f.v = New(Config{
		LibraryDir: func() string { return f.lib }, OpenDir: f.openDir,
		Emitter: core.EmitterFunc(func(name string, data any) {
			if st, ok := data.(core.VaultState); ok && name == core.EventVaultState {
				f.mu.Lock()
				f.states = append(f.states, st)
				f.mu.Unlock()
			}
		}),
		OpenFile: func(p string) error { f.opened = append(f.opened, p); return nil },
	})
	f.v.workFactor = 10
	f.v.now = func() time.Time { return f.clock }
	f.v.minutes = func() int { return f.minutes }
	f.v.retryEvery = 20 * time.Millisecond
	t.Cleanup(f.v.Close)
	return f
}

func (f *fixture) createUnlocked() string {
	f.t.Helper()
	key, err := f.v.create(testPass)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := f.v.unlock(testPass); err != nil {
		f.t.Fatal(err)
	}
	return key
}

func (f *fixture) write(name string, data []byte) string {
	f.t.Helper()
	p := filepath.Join(f.src, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func (f *fixture) job(ctx context.Context, inputs []string, o Options, progress func(float64, string)) (error, []string) {
	f.t.Helper()
	b, _ := json.Marshal(o)
	if err := f.v.validate(inputs, b); err != nil {
		return err, nil
	}
	out := filepath.Join(f.lib, "Vault exports")
	_ = os.MkdirAll(out, 0o755)
	var outs []string
	jc := core.NewJobContext(core.JobContext{ID: "j", Inputs: inputs, Options: b, OutputDir: out, TempDir: f.t.TempDir()},
		core.JobHooks{
			Progress: progress,
			Output: func(p string) (core.Output, error) {
				outs = append(outs, p)
				return core.Output{Path: p}, nil
			},
		})
	return f.v.run(ctx, jc), outs
}

func (f *fixture) add(folder string, paths ...string) {
	f.t.Helper()
	if err, _ := f.job(context.Background(), paths, Options{Action: ActionAdd, Folder: folder}, nil); err != nil {
		f.t.Fatal(err)
	}
}

func isValidation(err error, msg string) bool {
	ae := core.AsAppError(err)
	return ae != nil && ae.Code == core.CodeValidation && ae.Message == msg
}

func TestCreateUnlockAndRecovery(t *testing.T) {
	f := newFixture(t)
	if f.v.state().Exists {
		t.Fatal("exists before create")
	}
	if _, err := f.v.create("short"); err == nil {
		t.Fatal("short passphrase accepted")
	}
	key := f.createUnlocked()
	if !strings.HasPrefix(key, recoveryPrefix) {
		t.Fatalf("recovery key = %q", key)
	}
	if _, err := f.v.create(testPass); !core.IsCode(err, core.CodeConflict) {
		t.Fatalf("second create = %v", err)
	}
	if st := f.v.state(); !st.Exists || !st.Unlocked || st.LockAt == 0 {
		t.Fatalf("state = %+v", st)
	}
	f.v.lock()
	if st := f.v.state(); st.Unlocked || st.Entries != 0 {
		t.Fatalf("locked state = %+v", st)
	}
	if err := f.v.unlock("not the passphrase"); !isValidation(err, "Wrong passphrase") {
		t.Fatalf("wrong passphrase = %v", err)
	}
	if err := f.v.unlock(key); err != nil {
		t.Fatalf("recovery key: %v", err)
	}
	f.v.lock()
	other := newFixture(t)
	otherKey := other.createUnlocked()
	if err := f.v.unlock(otherKey); !isValidation(err, "Wrong recovery key") {
		t.Fatalf("foreign recovery key = %v", err)
	}
	if err := f.v.unlock(testPass); err != nil {
		t.Fatal(err)
	}
	if _, err := f.v.list("", ""); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	n := len(f.states)
	f.mu.Unlock()
	if n == 0 {
		t.Fatal("no vault:state events")
	}
}

func TestLockedOperationsFail(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	f.v.lock()
	if _, err := f.v.list("", ""); !isValidation(err, "The vault is locked") {
		t.Fatalf("list = %v", err)
	}
	p := f.write("a.txt", []byte("x"))
	if err, _ := f.job(context.Background(), []string{p}, Options{Action: ActionAdd}, nil); !isValidation(err, "The vault is locked") {
		t.Fatalf("add = %v", err)
	}
	if err := f.v.delete([]string{"x"}); !isValidation(err, "The vault is locked") {
		t.Fatalf("delete = %v", err)
	}
}

func TestAddListRenameMoveDelete(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	a := f.write("a.txt", []byte("alpha"))
	f.add("", a)
	f.add("", a) // clash -> "a (1).txt"
	es, err := f.v.list("", "")
	if err != nil || len(es) != 2 {
		t.Fatalf("list = %v %v", es, err)
	}
	if es[0].Name != "a (1).txt" || es[1].Name != "a.txt" {
		t.Fatalf("names = %q %q", es[0].Name, es[1].Name)
	}
	if es[1].Size != 5 {
		t.Fatalf("size = %d", es[1].Size)
	}
	if got, _ := os.ReadFile(a); string(got) != "alpha" {
		t.Fatal("original modified")
	}
	id := es[1].ID
	if err := f.v.rename(id, "b.txt"); err != nil {
		t.Fatal(err)
	}
	if err := f.v.rename(id, "a (1).txt"); !core.IsCode(err, core.CodeConflict) {
		t.Fatalf("clash rename = %v", err)
	}
	if err := f.v.rename(id, "bad/name"); err == nil {
		t.Fatal("bad name accepted")
	}
	if err := f.v.move([]string{id, es[0].ID}, "Docs"); err != nil {
		t.Fatal(err)
	}
	fs, _ := f.v.folders()
	if len(fs) != 1 || fs[0] != "Docs" {
		t.Fatalf("folders = %v", fs)
	}
	if in, _ := f.v.list("Docs", "B."); len(in) != 1 || in[0].Name != "b.txt" {
		t.Fatalf("search = %+v", in)
	}
	if st := f.v.state(); st.Entries != 2 {
		t.Fatalf("entries = %d", st.Entries)
	}
	if err := f.v.delete([]string{id}); err != nil {
		t.Fatal(err)
	}
	if left, _ := f.v.list("", ""); len(left) != 1 {
		t.Fatalf("after delete = %d", len(left))
	}
	if n := countBlobs(t, filepath.Join(f.lib, "Vault")); n != 1 {
		t.Fatalf("blobs = %d", n)
	}
	// survives lock/unlock
	f.v.lock()
	if err := f.v.unlock(testPass); err != nil {
		t.Fatal(err)
	}
	if left, _ := f.v.list("", ""); len(left) != 1 {
		t.Fatalf("after relock = %d", len(left))
	}
}

func countBlobs(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	_ = filepath.WalkDir(filepath.Join(dir, dirBlobs), func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}

func TestAddCancelMidFileLeavesNoPartialBlob(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	big := f.write("big.bin", bytes.Repeat([]byte("z"), 6<<20))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err, _ := f.job(ctx, []string{big}, Options{Action: ActionAdd}, func(pct float64, _ string) {
		if pct > 0.2 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if n := countBlobs(t, filepath.Join(f.lib, "Vault")); n != 0 {
		t.Fatalf("%d blob files left", n)
	}
	if es, _ := f.v.list("", ""); len(es) != 0 {
		t.Fatal("entry recorded for cancelled add")
	}
}

func TestAddKeepsFilesAddedBeforeCancel(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	a := f.write("a.txt", []byte("one"))
	big := f.write("big.bin", bytes.Repeat([]byte("z"), 4<<20))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err, _ := f.job(ctx, []string{a, big}, Options{Action: ActionAdd}, func(pct float64, msg string) {
		if strings.HasPrefix(msg, "Encrypting 2") && pct > 0.5 {
			cancel()
		}
	})
	if err == nil {
		t.Fatal("expected cancel")
	}
	es, _ := f.v.list("", "")
	if len(es) != 1 || es[0].Name != "a.txt" {
		t.Fatalf("entries = %+v", es)
	}
}

func TestExportRoundTripAndTamper(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	data := bytes.Repeat([]byte("0123456789"), 20000)
	p := f.write("doc.bin", data)
	f.add("", p)
	es, _ := f.v.list("", "")
	err, outs := f.job(context.Background(), nil, Options{Action: ActionExport, IDs: []string{es[0].ID}}, nil)
	if err != nil || len(outs) != 1 {
		t.Fatalf("export: %v %v", err, outs)
	}
	got, _ := os.ReadFile(outs[0])
	if !bytes.Equal(got, data) {
		t.Fatal("exported bytes differ")
	}
	// A second export doesn't overwrite.
	_, outs2 := f.job(context.Background(), nil, Options{Action: ActionExport, IDs: []string{es[0].ID}}, nil)
	if len(outs2) != 1 || outs2[0] == outs[0] {
		t.Fatalf("second export path = %v", outs2)
	}

	// Flip a byte deep inside the blob.
	var blob string
	_ = filepath.WalkDir(filepath.Join(f.lib, "Vault", dirBlobs), func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			blob = p
		}
		return nil
	})
	b, _ := os.ReadFile(blob)
	b[len(b)-40] ^= 0xFF
	if err := os.WriteFile(blob, b, 0o600); err != nil {
		t.Fatal(err)
	}
	err, outs3 := f.job(context.Background(), nil, Options{Action: ActionExport, IDs: []string{es[0].ID}}, nil)
	ae := core.AsAppError(err)
	if ae == nil || ae.Message != "This file is damaged in the vault" {
		t.Fatalf("tamper err = %v", err)
	}
	if len(outs3) != 0 {
		t.Fatal("output registered for damaged file")
	}
	ents, _ := os.ReadDir(filepath.Join(f.lib, "Vault exports"))
	if len(ents) != 2 {
		t.Fatalf("partial export left behind: %d files", len(ents))
	}
}

func TestIndexBakFallback(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	f.add("", f.write("a.txt", []byte("a")))
	f.add("", f.write("b.txt", []byte("b")))
	f.v.lock()
	dir := filepath.Join(f.lib, "Vault")
	if err := os.WriteFile(filepath.Join(dir, fileIndex), []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.v.unlock(testPass); err != nil {
		t.Fatalf("unlock with bak: %v", err)
	}
	if es, _ := f.v.list("", ""); len(es) != 1 { // .bak is the version before the last add
		t.Fatalf("entries from bak = %d", len(es))
	}
	f.mu.Lock()
	var carried bool
	for _, st := range f.states {
		if st.Notice == "The vault index was restored from its backup copy" {
			carried = true
		}
	}
	f.mu.Unlock()
	if !carried {
		t.Fatal("no vault:state carried the bak notice")
	}
	if f.v.state().Notice != "" {
		t.Fatal("notice should be delivered once")
	}
	f.v.lock()
	_ = os.WriteFile(filepath.Join(dir, fileIndexBak), []byte("garbage"), 0o600)
	err := f.v.unlock(testPass)
	if ae := core.AsAppError(err); ae == nil || ae.Message != "The vault index is damaged" {
		t.Fatalf("both bad = %v", err)
	}
}

func TestAutoLockWipeAndJobCancel(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	f.add("", f.write("a.txt", []byte("hello")))
	es, _ := f.v.list("", "")
	if err := f.v.open(es[0].ID); err != nil || len(f.opened) != 1 {
		t.Fatalf("open: %v %v", err, f.opened)
	}
	if b, _ := os.ReadFile(f.opened[0]); string(b) != "hello" {
		t.Fatal("open copy differs")
	}
	if !strings.HasPrefix(f.opened[0], f.openDir) {
		t.Fatalf("open copy outside open dir: %s", f.opened[0])
	}

	f.clock = f.clock.Add(9 * time.Minute)
	f.v.checkAutoLock()
	if !f.v.state().Unlocked {
		t.Fatal("locked too early")
	}
	f.v.touch() // activity resets the countdown
	f.clock = f.clock.Add(9 * time.Minute)
	f.v.checkAutoLock()
	if !f.v.state().Unlocked {
		t.Fatal("touch didn't reset the timer")
	}
	f.clock = f.clock.Add(2 * time.Minute)
	f.v.checkAutoLock()
	if f.v.state().Unlocked {
		t.Fatal("did not auto-lock")
	}
	if ents, _ := os.ReadDir(f.openDir); len(ents) != 0 {
		t.Fatalf("open dir not wiped: %d", len(ents))
	}

	// Never lock on a timer (0), and not while a job runs.
	if err := f.v.unlock(testPass); err != nil {
		t.Fatal(err)
	}
	f.minutes = 0
	f.clock = f.clock.Add(100 * time.Hour)
	f.v.checkAutoLock()
	if !f.v.state().Unlocked || f.v.state().LockAt != 0 {
		t.Fatal("locked with auto-lock off")
	}
	f.minutes = 1
	_, done, err := f.v.registerJob(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	f.clock = f.clock.Add(time.Hour)
	f.v.checkAutoLock()
	if !f.v.state().Unlocked {
		t.Fatal("locked during a job")
	}
	done()
}

func TestLockCancelsRunningJob(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	big := f.write("big.bin", bytes.Repeat([]byte("q"), 6<<20))
	err, _ := f.job(context.Background(), []string{big}, Options{Action: ActionAdd}, func(pct float64, _ string) {
		if pct > 0.2 {
			f.v.lock()
		}
	})
	if !isValidation(err, "The vault is locked") {
		t.Fatalf("err = %v", err)
	}
	if n := countBlobs(t, filepath.Join(f.lib, "Vault")); n != 0 {
		t.Fatalf("%d blobs left", n)
	}
}

func TestStartupWipe(t *testing.T) {
	f := newFixture(t)
	stale := filepath.Join(f.openDir, "old-session")
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(stale, "secret.txt"), []byte("s"), 0o600)
	_ = os.WriteFile(filepath.Join(f.openDir, "loose.txt"), []byte("s"), 0o600)
	ctx, cancel := context.WithCancel(context.Background())
	f.v.Start(ctx)
	cancel()
	if ents, _ := os.ReadDir(f.openDir); len(ents) != 0 {
		t.Fatalf("not wiped: %d", len(ents))
	}
}

func TestChangePassphraseKeepsFilesReadable(t *testing.T) {
	f := newFixture(t)
	key := f.createUnlocked()
	p := f.write("a.txt", []byte("keep me"))
	f.add("", p)
	if err := f.v.changePassphrase("wrong wrong", "another passphrase"); !isValidation(err, "Wrong passphrase") {
		t.Fatalf("wrong old = %v", err)
	}
	if err := f.v.changePassphrase(testPass, "short"); err == nil {
		t.Fatal("short new passphrase accepted")
	}
	if err := f.v.changePassphrase(testPass, "another passphrase"); err != nil {
		t.Fatal(err)
	}
	f.v.lock()
	if err := f.v.unlock(testPass); !isValidation(err, "Wrong passphrase") {
		t.Fatalf("old passphrase = %v", err)
	}
	if err := f.v.unlock("another passphrase"); err != nil {
		t.Fatal(err)
	}
	es, _ := f.v.list("", "")
	err, outs := f.job(context.Background(), nil, Options{Action: ActionExport, IDs: []string{es[0].ID}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(outs[0]); string(b) != "keep me" {
		t.Fatal("content differs after passphrase change")
	}
	got, err := f.v.recoveryKey("another passphrase")
	if err != nil || got != key {
		t.Fatalf("recovery key = %q, %v", got, err)
	}
	if _, err := f.v.recoveryKey(testPass); err == nil {
		t.Fatal("recovery key shown for the wrong passphrase")
	}
}

func TestNoPlaintextInVaultFolder(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	name := "tax-return-SECRETNAME.txt"
	content := "SECRETCONTENT-0123456789"
	f.add("Private", f.write(name, []byte(content)))
	f.v.lock()
	root := filepath.Join(f.lib, "Vault")
	files := 0
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		for _, bad := range []string{"SECRETNAME", "tax-return", "Private"} {
			if strings.Contains(rel, bad) {
				t.Errorf("plaintext in path %q", rel)
			}
		}
		if d.IsDir() {
			return nil
		}
		files++
		b, _ := os.ReadFile(p)
		for _, bad := range []string{"SECRETNAME", "SECRETCONTENT", "tax-return", "Private"} {
			if bytes.Contains(b, []byte(bad)) {
				t.Errorf("plaintext %q in %s", bad, rel)
			}
		}
		return nil
	})
	if files < 4 {
		t.Fatalf("only %d files scanned", files)
	}
}

func TestPreviewLimit(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	png := []byte("\x89PNG\r\n\x1a\nfake")
	f.add("", f.write("p.png", png))
	f.add("", f.write("t.txt", []byte("text")))
	es, _ := f.v.list("", "")
	var pngID, txtID string
	for _, e := range es {
		if e.Name == "p.png" {
			pngID = e.ID
		} else {
			txtID = e.ID
		}
	}
	url, err := f.v.preview(pngID)
	if err != nil || !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("preview = %q, %v", url, err)
	}
	if _, err := f.v.preview(txtID); err == nil {
		t.Fatal("text previewed")
	}
	// Pretend the image is over the limit.
	f.v.mu.Lock()
	i := f.v.idx.find(pngID)
	f.v.idx.Entries[i].Size = maxPreviewBytes + 1
	f.v.mu.Unlock()
	if _, err := f.v.preview(pngID); !isValidation(err, "This image is too large to preview") {
		t.Fatalf("big preview = %v", err)
	}
}

func TestServiceEnqueueSubmitsJobs(t *testing.T) {
	f := newFixture(t)
	var gotInputs []string
	var gotOpts string
	f.v.submit = func(_ context.Context, inputs []string, opts string) ([]core.Job, error) {
		gotInputs, gotOpts = inputs, opts
		return []core.Job{{ID: "j1"}}, nil
	}
	svc := NewService(f.v)
	if _, err := svc.Enqueue([]string{"x"}, ""); !isValidation(err, "The vault is locked") {
		t.Fatalf("locked enqueue = %v", err)
	}
	f.createUnlocked()
	if jobs, err := svc.Enqueue([]string{"x"}, "Docs"); err != nil || len(jobs) != 1 {
		t.Fatalf("enqueue: %v", err)
	}
	if len(gotInputs) != 1 || !strings.Contains(gotOpts, `"action":"add"`) || !strings.Contains(gotOpts, `"Docs"`) {
		t.Fatalf("submit got %v %s", gotInputs, gotOpts)
	}
	if _, err := svc.Export([]string{"id1"}); err != nil || !strings.Contains(gotOpts, `"action":"export"`) {
		t.Fatalf("export: %v %s", err, gotOpts)
	}
}

func TestValidate(t *testing.T) {
	f := newFixture(t)
	f.createUnlocked()
	p := f.write("a.txt", []byte("a"))
	cases := []struct {
		name   string
		inputs []string
		opts   string
		ok     bool
	}{
		{"add ok", []string{p}, `{"action":"add"}`, true},
		{"add none", nil, `{"action":"add"}`, false},
		{"add dir", []string{f.src}, `{"action":"add"}`, false},
		{"add missing", []string{filepath.Join(f.src, "nope")}, `{"action":"add"}`, false},
		{"bad folder", []string{p}, `{"action":"add","folder":"a/b"}`, false},
		{"export none", nil, `{"action":"export"}`, false},
		{"export unknown id", nil, `{"action":"export","ids":["zzz"]}`, false},
		{"unknown action", nil, `{"action":"nuke"}`, false},
		{"unknown field", nil, `{"action":"add","x":1}`, false},
	}
	for _, c := range cases {
		err := f.v.validate(c.inputs, json.RawMessage(c.opts))
		if (err == nil) != c.ok {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
}

func TestWipeRetriesLeftovers(t *testing.T) {
	// wipeDir reports leftovers it can't remove; simulate with a read-only
	// guard by checking the happy path and the missing-dir path.
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "a"), 0o755)
	_ = os.MkdirAll(filepath.Join(dir, "keep"), 0o755)
	if wipeDir(dir, "keep") {
		t.Fatal("unexpected leftovers")
	}
	if _, err := os.Stat(filepath.Join(dir, "keep")); err != nil {
		t.Fatal("kept session removed")
	}
	if _, err := os.Stat(filepath.Join(dir, "a")); err == nil {
		t.Fatal("stale dir kept")
	}
	if wipeDir(filepath.Join(dir, "missing"), "") {
		t.Fatal("missing dir reported leftovers")
	}
}
