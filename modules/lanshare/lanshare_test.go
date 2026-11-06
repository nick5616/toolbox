package lanshare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/lan"
)

// fakeNet is a runtime double.
type fakeNet struct {
	mu        sync.Mutex
	devices   map[string]lan.Device
	probeErrs []error // consumed one per Probe; empty = success
	probes    int
	scans     int
	sendErr   error
	sendReq   lan.SendRequest
	sendRes   lan.SendResult
	stages    []lan.SendProgress
	activity  []string
	settings  lan.Settings
	messages  []lan.Message
	sendWait  chan struct{} // when set, Send blocks until ctx done or closed
}

func newFakeNet(devs ...lan.Device) *fakeNet {
	f := &fakeNet{devices: map[string]lan.Device{}, settings: lan.Settings{Receive: lan.ReceiveOff, From: lan.FromAnyone}}
	for _, d := range devs {
		f.devices[d.Fingerprint] = d
	}
	return f
}

func (f *fakeNet) State() lan.State                   { return lan.State{Mode: lan.ReceiveOff} }
func (f *fakeNet) Settings() lan.Settings             { return f.settings }
func (f *fakeNet) SetSettings(s lan.Settings) error   { f.settings = s; return nil }
func (f *fakeNet) SetReceive(m lan.ReceiveMode) error { f.settings.Receive = m; return nil }
func (f *fakeNet) Hold(string)                        {}
func (f *fakeNet) Release(string)                     {}
func (f *fakeNet) Devices() []lan.Device              { return nil }
func (f *fakeNet) Device(fp string) (lan.Device, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.devices[fp]
	return d, ok
}
func (f *fakeNet) Scan(context.Context) { f.mu.Lock(); f.scans++; f.mu.Unlock() }
func (f *fakeNet) Probe(_ context.Context, fp string) (lan.Device, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.probes++
	if len(f.probeErrs) > 0 {
		err := f.probeErrs[0]
		f.probeErrs = f.probeErrs[1:]
		if err != nil {
			return lan.Device{}, err
		}
	}
	return f.devices[fp], nil
}
func (f *fakeNet) AddByAddress(context.Context, string, int) (lan.Device, error) {
	return lan.Device{}, nil
}
func (f *fakeNet) Pair(context.Context, string) (string, error) { return "123456", nil }
func (f *fakeNet) Respond(string, bool, bool) error             { return nil }
func (f *fakeNet) Forget(string) error                          { return nil }
func (f *fakeNet) SetAutoAccept(string, bool) error             { return nil }
func (f *fakeNet) Send(ctx context.Context, req lan.SendRequest, progress func(lan.SendProgress)) (lan.SendResult, error) {
	f.mu.Lock()
	f.sendReq = req
	f.mu.Unlock()
	for _, p := range f.stages {
		progress(p)
	}
	if f.sendWait != nil {
		select {
		case <-ctx.Done():
			return lan.SendResult{}, ctx.Err()
		case <-f.sendWait:
		}
	}
	return f.sendRes, f.sendErr
}
func (f *fakeNet) Messages() []lan.Message  { return f.messages }
func (f *fakeNet) ClearMessages()           {}
func (f *fakeNet) Activity() []lan.Activity { return nil }
func (f *fakeNet) AddActivity(text string) {
	f.mu.Lock()
	f.activity = append(f.activity, text)
	f.mu.Unlock()
}

// recorder collects what a job reports.
type recorder struct {
	mu       sync.Mutex
	title    string
	progress []string
	pcts     []float64
	outputs  []string
	result   json.RawMessage
}

func (r *recorder) ctx(inputs []string, options any, outDir, tmp string) *core.JobContext {
	raw, _ := json.Marshal(options)
	return core.NewJobContext(core.JobContext{ID: "job1", ModuleID: ModuleID, Inputs: inputs, Options: raw, Attempt: 1, OutputDir: outDir, TempDir: tmp}, core.JobHooks{
		Progress: func(p float64, msg string) {
			r.mu.Lock()
			r.pcts = append(r.pcts, p)
			r.progress = append(r.progress, msg)
			r.mu.Unlock()
		},
		Title: func(t string) { r.mu.Lock(); r.title = t; r.mu.Unlock() },
		Output: func(p string) (core.Output, error) {
			r.mu.Lock()
			r.outputs = append(r.outputs, p)
			r.mu.Unlock()
			return core.Output{Path: p, Name: filepath.Base(p)}, nil
		},
		Result: func(b json.RawMessage) { r.mu.Lock(); r.result = b; r.mu.Unlock() },
	})
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

var laptop = lan.Device{Fingerprint: "aa11", Alias: "Nicole's MacBook", Toolbox: true, Paired: true, Address: "192.168.1.5", Port: 53317, Protocol: "https", Online: true}

// ---- send ----

func TestExpandInputs(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "Trip", "a.jpg"), "a")
	writeFile(t, filepath.Join(dir, "Trip", "sub", "b.txt"), "bb")
	writeFile(t, filepath.Join(dir, "Trip", ".hidden"), "x")
	writeFile(t, filepath.Join(dir, "Trip", ".git", "config"), "x")
	writeFile(t, filepath.Join(dir, "Trip", "Thumbs.db"), "x")
	writeFile(t, filepath.Join(dir, "solo.png"), "ppp")
	writeFile(t, filepath.Join(dir, ".direct"), "d")
	// A symlink is skipped (not all platforms allow creating one).
	if err := os.Symlink(filepath.Join(dir, "solo.png"), filepath.Join(dir, "Trip", "link.png")); err != nil {
		t.Logf("no symlinks here: %v", err)
	}

	files, err := expandInputs(context.Background(), []string{filepath.Join(dir, "Trip"), filepath.Join(dir, "solo.png"), filepath.Join(dir, ".direct")})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range files {
		got = append(got, f.RelPath)
	}
	want := []string{"Trip/a.jpg", "Trip/sub/b.txt", "solo.png", ".direct"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("rel paths = %v, want %v", got, want)
	}
	if files[0].Type != "image/jpeg" || files[0].Size != 1 || files[1].Size != 2 {
		t.Errorf("meta = %+v %+v", files[0], files[1])
	}
	if _, err := expandInputs(context.Background(), []string{filepath.Join(dir, "missing")}); err == nil {
		t.Error("a missing input should fail")
	}
}

func TestMimeType(t *testing.T) {
	for in, want := range map[string]string{"x.JPG": "image/jpeg", "x.png": "image/png", "noext": "application/octet-stream", "x.zzzunknown": "application/octet-stream"} {
		if got := mimeType(in); got != want {
			t.Errorf("mimeType(%q) = %q, want %q", in, got, want)
		}
	}
}

func sendOpts(pinRef string) Options { return Options{Device: laptop.Fingerprint, PinRef: pinRef} }

func TestSendRunSuccess(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "f.txt"), "hello")
	fn := newFakeNet(laptop)
	fn.sendRes = lan.SendResult{Files: 1, Bytes: 5}
	fn.stages = []lan.SendProgress{{Stage: "waiting"}, {Stage: "uploading", Done: 2, Total: 5, FileCount: 1}}
	id := shared.putPIN("4321")
	rec := &recorder{}
	m, _ := New(fn)
	if err := m.Run(context.Background(), rec.ctx([]string{filepath.Join(dir, "f.txt")}, sendOpts(id), "", t.TempDir())); err != nil {
		t.Fatal(err)
	}
	if fn.sendReq.PIN != "4321" || len(fn.sendReq.Files) != 1 || fn.sendReq.Files[0].RelPath != "f.txt" {
		t.Errorf("request = %+v", fn.sendReq)
	}
	if rec.title != "To Nicole's MacBook · 1 file" {
		t.Errorf("title = %q", rec.title)
	}
	if !containsMsg(rec.progress, "Waiting for Nicole's MacBook to accept…") {
		t.Errorf("progress = %v", rec.progress)
	}
	var res SendJobResult
	if err := json.Unmarshal(rec.result, &res); err != nil || res.Device != "Nicole's MacBook" || res.Files != 1 || res.Bytes != 5 {
		t.Errorf("result = %s (%v)", rec.result, err)
	}
	if shared.pin(id) != "" {
		t.Error("the PIN should be dropped after a successful send")
	}
	if len(fn.activity) != 1 {
		t.Errorf("activity = %v", fn.activity)
	}
	// Inputs are untouched.
	if b, _ := os.ReadFile(filepath.Join(dir, "f.txt")); string(b) != "hello" {
		t.Error("input changed")
	}
}

func containsMsg(msgs []string, want string) bool {
	for _, m := range msgs {
		if m == want {
			return true
		}
	}
	return false
}

func TestSendRunMessageOnly(t *testing.T) {
	fn := newFakeNet(laptop)
	fn.sendRes = lan.SendResult{AsMessage: true}
	rec := &recorder{}
	m, _ := New(fn)
	o := Options{Device: laptop.Fingerprint, Text: "https://example.com"}
	if err := m.Run(context.Background(), rec.ctx(nil, o, "", t.TempDir())); err != nil {
		t.Fatal(err)
	}
	if fn.sendReq.Text != "https://example.com" || len(fn.sendReq.Files) != 0 {
		t.Errorf("request = %+v", fn.sendReq)
	}
	var res SendJobResult
	_ = json.Unmarshal(rec.result, &res)
	if !res.AsMessage {
		t.Errorf("result = %+v", res)
	}
}

func TestSendRunErrors(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "f.txt"), "x")
	in := []string{filepath.Join(dir, "f.txt")}
	cases := []struct {
		name string
		err  error
		code core.ErrorCode
		msg  string
	}{
		{"declined", core.Errorf(lan.CodeDeclined, "no"), lan.CodeDeclined, "Nicole's MacBook declined"},
		{"busy", core.Errorf(lan.CodeBusy, "busy"), lan.CodeBusy, "Nicole's MacBook is busy with another transfer"},
		{"pin", core.Errorf(lan.CodePinRequired, "pin"), lan.CodePinRequired, "Nicole's MacBook needs a PIN"},
		{"offline", core.Errorf(lan.CodeOffline, "x"), lan.CodeOffline, "Nicole's MacBook isn't on this network right now"},
		{"too large", core.Errorf(lan.CodeTooLarge, "x"), lan.CodeTooLarge, "Nicole's MacBook doesn't have room for these files"},
		{"wrong device", core.Errorf(lan.CodeWrongDevice, "This isn't the device you paired with"), lan.CodeWrongDevice, "This isn't the device you paired with"},
		{"other", errors.New("boom"), core.CodeToolFailed, "Couldn't send to Nicole's MacBook"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fn := newFakeNet(laptop)
			fn.sendErr = c.err
			m, _ := New(fn)
			err := m.Run(context.Background(), (&recorder{}).ctx(in, sendOpts(""), "", t.TempDir()))
			ae := core.AsAppError(err)
			if ae == nil || ae.Code != c.code || ae.Message != c.msg {
				t.Fatalf("err = %v, want %s %q", err, c.code, c.msg)
			}
			if c.code == lan.CodePinRequired && ae.Fields["pin"] == "" {
				t.Error("pin error should name the pin field")
			}
		})
	}
}

func TestSendRunOfflineRescansOnce(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "f.txt"), "x")
	in := []string{filepath.Join(dir, "f.txt")}

	t.Run("found by the rescan", func(t *testing.T) {
		fn := newFakeNet(laptop)
		fn.probeErrs = []error{errors.New("no route"), nil}
		fn.sendRes = lan.SendResult{Files: 1, Bytes: 1}
		m, _ := New(fn)
		if err := m.Run(context.Background(), (&recorder{}).ctx(in, sendOpts(""), "", t.TempDir())); err != nil {
			t.Fatal(err)
		}
		if fn.scans != 1 || fn.probes != 2 {
			t.Errorf("scans=%d probes=%d", fn.scans, fn.probes)
		}
	})
	t.Run("still unreachable", func(t *testing.T) {
		fn := newFakeNet(laptop)
		fn.probeErrs = []error{errors.New("no route"), errors.New("no route")}
		m, _ := New(fn)
		err := m.Run(context.Background(), (&recorder{}).ctx(in, sendOpts(""), "", t.TempDir()))
		ae := core.AsAppError(err)
		if ae.Code != lan.CodeOffline || ae.Hint == "" {
			t.Fatalf("err = %v", err)
		}
		if fn.scans != 1 {
			t.Errorf("scans = %d, want exactly one rescan", fn.scans)
		}
		if fn.sendReq.Device.Fingerprint != "" {
			t.Error("Send must not be called for an unreachable device")
		}
	})
	t.Run("encryption off", func(t *testing.T) {
		d := laptop
		d.Protocol = "http"
		fn := newFakeNet(d)
		m, _ := New(fn)
		err := m.Run(context.Background(), (&recorder{}).ctx(in, sendOpts(""), "", t.TempDir()))
		if !core.IsCode(err, lan.CodeEncryptionOff) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("unknown device", func(t *testing.T) {
		m, _ := New(newFakeNet())
		err := m.Run(context.Background(), (&recorder{}).ctx(in, sendOpts(""), "", t.TempDir()))
		if !core.IsCode(err, core.CodeValidation) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestSendRunCancelReturnsContextError(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "f.txt"), "x")
	fn := newFakeNet(laptop)
	fn.sendWait = make(chan struct{})
	m, _ := New(fn)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- m.Run(ctx, (&recorder{}).ctx([]string{filepath.Join(dir, "f.txt")}, sendOpts(""), "", t.TempDir()))
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run didn't stop on cancel")
	}
}

func TestSendValidate(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "f.txt"), "x")
	m, _ := New(nil)
	opts := func(o Options) json.RawMessage { b, _ := json.Marshal(o); return b }
	cases := []struct {
		name   string
		inputs []string
		o      Options
		ok     bool
	}{
		{"file and device", []string{filepath.Join(dir, "f.txt")}, Options{Device: "aa"}, true},
		{"text only", nil, Options{Device: "aa", Text: "hi"}, true},
		{"nothing", nil, Options{Device: "aa"}, false},
		{"no device", []string{filepath.Join(dir, "f.txt")}, Options{}, false},
		{"missing file", []string{filepath.Join(dir, "gone")}, Options{Device: "aa"}, false},
		{"huge text", nil, Options{Device: "aa", Text: strings.Repeat("x", lan.MaxTextBytes+1)}, false},
	}
	for _, c := range cases {
		err := m.Validate(c.inputs, opts(c.o))
		if (err == nil) != c.ok {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
	if err := m.Validate(nil, json.RawMessage(`{"device":"aa","pin":"1234"}`)); err == nil {
		t.Error("a raw pin field must be rejected: PINs never travel in options")
	}
}

// ---- receive ----

type fakeSession struct {
	id       string
	from     lan.Device
	files    []lan.FileMeta
	bodies   [][]byte
	next     int
	mu       sync.Mutex
	canceled bool
	finished bool
	finErr   error
	doneErrs []error
	nextErr  error
}

func (s *fakeSession) ID() string            { return s.id }
func (s *fakeSession) From() lan.Device      { return s.from }
func (s *fakeSession) Verified() bool        { return true }
func (s *fakeSession) Files() []lan.FileMeta { return s.files }
func (s *fakeSession) TotalBytes() int64 {
	var n int64
	for _, f := range s.files {
		n += f.Size
	}
	return n
}
func (s *fakeSession) Next(ctx context.Context) (lan.FileStream, error) {
	if s.nextErr != nil {
		return lan.FileStream{}, s.nextErr
	}
	if s.next >= len(s.files) {
		return lan.FileStream{}, io.EOF
	}
	i := s.next
	s.next++
	return lan.FileStream{File: s.files[i], Body: bytes.NewReader(s.bodies[i]), Done: func(err error) {
		s.mu.Lock()
		s.doneErrs = append(s.doneErrs, err)
		s.mu.Unlock()
	}}, nil
}
func (s *fakeSession) Cancel() { s.mu.Lock(); s.canceled = true; s.mu.Unlock() }
func (s *fakeSession) Finished(err error) {
	s.mu.Lock()
	s.finished, s.finErr = true, err
	s.mu.Unlock()
}

func newSession(id string, files map[string]string, order ...string) *fakeSession {
	s := &fakeSession{id: id, from: lan.Device{Alias: "Nicole's MacBook"}}
	for _, name := range order {
		s.files = append(s.files, lan.FileMeta{ID: name, RelPath: name, Size: int64(len(files[name])), Modified: time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC).UnixMilli()})
		s.bodies = append(s.bodies, []byte(files[name]))
	}
	return s
}

func runReceive(t *testing.T, fn *fakeNet, sess *fakeSession, outDir string, ctx context.Context) (*recorder, error) {
	t.Helper()
	shared.putSession(sess)
	_, r := New(fn)
	rec := &recorder{}
	err := r.Run(ctx, rec.ctx(nil, ReceiveOptions{Session: sess.id}, outDir, t.TempDir()))
	return rec, err
}

func TestReceiveWritesFiles(t *testing.T) {
	out := t.TempDir()
	contents := map[string]string{"Trip/IMG_1.jpg": "image-bytes", "Trip/sub/note ü.txt": "unicode", "plain.bin": string([]byte{0, 1, 2, 255})}
	sess := newSession("s-ok", contents, "Trip/IMG_1.jpg", "Trip/sub/note ü.txt", "plain.bin")
	fn := newFakeNet()
	rec, err := runReceive(t, fn, sess, out, context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range contents {
		p := filepath.Join(out, "Nicole's MacBook", filepath.FromSlash(name))
		got, err := os.ReadFile(p)
		if err != nil || string(got) != want {
			t.Errorf("%s: %q, %v", name, got, err)
		}
		st, _ := os.Stat(p)
		if st.ModTime().UTC().Year() != 2020 || st.ModTime().UTC().Month() != 1 {
			t.Errorf("%s: mtime = %v", name, st.ModTime())
		}
	}
	if len(rec.outputs) != 3 {
		t.Errorf("outputs = %v", rec.outputs)
	}
	if rec.title != "From Nicole's MacBook · 3 files" {
		t.Errorf("title = %q", rec.title)
	}
	if !sess.finished || sess.finErr != nil || sess.canceled {
		t.Errorf("session finished=%v err=%v canceled=%v", sess.finished, sess.finErr, sess.canceled)
	}
	for i, e := range sess.doneErrs {
		if e != nil {
			t.Errorf("Done[%d] = %v", i, e)
		}
	}
	if len(sess.doneErrs) != 3 {
		t.Errorf("Done called %d times", len(sess.doneErrs))
	}
	if len(fn.activity) != 1 || !strings.Contains(fn.activity[0], "Received 3 files") {
		t.Errorf("activity = %v", fn.activity)
	}
	if rec.pcts[len(rec.pcts)-1] != 1 {
		t.Errorf("final progress = %v", rec.pcts[len(rec.pcts)-1])
	}
	var res ReceiveJobResult
	_ = json.Unmarshal(rec.result, &res)
	if res.Files != 3 || res.From != "Nicole's MacBook" {
		t.Errorf("result = %+v", res)
	}
}

func TestReceiveUniqueNamesAndSafePaths(t *testing.T) {
	out := t.TempDir()
	root := filepath.Join(out, "Nicole's MacBook")
	writeFile(t, filepath.Join(root, "a.txt"), "existing")
	contents := map[string]string{"a.txt": "new1", "../escape.txt": "x", "CON.txt": "reserved"}
	sess := newSession("s-names", contents, "a.txt", "../escape.txt", "CON.txt")
	if _, err := runReceive(t, newFakeNet(), sess, out, context.Background()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(b) != "existing" {
		t.Errorf("an existing file was overwritten: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "a (2).txt")); string(b) != "new1" {
		t.Errorf("a (2).txt = %q", b)
	}
	if _, err := os.Stat(filepath.Join(out, "escape.txt")); err == nil {
		t.Error("a file escaped the received folder")
	}
	if b, _ := os.ReadFile(filepath.Join(root, "escape.txt")); string(b) != "x" {
		t.Errorf("escape.txt = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "CON_.txt")); string(b) != "reserved" {
		t.Errorf("CON_.txt = %q", b)
	}
}

func TestReceiveSizeMismatchFailsWithDone(t *testing.T) {
	out := t.TempDir()
	sess := newSession("s-bad", map[string]string{"a.txt": "abc"}, "a.txt")
	sess.files[0].Size = 3
	// The stream errors on a short body the way the runtime's Body would.
	shared.putSession(sess)
	sess.bodies[0] = []byte("abc")
	sess2 := &errBodySession{fakeSession: sess}
	shared.putSession(sess2)
	_, r := New(newFakeNet())
	rec := &recorder{}
	err := r.Run(context.Background(), rec.ctx(nil, ReceiveOptions{Session: sess2.id}, out, t.TempDir()))
	if err == nil || !strings.Contains(err.Error(), "short upload") {
		t.Fatalf("err = %v", err)
	}
	if !sess.finished || sess.finErr == nil {
		t.Errorf("Finished should carry the error: %v", sess.finErr)
	}
	if len(sess.doneErrs) != 1 || sess.doneErrs[0] == nil {
		t.Errorf("Done errs = %v", sess.doneErrs)
	}
	if _, serr := os.Stat(filepath.Join(out, "Nicole's MacBook", "a.txt")); serr == nil {
		t.Error("a failed file must not be stored")
	}
	if len(rec.outputs) != 0 {
		t.Errorf("outputs = %v", rec.outputs)
	}
}

type errBodySession struct{ *fakeSession }

func (s *errBodySession) Next(ctx context.Context) (lan.FileStream, error) {
	fs, err := s.fakeSession.Next(ctx)
	if err == nil {
		fs.Body = io.MultiReader(strings.NewReader("ab"), errReader{errors.New("short upload")})
	}
	return fs, err
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }

type blockingSession struct{ *fakeSession }

func (s *blockingSession) Next(ctx context.Context) (lan.FileStream, error) {
	<-ctx.Done()
	return lan.FileStream{}, ctx.Err()
}

func TestReceiveCancelCancelsSession(t *testing.T) {
	sess := &blockingSession{newSession("s-cancel", map[string]string{"a": "x"}, "a")}
	shared.putSession(sess)
	_, r := New(newFakeNet())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- r.Run(ctx, (&recorder{}).ctx(nil, ReceiveOptions{Session: sess.id}, t.TempDir(), t.TempDir()))
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run didn't stop")
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if !sess.canceled || !sess.finished {
		t.Errorf("canceled=%v finished=%v", sess.canceled, sess.finished)
	}
}

func TestReceiveUnknownSession(t *testing.T) {
	_, r := New(newFakeNet())
	err := r.Run(context.Background(), (&recorder{}).ctx(nil, ReceiveOptions{Session: "nope"}, t.TempDir(), t.TempDir()))
	if !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("err = %v", err)
	}
	if err := r.Validate(nil, json.RawMessage(`{"session":"nope"}`)); err == nil {
		t.Error("Validate should reject an unknown session")
	}
	if err := r.Validate(nil, json.RawMessage(`{}`)); err == nil {
		t.Error("Validate should reject empty options")
	}
}

// ---- sink ----

type fakeJobs struct {
	mu   sync.Mutex
	subs []submission
	err  error
	jobs map[string]core.Job
}

type submission struct {
	module string
	inputs []string
	opts   string
}

func (f *fakeJobs) Submit(_ context.Context, module string, inputs []string, opts string) ([]core.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	f.subs = append(f.subs, submission{module, inputs, opts})
	j := core.Job{ID: core.NewID(), ModuleID: module, Status: core.JobDone, OptionsJSON: opts, Outputs: []core.Output{{Path: "/lib/Received/x/Message.txt", Name: "Message.txt"}}}
	if f.jobs == nil {
		f.jobs = map[string]core.Job{}
	}
	f.jobs[j.ID] = j
	return []core.Job{j}, nil
}

func (f *fakeJobs) Get(_ context.Context, id string) (core.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.jobs[id], nil
}

func TestSinkSubmitsAReceiveJob(t *testing.T) {
	fj := &fakeJobs{}
	sink := NewSink(fj, newFakeNet())
	sess := newSession("s-sink", map[string]string{"a": "x"}, "a")
	if err := sink.Accepted(sess); err != nil {
		t.Fatal(err)
	}
	if len(fj.subs) != 1 || fj.subs[0].module != ReceiveID || len(fj.subs[0].inputs) != 0 {
		t.Fatalf("subs = %+v", fj.subs)
	}
	var o ReceiveOptions
	if err := json.Unmarshal([]byte(fj.subs[0].opts), &o); err != nil || o.Session != "s-sink" {
		t.Errorf("opts = %s", fj.subs[0].opts)
	}
	if !shared.hasSession("s-sink") {
		t.Error("the session should wait in memory for the job")
	}
	shared.takeSession("s-sink")

	fj2 := &fakeJobs{err: errors.New("db down")}
	if err := NewSink(fj2, newFakeNet()).Accepted(newSession("s-sink2", nil)); err == nil {
		t.Error("a failed submit should be returned")
	}
	if shared.hasSession("s-sink2") {
		t.Error("a failed submit should not leave the session behind")
	}
}

// ---- service ----

func TestServiceSendKeepsPINOutOfOptions(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "f.txt"), "x")
	fj := &fakeJobs{}
	svc := NewService(fj, newFakeNet(laptop))
	if _, err := svc.Send(SendInput{Fingerprint: laptop.Fingerprint, Paths: []string{filepath.Join(dir, "f.txt")}, Text: "hi", PIN: "987654"}); err != nil {
		t.Fatal(err)
	}
	if len(fj.subs) != 1 || fj.subs[0].module != ModuleID {
		t.Fatalf("subs = %+v", fj.subs)
	}
	if strings.Contains(fj.subs[0].opts, "987654") {
		t.Fatalf("the PIN is in the job options: %s", fj.subs[0].opts)
	}
	var o Options
	if err := json.Unmarshal([]byte(fj.subs[0].opts), &o); err != nil || o.PinRef == "" || shared.pin(o.PinRef) != "987654" {
		t.Errorf("options = %s", fj.subs[0].opts)
	}
	// No PIN, no ref.
	if _, err := svc.Send(SendInput{Fingerprint: laptop.Fingerprint, Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fj.subs[1].opts, `"pinRef":"`) && !strings.Contains(fj.subs[1].opts, `"pinRef":""`) {
		t.Errorf("unexpected ref: %s", fj.subs[1].opts)
	}
	// A failed submit drops the stored PIN.
	fj.err = errors.New("x")
	before := len(shared.pins)
	if _, err := svc.Send(SendInput{Fingerprint: laptop.Fingerprint, Text: "hi", PIN: "1111"}); err == nil {
		t.Fatal("want error")
	}
	if len(shared.pins) != before {
		t.Error("a failed send leaked its PIN")
	}
}

func TestServiceSettings(t *testing.T) {
	fn := newFakeNet()
	svc := NewService(&fakeJobs{}, fn)
	SetReceiveDir(svc, func() string { return "/lib/Received" })
	s := svc.Settings()
	if s.AliasAuto == "" || strings.Contains(s.AliasAuto, ".") || s.ReceiveDir != "/lib/Received" || s.FirewallTip == "" || s.PINSet || s.From != lan.FromAnyone {
		t.Errorf("settings = %+v", s)
	}
	pin := "2468"
	got, err := svc.SetSettings(LanSettingsInput{Alias: "  Desk  ", From: lan.FromMine, PIN: &pin})
	if err != nil {
		t.Fatal(err)
	}
	if got.Alias != "Desk" || got.From != lan.FromMine || !got.PINSet || fn.settings.PIN != "2468" {
		t.Errorf("after set = %+v / %+v", got, fn.settings)
	}
	// nil PIN keeps it, "" clears it.
	if _, err := svc.SetSettings(LanSettingsInput{Alias: "Desk", From: lan.FromMine}); err != nil || fn.settings.PIN != "2468" {
		t.Errorf("nil pin changed it: %v %q", err, fn.settings.PIN)
	}
	empty := ""
	if got, _ := svc.SetSettings(LanSettingsInput{Alias: "Desk", From: lan.FromMine, PIN: &empty}); got.PINSet {
		t.Error("empty PIN should clear")
	}
	for name, in := range map[string]LanSettingsInput{
		"long alias": {Alias: strings.Repeat("x", 65), From: lan.FromMine},
		"bad from":   {Alias: "x", From: "everyone"},
	} {
		if _, err := svc.SetSettings(in); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if firewallTip("windows") == firewallTip("darwin") {
		t.Error("tips should differ by OS")
	}
}

func TestServiceSaveMessage(t *testing.T) {
	fn := newFakeNet()
	fn.messages = []lan.Message{{ID: "m1", From: lan.Device{Alias: "Phone"}, Text: "hello", At: 1}}
	fj := &fakeJobs{}
	svc := NewService(fj, fn)
	out, err := svc.SaveMessage("m1")
	if err != nil || out.Name != "Message.txt" {
		t.Fatalf("out = %+v, %v", out, err)
	}
	if len(fj.subs) != 1 || fj.subs[0].module != ReceiveID || strings.Contains(fj.subs[0].opts, "hello") {
		t.Errorf("subs = %+v (the text must stay out of the options)", fj.subs)
	}
	if _, err := svc.SaveMessage("nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("err = %v", err)
	}
}

func TestSaveMessageJob(t *testing.T) {
	out := t.TempDir()
	token := shared.putMessage(savedMessage{Alias: "Phone", Text: "hello there", At: time.Date(2026, 11, 4, 14, 30, 0, 0, time.Local).UnixMilli()})
	_, r := New(newFakeNet())
	rec := &recorder{}
	for i := 0; i < 2; i++ {
		if i == 1 {
			token = shared.putMessage(savedMessage{Alias: "Phone", Text: "again", At: time.Date(2026, 11, 4, 14, 30, 0, 0, time.Local).UnixMilli()})
		}
		if err := r.Run(context.Background(), rec.ctx(nil, ReceiveOptions{Message: token}, out, t.TempDir())); err != nil {
			t.Fatal(err)
		}
	}
	if len(rec.outputs) != 2 || filepath.Base(rec.outputs[0]) != "Message 2026-11-04 14-30.txt" || filepath.Base(rec.outputs[1]) != "Message 2026-11-04 14-30 (2).txt" {
		t.Fatalf("outputs = %v", rec.outputs)
	}
	if b, _ := os.ReadFile(rec.outputs[0]); string(b) != "hello there" {
		t.Errorf("content = %q", b)
	}
}

func TestServicePairIsExclusive(t *testing.T) {
	fn := &blockingPairNet{fakeNet: newFakeNet(), started: make(chan struct{})}
	svc := NewService(&fakeJobs{}, fn)
	done := make(chan error, 1)
	go func() { _, err := svc.Pair("aa11"); done <- err }()
	<-fn.started
	if _, err := svc.Pair("bb22"); !core.IsCode(err, core.CodeConflict) {
		t.Errorf("second pair: %v", err)
	}
	svc.CancelPair()
	select {
	case err := <-done:
		if !core.IsCode(err, core.CodeCancelled) {
			t.Errorf("cancelled pair: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("CancelPair didn't stop Pair")
	}
	if code, err := NewService(&fakeJobs{}, newFakeNet()).Pair("aa11"); err != nil || code != "123456" {
		t.Errorf("pair = %q, %v", code, err)
	}
}

type blockingPairNet struct {
	*fakeNet
	started chan struct{}
}

func (b *blockingPairNet) Pair(ctx context.Context, fp string) (string, error) {
	close(b.started)
	<-ctx.Done()
	return "", ctx.Err()
}

// ---- pipeline step ----

func TestStepDescribe(t *testing.T) {
	fn := newFakeNet(laptop, lan.Device{Fingerprint: "bb22", Alias: "Pixel", Protocol: "https"})
	m, _ := New(fn)
	raw := func(o StepOptions) json.RawMessage { b, _ := json.Marshal(o); return b }

	info, err := m.DescribeStep(raw(StepOptions{Device: "aa11", WaitMinutes: 30, Text: "{name}"}))
	if err != nil {
		t.Fatal(err)
	}
	if info.Summary != "Send to Nicole's MacBook" || !info.Accepts.Any || len(info.Produces) != 1 || info.Produces[0].Role != "sent" ||
		len(info.Vars) != 1 || info.Vars[0].Name != "device" || len(info.Templates) != 1 || info.Templates[0] != "/text" {
		t.Errorf("info = %+v", info)
	}
	info, _ = m.DescribeStep(raw(StepOptions{Device: "bb22"}))
	if !strings.Contains(info.Summary, "LocalSend devices ask") {
		t.Errorf("summary = %q", info.Summary)
	}
	for name, o := range map[string]StepOptions{
		"no device":     {WaitMinutes: 30},
		"unknown":       {Device: "zz", WaitMinutes: 30},
		"negative":      {Device: "aa11", WaitMinutes: -1},
		"too long":      {Device: "aa11", WaitMinutes: 1441},
		"too much text": {Device: "aa11", Text: strings.Repeat("x", lan.MaxTextBytes+1)},
	} {
		if _, err := m.DescribeStep(raw(o)); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := m.DescribeStep(json.RawMessage(`{"device":"aa11","bogus":1}`)); err == nil {
		t.Error("unknown fields must be rejected")
	}
	if _, err := m.DescribeStep(nil); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("defaults need a device: %v", err)
	}
}

func stepReq(opts StepOptions, started int64, files ...string) core.StepRequest {
	b, _ := json.Marshal(opts)
	rf := make([]core.RunFile, len(files))
	for i, f := range files {
		rf[i] = core.RunFile{Path: f, Name: filepath.Base(f)}
	}
	return core.StepRequest{Options: b, Started: started, Item: core.StepItem{Files: rf, Vars: map[string]string{"title": "Trip"}}}
}

func TestStepPrepareOnline(t *testing.T) {
	fn := newFakeNet(laptop)
	m, _ := New(fn)
	jobs, err := m.PrepareStep(context.Background(), stepReq(StepOptions{Device: "aa11", WaitMinutes: 30, Text: "From {title}: {name}"}, time.Now().UnixMilli(), "/a/one.jpg", "/a/two.jpg", "/a/one.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || len(jobs[0].Inputs) != 2 {
		t.Fatalf("jobs = %+v", jobs)
	}
	o, ok := jobs[0].Options.(Options)
	if !ok || o.Device != "aa11" || o.Text != "From Trip: one" || o.PinRef != "" {
		t.Errorf("options = %+v", jobs[0].Options)
	}
	if _, err := m.PrepareStep(context.Background(), stepReq(StepOptions{Device: "aa11"}, 0)); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("no files: %v", err)
	}
}

func TestStepPrepareWaitsThenTimesOut(t *testing.T) {
	away := laptop
	away.Online = false
	fn := newFakeNet(away)
	fn.probeErrs = []error{errors.New("unreachable"), errors.New("unreachable"), nil}
	m, _ := New(fn)
	now := time.Now().UnixMilli()

	_, err := m.PrepareStep(context.Background(), stepReq(StepOptions{Device: "aa11", WaitMinutes: 30}, now, "/a/f.jpg"))
	ae := core.AsAppError(err)
	if ae.Code != core.CodeWaiting || ae.Message != "Waiting for Nicole's MacBook to be on the network" {
		t.Fatalf("err = %v", err)
	}
	// Past the deadline it fails.
	old := time.Now().Add(-31 * time.Minute).UnixMilli()
	_, err = m.PrepareStep(context.Background(), stepReq(StepOptions{Device: "aa11", WaitMinutes: 30}, old, "/a/f.jpg"))
	if !core.IsCode(err, lan.CodeOffline) {
		t.Fatalf("err = %v", err)
	}
	// Back on the network: a job.
	jobs, err := m.PrepareStep(context.Background(), stepReq(StepOptions{Device: "aa11", WaitMinutes: 30}, old, "/a/f.jpg"))
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v, err = %v", jobs, err)
	}
	// WaitMinutes 0 fails at once when the device is away.
	fn.probeErrs = []error{errors.New("unreachable")}
	if _, err := m.PrepareStep(context.Background(), stepReq(StepOptions{Device: "aa11", WaitMinutes: 0}, now-1000, "/a/f.jpg")); !core.IsCode(err, lan.CodeOffline) {
		t.Errorf("wait 0: %v", err)
	}
}

func TestStepPrepareSeenRecentlyCountsAsOnline(t *testing.T) {
	fn := newFakeNet(laptop) // Online: seen within two minutes, even though the probe fails
	fn.probeErrs = []error{errors.New("unreachable")}
	m, _ := New(fn)
	jobs, err := m.PrepareStep(context.Background(), stepReq(StepOptions{Device: "aa11", WaitMinutes: 30}, time.Now().UnixMilli(), "/a/f.jpg"))
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v, err = %v", jobs, err)
	}
}

func TestStepOutputsPassFilesThrough(t *testing.T) {
	m, _ := New(newFakeNet(laptop))
	res, err := m.StepOutputs(core.Job{Inputs: []string{"/a/one.jpg", "/a/two.jpg"}, ResultJSON: `{"device":"Nicole's MacBook","files":2}`})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 || res.Files[0].Role != "sent" || res.Files[0].Name != "one.jpg" || res.Files[0].Path != "/a/one.jpg" || res.Vars["device"] != "Nicole's MacBook" {
		t.Errorf("result = %+v", res)
	}
	res, _ = m.StepOutputs(core.Job{Inputs: []string{"/a/one.jpg"}})
	if _, ok := res.Vars["device"]; !ok {
		t.Error("device var should always be defined")
	}
}

func TestDescriptors(t *testing.T) {
	reg := core.NewRegistry()
	m, r := New(nil)
	if err := Register(reg, m, r); err != nil {
		t.Fatal(err)
	}
	d, _ := reg.Descriptor(ReceiveID)
	if !d.Hidden || d.OutputSubdir != "Received" {
		t.Errorf("receive descriptor = %+v", d)
	}
	d, _ = reg.Descriptor(ModuleID)
	if d.Hidden || !d.Accepts.Any || d.Icon != "arrow-left-right" {
		t.Errorf("send descriptor = %+v", d)
	}
}

func TestSafeComponent(t *testing.T) {
	for in, want := range map[string]string{
		"ok.txt": "ok.txt", "a<b>c.txt": "abc.txt", "  .hidden. ": "hidden", "": "file", "..": "file", "NUL": "NUL_", "com1.txt": "com1_.txt",
		"nul.tar.gz": "nul_.tar.gz", "Nicole's MacBook": "Nicole's MacBook", "a:b": "ab",
	} {
		if got := safeComponent(in); got != want {
			t.Errorf("safeComponent(%q) = %q, want %q", in, got, want)
		}
	}
}
