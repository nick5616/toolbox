package lan

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core"
)

// twoRuntimes returns A (the sender, alias "alpha") and B (the receiver, alias "bravo") both
// listening on loopback, plus B as A sees it.
func twoRuntimes(t *testing.T) (a, b *harness, bOnA Device) {
	t.Helper()
	a = newHarness(t, func(c *Config) { c.Hostname = func() (string, error) { return "alpha", nil } })
	b = newHarness(t, func(c *Config) { c.Hostname = func() (string, error) { return "bravo", nil } })
	a.listen()
	b.listen()
	dev, err := a.rt.AddByAddress(context.Background(), "127.0.0.1", b.rt.State().Port)
	if err != nil {
		t.Fatal(err)
	}
	return a, b, dev
}

func TestAddByAddress(t *testing.T) {
	a, b, dev := twoRuntimes(t)
	if dev.Fingerprint != b.rt.Fingerprint() || dev.Alias != "bravo" || !dev.Toolbox || dev.Paired || dev.Protocol != "https" || dev.Port != b.rt.State().Port {
		t.Errorf("device = %+v", dev)
	}
	// B heard of A through the register call too.
	waitFor(t, "B learns A", func() bool { _, ok := b.rt.Device(a.rt.Fingerprint()); return ok })

	if _, err := a.rt.AddByAddress(context.Background(), "8.8.8.8", 0); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("a public address: %v", err)
	}
	if _, err := a.rt.AddByAddress(context.Background(), "127.0.0.1", 1); !core.IsCode(err, CodeOffline) {
		t.Errorf("nothing there: %v", err)
	}
	if _, err := a.rt.AddByAddress(context.Background(), "127.0.0.1", a.rt.State().Port); !core.IsCode(err, CodeOffline) {
		t.Errorf("itself: %v", err)
	}
}

func TestPairing(t *testing.T) {
	a, b, dev := twoRuntimes(t)
	var seen Prompt
	b.setOnPrompt(func(p Prompt) {
		seen = p
		b.rt.Respond(p.ID, true, false)
	})
	if want := a.rt.PairCodeWith(dev.Fingerprint); want != PairCode(a.rt.Fingerprint(), b.rt.Fingerprint()) {
		t.Fatalf("PairCodeWith = %s", want)
	}
	code, err := a.rt.Pair(context.Background(), dev.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if code != PairCode(a.rt.Fingerprint(), b.rt.Fingerprint()) || len(code) != 6 {
		t.Errorf("code = %s", code)
	}
	if seen.Kind != PromptPair || seen.PairCode != code || seen.Device.Alias != "alpha" || seen.Device.Fingerprint != a.rt.Fingerprint() || !seen.Verified {
		t.Errorf("B's prompt = %+v (code %s)", seen, code)
	}
	da, _ := a.rt.Device(b.rt.Fingerprint())
	db, _ := b.rt.Device(a.rt.Fingerprint())
	if !da.Paired || !da.Toolbox || !da.Stored || da.AutoAccept {
		t.Errorf("A's view of B: %+v", da)
	}
	if !db.Paired || !db.Toolbox || !db.Stored || db.AutoAccept {
		t.Errorf("B's view of A: %+v", db)
	}
	// Persisted: a new runtime on A's directory still has the pairing.
	a.rt.Close()
	rt2, err := New(Config{Dir: a.dir, AllowLoopback: true, Packet: a.net.factory})
	if err != nil {
		t.Fatal(err)
	}
	defer rt2.Close()
	if d, ok := rt2.Device(b.rt.Fingerprint()); !ok || !d.Paired || !d.Stored || d.Online {
		t.Errorf("after restart: %+v %v", d, ok)
	}
}

func TestPairingRefusals(t *testing.T) {
	t.Run("declined", func(t *testing.T) {
		a, b, dev := twoRuntimes(t)
		b.answerPrompts(false, false)
		if _, err := a.rt.Pair(context.Background(), dev.Fingerprint); !core.IsCode(err, CodeDeclined) {
			t.Errorf("err = %v", err)
		}
		if d, _ := a.rt.Device(dev.Fingerprint); d.Paired {
			t.Error("must not be paired")
		}
		if d, ok := b.rt.Device(a.rt.Fingerprint()); ok && d.Paired {
			t.Error("B must not be paired")
		}
	})
	t.Run("a client certificate is required", func(t *testing.T) {
		_, b, _ := twoRuntimes(t)
		code, _ := post(t, httpClient(nil), b.url(PairPath), pairRequest{Alias: "x"})
		if code != 403 {
			t.Errorf("no certificate = %d", code)
		}
	})
	t.Run("cancellable and never turns on auto-accept", func(t *testing.T) {
		a, b, dev := twoRuntimes(t)
		b.setOnPrompt(func(Prompt) {}) // nobody answers
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { _, err := a.rt.Pair(ctx, dev.Fingerprint); done <- err }()
		waitFor(t, "B's prompt", func() bool { return len(b.eventsNamed(EventPrompt)) == 1 })
		cancel()
		select {
		case err := <-done:
			if !core.IsCode(err, core.CodeCancelled) {
				t.Errorf("err = %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("Pair did not return after cancel")
		}
		waitFor(t, "prompt closed", func() bool { return len(b.eventsNamed(EventPromptClose)) == 1 })
		if got := b.eventsNamed(EventPromptClose)[0].(PromptClosed).Reason; got != "cancelled" {
			t.Errorf("reason = %s", got)
		}
	})
	t.Run("a LocalSend device can't be paired", func(t *testing.T) {
		a := newHarness(t)
		a.rt.mu.Lock()
		a.rt.devs["ab"] = &Device{Fingerprint: "ab", Alias: "Phone", Address: "127.0.0.1", Port: 1, Protocol: "https"}
		a.rt.mu.Unlock()
		if _, err := a.rt.Pair(context.Background(), "ab"); !core.IsCode(err, core.CodeValidation) {
			t.Errorf("err = %v", err)
		}
		if _, err := a.rt.Pair(context.Background(), "nope"); !core.IsCode(err, core.CodeNotFound) {
			t.Errorf("unknown: %v", err)
		}
	})
}

func fillRandom(path string, n int, seed int64) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	rng := rand.New(rand.NewSource(seed))
	buf := make([]byte, 1<<20)
	for left := n; left > 0; {
		k := min(left, len(buf))
		rng.Read(buf[:k])
		if _, err := f.Write(buf[:k]); err != nil {
			return err
		}
		left -= k
	}
	return nil
}

func hashFile(t *testing.T, path string) [32]byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		t.Fatal(err)
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func TestTwoRuntimeTransfer(t *testing.T) {
	a, b, dev := twoRuntimes(t)
	// Pair, then let B accept from A without asking.
	b.answerPrompts(true, false)
	if _, err := a.rt.Pair(context.Background(), dev.Fingerprint); err != nil {
		t.Fatal(err)
	}
	if err := b.rt.SetAutoAccept(a.rt.Fingerprint(), true); err != nil {
		t.Fatal(err)
	}
	b.setOnPrompt(func(p Prompt) { t.Errorf("auto-accept must not prompt: %+v", p) })

	src := t.TempDir()
	tree := map[string]string{
		"Trip/day1/IMG_0001.jpg":  "jpeg bytes",
		"Trip/day1/notes ünï.txt": "unicode name",
		"Trip/日本語/ファイル.txt":       "japanese",
		"Trip/empty.dat":          "",
		"Trip/deep/a/b/c/d/e.txt": "deep",
		"Trip/Café́ menu.txt":     "composed",
	}
	var files []SendFile
	before := map[string][32]byte{}
	for rel, data := range tree {
		p := filepath.Join(src, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o700)
		os.WriteFile(p, []byte(data), 0o600)
		files = append(files, SendFile{Path: p, RelPath: rel, Size: int64(len(data)), Type: "application/octet-stream"})
	}
	big := filepath.Join(src, "Trip", "big.bin")
	const bigSize = 50 << 20
	if err := fillRandom(big, bigSize, 7); err != nil {
		t.Fatal(err)
	}
	files = append(files, SendFile{Path: big, RelPath: "Trip/big.bin", Size: bigSize, Type: "application/octet-stream"})
	for _, f := range files {
		before[f.Path] = hashFile(t, f.Path)
	}

	var last SendProgress
	var calls int
	res, err := a.rt.Send(context.Background(), SendRequest{Device: dev, Files: files}, func(p SendProgress) { last = p; calls++ })
	if err != nil {
		t.Fatal(err)
	}
	if res.Files != len(files) || res.Bytes != int64(bigSize+len("jpeg bytes")+len("unicode name")+len("japanese")+len("deep")+len("composed")) || res.AsMessage {
		t.Errorf("result = %+v", res)
	}
	if last.Done != res.Bytes || last.Total != res.Bytes || last.FileCount != len(files) || calls < 3 {
		t.Errorf("progress ended at %+v after %d calls", last, calls)
	}
	if err := <-b.sinkErr; err != nil {
		t.Fatalf("receive: %v", err)
	}
	root := filepath.Join(b.recv, "alpha")
	for _, f := range files {
		got := filepath.Join(root, filepath.FromSlash(mustSanitize(t, f.RelPath)))
		if hashFile(t, got) != before[f.Path] {
			t.Errorf("%s differs from the original", f.RelPath)
		}
		fi, _ := os.Stat(got)
		if fi.Size() != f.Size {
			t.Errorf("%s size %d != %d", f.RelPath, fi.Size(), f.Size)
		}
	}
	for _, f := range files { // inputs untouched
		if hashFile(t, f.Path) != before[f.Path] {
			t.Errorf("input %s was modified", f.Path)
		}
	}
	// A remembers where it sent to.
	if d, _ := a.rt.Device(dev.Fingerprint); !d.Stored {
		t.Error("the device should be stored after a send")
	}
}

func mustSanitize(t *testing.T, rel string) string {
	t.Helper()
	s, err := SanitizePath(rel)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSendTextMessage(t *testing.T) {
	a, b, dev := twoRuntimes(t)
	b.answerPrompts(true, false)
	res, err := a.rt.Send(context.Background(), SendRequest{Device: dev, Text: "https://example.com/x"}, nil)
	if err != nil || !res.AsMessage {
		t.Fatalf("res %+v, err %v", res, err)
	}
	msgs := b.rt.Messages()
	if len(msgs) != 1 || msgs[0].Text != "https://example.com/x" || msgs[0].From.Alias != "alpha" {
		t.Errorf("messages = %+v", msgs)
	}
	if _, err := a.rt.Send(context.Background(), SendRequest{Device: dev}, nil); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("nothing to send: %v", err)
	}
	if _, err := a.rt.Send(context.Background(), SendRequest{Device: dev, Text: strings.Repeat("x", MaxTextBytes+1)}, nil); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("too long: %v", err)
	}
}

// ---- client ----

func TestClientPinning(t *testing.T) {
	a, b, dev := twoRuntimes(t)
	_ = b
	wrong := dev
	wrong.Fingerprint = strings.Repeat("ab", 32)
	f := filepath.Join(t.TempDir(), "x.txt")
	os.WriteFile(f, []byte("x"), 0o600)
	_, err := a.rt.Send(context.Background(), SendRequest{Device: wrong, Files: []SendFile{{Path: f, RelPath: "x.txt", Size: 1}}}, nil)
	if !core.IsCode(err, CodeWrongDevice) {
		t.Fatalf("Send err = %v", err)
	}
	var ae *core.AppError
	if e, ok := err.(*core.AppError); ok {
		ae = e
	}
	if ae == nil || ae.Message != "This isn't the device you paired with" || ae.Hint == "" {
		t.Errorf("error = %+v", ae)
	}
	a.rt.mu.Lock()
	a.rt.devs[wrong.Fingerprint] = &Device{Fingerprint: wrong.Fingerprint, Alias: "bravo", Address: "127.0.0.1", Port: dev.Port, Protocol: "https", Stored: true, Paired: true, Toolbox: true}
	a.rt.mu.Unlock()
	if _, err := a.rt.Probe(context.Background(), wrong.Fingerprint); !core.IsCode(err, CodeWrongDevice) {
		t.Errorf("Probe err = %v", err)
	}
	if _, err := a.rt.Pair(context.Background(), wrong.Fingerprint); !core.IsCode(err, CodeWrongDevice) {
		t.Errorf("Pair err = %v", err)
	}
	if _, err := a.rt.Probe(context.Background(), dev.Fingerprint); err != nil {
		t.Errorf("right fingerprint: %v", err)
	}
	// The handshake fails before any request is sent: B never saw a prompt.
	if len(b.eventsNamed(EventPrompt)) != 0 {
		t.Error("a pinned failure must not reach the receiver")
	}
}

func TestClientRefusesPlainHTTPPeers(t *testing.T) {
	a := newHarness(t)
	dev := Device{Fingerprint: "ab", Alias: "Old phone", Address: "127.0.0.1", Port: 1, Protocol: "http"}
	if _, err := a.rt.Send(context.Background(), SendRequest{Device: dev, Text: "hi"}, nil); !core.IsCode(err, CodeEncryptionOff) {
		t.Errorf("Send: %v", err)
	}
	a.rt.mu.Lock()
	a.rt.devs["ab"] = &dev
	a.rt.mu.Unlock()
	if _, err := a.rt.Probe(context.Background(), "ab"); !core.IsCode(err, CodeEncryptionOff) {
		t.Errorf("Probe: %v", err)
	}
	// An HTTP server behind the address is recognised too.
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	host, port, _ := net.SplitHostPort(u.Host)
	p, _ := net.LookupPort("tcp", port)
	if _, err := a.rt.AddByAddress(context.Background(), host, p); !core.IsCode(err, CodeEncryptionOff) {
		t.Errorf("AddByAddress to http: %v", err)
	}
}

func TestPrepareWaitIsCancellable(t *testing.T) {
	if prepareTimeout != 5*time.Minute {
		t.Errorf("prepare waits %v, want 5 minutes", prepareTimeout)
	}
	a, b, dev := twoRuntimes(t)
	b.setOnPrompt(func(Prompt) {}) // the other person never answers
	ctx, cancel := context.WithCancel(context.Background())
	var stage atomic.Value
	done := make(chan error, 1)
	start := time.Now()
	go func() {
		_, err := a.rt.Send(ctx, SendRequest{Device: dev, Text: "hello"}, func(p SendProgress) { stage.Store(p.Stage) })
		done <- err
	}()
	waitFor(t, "waiting stage", func() bool {
		s, _ := stage.Load().(string)
		return s == "waiting" && len(b.eventsNamed(EventPrompt)) == 1
	})
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !core.IsCode(err, core.CodeCancelled) {
			t.Errorf("err = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Send is stuck waiting")
	}
	if time.Since(start) > 4*time.Second {
		t.Error("cancel took too long")
	}
	waitFor(t, "receiver's prompt to close", func() bool { return len(b.eventsNamed(EventPromptClose)) == 1 })
	waitFor(t, "slot freed", func() bool { b.rt.mu.Lock(); defer b.rt.mu.Unlock(); return !b.rt.busy })
}

func TestCancelDuringUploadTellsReceiver(t *testing.T) {
	a, b, dev := twoRuntimes(t)
	b.answerPrompts(true, false)
	b.rt.SetSink(sinkFunc(func(s IncomingSession) error { // a slow receiver, so the upload is still running when we cancel
		go func() {
			fs, err := s.Next(context.Background())
			if err == nil {
				_, err = io.Copy(io.Discard, slowReader{fs.Body})
				fs.Done(err)
			}
			s.Finished(err)
			b.sinkErr <- err
		}()
		return nil
	}))
	src := filepath.Join(t.TempDir(), "big.bin")
	const size = 40 << 20
	if err := fillRandom(src, size, 3); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	var once atomic.Bool
	_, err := a.rt.Send(ctx, SendRequest{Device: dev, Files: []SendFile{{Path: src, RelPath: "big.bin", Size: size}}}, func(p SendProgress) {
		if p.Stage == "uploading" && p.Done > 1<<20 && once.CompareAndSwap(false, true) {
			cancel()
		}
	})
	if !core.IsCode(err, core.CodeCancelled) {
		t.Fatalf("err = %v", err)
	}
	if rerr := <-b.sinkErr; rerr == nil {
		t.Error("the receiving side should have seen the transfer fail")
	}
	waitFor(t, "slot freed", func() bool { b.rt.mu.Lock(); defer b.rt.mu.Unlock(); return !b.rt.busy })
}

type slowReader struct{ r io.Reader }

func (s slowReader) Read(p []byte) (int, error) {
	time.Sleep(5 * time.Millisecond)
	return s.r.Read(p)
}

// stubPeer is a fake LocalSend receiver for status-mapping tests.
type stubPeer struct {
	srv     *httptest.Server
	dev     Device
	prepare func(w http.ResponseWriter, r *http.Request)
	upload  func(w http.ResponseWriter, r *http.Request, n int)
	uploads atomic.Int32
	cancels atomic.Int32
	pinSeen atomic.Value
}

func newStub(t *testing.T) *stubPeer {
	s := &stubPeer{}
	mux := http.NewServeMux()
	mux.HandleFunc(APIBase+"/prepare-upload", func(w http.ResponseWriter, r *http.Request) {
		s.pinSeen.Store(r.URL.Query().Get("pin"))
		s.prepare(w, r)
	})
	mux.HandleFunc(APIBase+"/upload", func(w http.ResponseWriter, r *http.Request) {
		n := int(s.uploads.Add(1))
		io.Copy(io.Discard, r.Body)
		s.upload(w, r, n)
	})
	mux.HandleFunc(APIBase+"/cancel", func(w http.ResponseWriter, r *http.Request) { s.cancels.Add(1) })
	s.srv = httptest.NewTLSServer(mux)
	t.Cleanup(s.srv.Close)
	u, _ := url.Parse(s.srv.URL)
	host, port, _ := net.SplitHostPort(u.Host)
	p, _ := net.LookupPort("tcp", port)
	s.dev = Device{Fingerprint: Fingerprint(s.srv.Certificate().Raw), Alias: "Stub", Address: host, Port: p, Protocol: "https"}
	s.prepare = func(w http.ResponseWriter, r *http.Request) {
		var req prepareRequest
		json.NewDecoder(r.Body).Decode(&req)
		resp := prepareResponse{SessionID: "s1", Files: map[string]string{}}
		for id := range req.Files {
			resp.Files[id] = "tok-" + id
		}
		json.NewEncoder(w).Encode(resp)
	}
	s.upload = func(w http.ResponseWriter, r *http.Request, n int) {}
	return s
}

func TestSendStatusMapping(t *testing.T) {
	a := newHarness(t)
	f := filepath.Join(t.TempDir(), "x.txt")
	os.WriteFile(f, []byte("data"), 0o600)
	files := []SendFile{{Path: f, RelPath: "x.txt", Size: 4}}
	tests := []struct {
		name    string
		status  int
		body    string
		wantErr core.ErrorCode
		msg     bool
	}{
		{"204 is a message", 204, "", "", true},
		{"401", 401, "", CodePinRequired, false},
		{"403", 403, "", CodeDeclined, false},
		{"403 space", 403, `{"error":"insufficient_space"}`, CodeTooLarge, false},
		{"409", 409, "", CodeBusy, false},
		{"429", 429, "", CodeBusy, false},
		{"400", 400, "", core.CodeInternal, false},
		{"500", 500, "", core.CodeInternal, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newStub(t)
			s.prepare = func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}
			res, err := a.rt.Send(context.Background(), SendRequest{Device: s.dev, Files: files}, nil)
			if tc.msg {
				if err != nil || !res.AsMessage {
					t.Errorf("res %+v err %v", res, err)
				}
				return
			}
			var ae *core.AppError
			if !core.IsCode(err, tc.wantErr) {
				t.Fatalf("err = %v, want %s", err, tc.wantErr)
			}
			ae, _ = err.(*core.AppError)
			if ae.Message == "" || (tc.wantErr != core.CodeInternal && ae.Hint == "") {
				t.Errorf("error lacks message/hint: %+v", ae)
			}
			if tc.wantErr == CodePinRequired && ae.Fields["pin"] == "" {
				t.Error("the pin field should be named")
			}
		})
	}
	t.Run("pin is sent", func(t *testing.T) {
		s := newStub(t)
		if _, err := a.rt.Send(context.Background(), SendRequest{Device: s.dev, Files: files, PIN: "a b&c"}, nil); err != nil {
			t.Fatal(err)
		}
		if got, _ := s.pinSeen.Load().(string); got != "a b&c" {
			t.Errorf("pin = %q", got)
		}
	})
	t.Run("422 retries once then succeeds", func(t *testing.T) {
		s := newStub(t)
		s.upload = func(w http.ResponseWriter, r *http.Request, n int) {
			if n == 1 {
				w.WriteHeader(422)
			}
		}
		if _, err := a.rt.Send(context.Background(), SendRequest{Device: s.dev, Files: files}, nil); err != nil {
			t.Fatal(err)
		}
		if s.uploads.Load() != 2 {
			t.Errorf("uploads = %d", s.uploads.Load())
		}
	})
	t.Run("422 twice fails and cancels the session", func(t *testing.T) {
		s := newStub(t)
		s.upload = func(w http.ResponseWriter, r *http.Request, n int) { w.WriteHeader(422) }
		_, err := a.rt.Send(context.Background(), SendRequest{Device: s.dev, Files: files}, nil)
		if !core.IsCode(err, core.CodeInternal) {
			t.Errorf("err = %v", err)
		}
		if s.uploads.Load() != 2 || s.cancels.Load() != 1 {
			t.Errorf("uploads %d cancels %d", s.uploads.Load(), s.cancels.Load())
		}
	})
	t.Run("upload 403 and 409", func(t *testing.T) {
		for code, want := range map[int]core.ErrorCode{403: CodeDeclined, 409: CodeBusy} {
			s := newStub(t)
			s.upload = func(w http.ResponseWriter, r *http.Request, n int) { w.WriteHeader(code) }
			if _, err := a.rt.Send(context.Background(), SendRequest{Device: s.dev, Files: files}, nil); !core.IsCode(err, want) {
				t.Errorf("upload %d: %v", code, err)
			}
		}
	})
	t.Run("an unreachable device is offline", func(t *testing.T) {
		l, _ := net.Listen("tcp", "127.0.0.1:0")
		port := l.Addr().(*net.TCPAddr).Port
		l.Close()
		dev := Device{Fingerprint: "ab", Alias: "Gone", Address: "127.0.0.1", Port: port, Protocol: "https"}
		_, err := a.rt.Send(context.Background(), SendRequest{Device: dev, Files: files}, nil)
		var ae *core.AppError
		if !core.IsCode(err, CodeOffline) {
			t.Fatalf("err = %v", err)
		}
		ae, _ = err.(*core.AppError)
		if ae.Message != "Gone isn't on this network right now" || ae.Hint != "Open Toolbox or LocalSend on it and make sure it's receiving" {
			t.Errorf("error = %+v", ae)
		}
	})
	t.Run("a file that changed size is refused", func(t *testing.T) {
		s := newStub(t)
		bad := []SendFile{{Path: f, RelPath: "x.txt", Size: 99}}
		if _, err := a.rt.Send(context.Background(), SendRequest{Device: s.dev, Files: bad}, nil); err == nil {
			t.Error("want an error")
		}
	})
}

func TestUploadSessionLimitsParallelism(t *testing.T) {
	a := newHarness(t)
	s := newStub(t)
	var cur, peak atomic.Int32
	s.upload = func(w http.ResponseWriter, r *http.Request, n int) {}
	mux := s.srv.Config.Handler
	s.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/upload") {
			c := cur.Add(1)
			for {
				p := peak.Load()
				if c <= p || peak.CompareAndSwap(p, c) {
					break
				}
			}
			time.Sleep(60 * time.Millisecond)
			defer cur.Add(-1)
		}
		mux.ServeHTTP(w, r)
	})
	var files []SendFile
	dir := t.TempDir()
	for i := 0; i < 9; i++ {
		p := filepath.Join(dir, itoa(i))
		os.WriteFile(p, []byte("x"), 0o600)
		files = append(files, SendFile{Path: p, RelPath: itoa(i), Size: 1})
	}
	if _, err := a.rt.Send(context.Background(), SendRequest{Device: s.dev, Files: files}, nil); err != nil {
		t.Fatal(err)
	}
	if s.uploads.Load() != 9 || peak.Load() > 3 || peak.Load() < 2 {
		t.Errorf("uploads %d, peak concurrency %d (want 2..3)", s.uploads.Load(), peak.Load())
	}
}

// ---- discovery ----

func TestAnnounceAnswering(t *testing.T) {
	a, b, _ := twoRuntimes(t)
	pc := a.net.listener()
	// Three announcements go out when listening starts (0, 1 and 3 s).
	waitFor(t, "first announcement", func() bool { return len(pc.sentPackets()) >= 2 })
	var sent Info
	if err := json.Unmarshal(pc.sentPackets()[0].data, &sent); err != nil {
		t.Fatal(err)
	}
	if !sent.Announce || sent.Toolbox != 1 || sent.Fingerprint != a.rt.Fingerprint() || sent.Port != a.rt.State().Port || sent.Protocol != "https" || sent.DeviceModel != "Toolbox" {
		t.Errorf("announcement = %+v", sent)
	}
	dests := map[string]bool{}
	for _, p := range pc.sentPackets() {
		dests[p.to] = true
	}
	if !dests["224.0.0.167:53317"] || !dests["[ff12::167]:53317"] {
		t.Errorf("destinations = %v", dests)
	}

	// B announces itself by multicast: A registers with it over HTTPS.
	ann, _ := json.Marshal(b.rt.selfInfo(true))
	pc.in <- datagram{data: ann, from: "127.0.0.1:53317"}
	waitFor(t, "B appears at A", func() bool {
		d, ok := a.rt.Device(b.rt.Fingerprint())
		return ok && d.Toolbox && d.Alias == "bravo" && d.Port == b.rt.State().Port
	})
	waitFor(t, "A appears at B (via the register call)", func() bool { _, ok := b.rt.Device(a.rt.Fingerprint()); return ok })

	// Our own announcement, junk, and public sources are ignored.
	self, _ := json.Marshal(a.rt.selfInfo(true))
	pc.in <- datagram{data: self, from: "127.0.0.1:53317"}
	pc.in <- datagram{data: []byte("{not json"), from: "127.0.0.1:1"}
	other, _ := json.Marshal(Info{Alias: "Public", Fingerprint: "pp", Port: 1, Protocol: "https", Announce: true})
	pc.in <- datagram{data: other, from: "8.8.8.8:53317"}
	time.Sleep(150 * time.Millisecond)
	if _, ok := a.rt.Device("pp"); ok {
		t.Error("a datagram from a public address must be ignored")
	}
	if _, ok := a.rt.Device(a.rt.Fingerprint()); ok {
		t.Error("we are not our own device")
	}
}

func TestAnnounceFallsBackToMulticastReply(t *testing.T) {
	a := newHarness(t)
	a.listen()
	pc := a.net.listener()
	l, _ := net.Listen("tcp", "127.0.0.1:0") // nobody serves here: register fails
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	before := len(pc.sentPackets())
	ann, _ := json.Marshal(Info{Alias: "Phone", Version: "2.0", Fingerprint: "ee", Port: port, Protocol: "https", Announce: true})
	pc.in <- datagram{data: ann, from: "127.0.0.1:53317"}
	waitFor(t, "UDP reply", func() bool {
		for _, p := range pc.sentPackets()[before:] {
			var in Info
			if json.Unmarshal(p.data, &in) == nil && !in.Announce && in.Fingerprint == a.rt.Fingerprint() {
				return true
			}
		}
		return false
	})
	if d, ok := a.rt.Device("ee"); !ok || d.Alias != "Phone" {
		t.Errorf("the announcer is still recorded as nearby: %+v", d)
	}
}

func TestScan(t *testing.T) {
	a, b, _ := twoRuntimes(t)
	a.rt.mu.Lock()
	delete(a.rt.devs, b.rt.Fingerprint())
	a.rt.mu.Unlock()
	a.rt.scanTargetsFn = func() []scanTarget {
		return []scanTarget{{host: "127.0.0.1", port: b.rt.State().Port}, {host: "127.0.0.1", port: 1}}
	}
	// Scan works without a listener on the scanning side.
	a.rt.SetReceive(ReceiveOff)
	a.rt.Scan(context.Background())
	d, ok := a.rt.Device(b.rt.Fingerprint())
	if !ok || d.Alias != "bravo" || !d.Online || d.Stored {
		t.Fatalf("scan result = %+v %v", d, ok)
	}
	// An ephemeral announcement went out.
	var announced bool
	for _, c := range a.net.conns {
		if !c.listen && len(c.sentPackets()) == 2 {
			announced = true
		}
	}
	if !announced {
		t.Error("Scan should send one multicast announcement (both groups) from a sender socket")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	a.rt.Scan(ctx) // returns promptly
}

func TestOnlineWindow(t *testing.T) {
	a, b, dev := twoRuntimes(t)
	_ = b
	if d, _ := a.rt.Device(dev.Fingerprint); !d.Online {
		t.Fatal("just seen")
	}
	a.clock.Advance(OnlineWindow + time.Second)
	if d, _ := a.rt.Device(dev.Fingerprint); d.Online {
		t.Error("seen more than 2 minutes ago must be offline")
	}
}

// ---- lifecycle ----

func TestNoListenerAtStartUnlessAlways(t *testing.T) {
	for mode, want := range map[ReceiveMode]bool{ReceiveOff: false, ReceiveOpen: false, ReceiveAlways: true} {
		dir := t.TempDir()
		data, _ := json.Marshal(Settings{Receive: mode, From: FromAnyone})
		os.WriteFile(filepath.Join(dir, "settings.json"), data, 0o600)
		rt, err := New(Config{Dir: dir, AllowLoopback: true, Packet: (&fakeNet{}).factory})
		if err != nil {
			t.Fatal(err)
		}
		if got := rt.State().Listening; got != want {
			t.Errorf("mode %s: listening = %v, want %v", mode, got, want)
		}
		rt.Close()
	}
}

func TestOpenModeHoldExpiry(t *testing.T) {
	old := janitorInterval
	janitorInterval = 10 * time.Millisecond
	defer func() { janitorInterval = old }()
	h := newHarness(t)
	if err := h.rt.SetReceive(ReceiveOpen); err != nil {
		t.Fatal(err)
	}
	if h.rt.State().Listening {
		t.Fatal("open mode without a window must not listen")
	}
	h.rt.Hold("main")
	if !h.rt.State().Listening {
		t.Fatal("a hold should start listening")
	}
	h.clock.Advance(20 * time.Second)
	h.rt.Hold("main") // renewal
	h.clock.Advance(20 * time.Second)
	time.Sleep(60 * time.Millisecond)
	if !h.rt.State().Listening {
		t.Fatal("renewed hold must keep listening")
	}
	h.clock.Advance(HoldTTL) // 30 s after the last renewal
	waitFor(t, "listening to stop after the hold expires", func() bool { return !h.rt.State().Listening })
	// Two holds: releasing one keeps listening.
	h.rt.Hold("a")
	h.rt.Hold("b")
	h.rt.Release("a")
	if !h.rt.State().Listening {
		t.Error("one hold remains")
	}
	h.rt.Release("b")
	if h.rt.State().Listening {
		t.Error("no holds left")
	}
	// Holds don't matter in off and always modes.
	h.rt.SetReceive(ReceiveOff)
	h.rt.Hold("c")
	if h.rt.State().Listening {
		t.Error("off mode listens never")
	}
	h.rt.SetReceive(ReceiveAlways)
	if !h.rt.State().Listening {
		t.Error("always listens")
	}
}

func TestOffLeavesPortFree(t *testing.T) {
	h := newHarness(t)
	port := h.listen()
	if l, err := net.Listen("tcp", "127.0.0.1:"+itoa(port)); err == nil {
		l.Close()
		t.Fatal("the port should be taken while listening")
	}
	if err := h.rt.SetReceive(ReceiveOff); err != nil {
		t.Fatal(err)
	}
	st := h.rt.State()
	if st.Listening || st.Port != 0 {
		t.Errorf("state = %+v", st)
	}
	l, err := net.Listen("tcp", "127.0.0.1:"+itoa(port))
	if err != nil {
		t.Fatalf("the port is still held after switching off: %v", err)
	}
	l.Close()
	if lc := h.net.listener(); lc != nil {
		select {
		case <-lc.closed:
		default:
			t.Error("the multicast socket should be closed")
		}
	}
	if _, err := httpClient(nil).Get("https://127.0.0.1:" + itoa(port) + APIBase + "/info"); err == nil {
		t.Error("nothing should answer after switching off")
	}
}

func TestBusyPortFallsBack(t *testing.T) {
	hog, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer hog.Close()
	busy := hog.Addr().(*net.TCPAddr).Port
	h := newHarness(t, func(c *Config) { c.Port = busy })
	port := h.listen()
	if port == busy || port == 0 {
		t.Errorf("listening on %d, busy port was %d", port, busy)
	}
	if h.rt.State().Error != "" {
		t.Errorf("error = %q", h.rt.State().Error)
	}
	var self Info
	resp, err := httpClient(nil).Get(h.url(APIBase + "/info"))
	if err != nil {
		t.Fatal(err)
	}
	json.NewDecoder(resp.Body).Decode(&self)
	resp.Body.Close()
	if self.Port != port {
		t.Errorf("announced port %d, listening on %d", self.Port, port)
	}
}

func TestFixedPortUsed(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	free := l.Addr().(*net.TCPAddr).Port
	l.Close()
	h := newHarness(t, func(c *Config) { c.Port = free })
	if got := h.listen(); got != free {
		t.Errorf("port = %d, want %d", got, free)
	}
}

func TestPortUnavailableReported(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Port = -5 })
	err := h.rt.SetReceive(ReceiveAlways)
	if err != nil {
		t.Fatal(err)
	}
	st := h.rt.State()
	if st.Listening && st.Error != "" {
		t.Errorf("inconsistent state %+v", st)
	}
}

func TestCloseLeavesNoGoroutines(t *testing.T) {
	time.Sleep(50 * time.Millisecond)
	base := runtime.NumGoroutine()
	for i := 0; i < 3; i++ {
		a, b, dev := twoRuntimes(t)
		b.answerPrompts(true, false)
		a.rt.Send(context.Background(), SendRequest{Device: dev, Text: "hi"}, nil)
		// Leave a prompt pending and a session open when closing.
		b.setOnPrompt(func(Prompt) {})
		go a.rt.Send(context.Background(), SendRequest{Device: dev, Text: "pending"}, nil)
		waitFor(t, "pending prompt", func() bool { return len(b.eventsNamed(EventPrompt)) >= 2 })
		a.rt.Close()
		b.rt.Close()
		select {
		case <-a.rt.Done():
		case <-time.After(5 * time.Second):
			t.Fatal("janitor of A still running")
		}
		<-b.rt.Done()
		if b.rt.State().Listening || a.rt.State().Listening {
			t.Error("still listening after Close")
		}
	}
	http.DefaultClient.CloseIdleConnections()
	deadline := time.Now().Add(5 * time.Second)
	var now int
	for time.Now().Before(deadline) {
		now = runtime.NumGoroutine()
		if now <= base+2 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	buf := make([]byte, 1<<16)
	t.Errorf("goroutines: %d before, %d after Close\n%s", base, now, buf[:runtime.Stack(buf, true)])
}

func TestCloseCancelsSessionsAndPrompts(t *testing.T) {
	h := newHarness(t)
	h.listen()
	h.answerPrompts(true, false)
	c := httpClient(nil)
	code, body := prepare(t, h, c, "", prepBody("Phone", "ab", tf{name: "a", data: "x"}))
	if code != 200 {
		t.Fatal(code)
	}
	decodePrepare(t, body)
	h.rt.Close()
	if err := <-h.sinkErr; err == nil {
		t.Error("the open session should be cancelled by Close")
	}
	if _, err := c.Get(h.url(APIBase + "/info")); err == nil {
		t.Error("closed runtime still answers")
	}
	h.rt.Close() // idempotent
}

// ---- settings and devices ----

func TestSettingsPersistAndValidate(t *testing.T) {
	h := newHarness(t)
	st := h.rt.State()
	if st.Mode != ReceiveOff || st.From != FromAnyone || st.PINSet || st.Alias != "test-host" || st.ShortCode != strings.ToUpper(h.rt.Fingerprint()[:4]) || st.Listening {
		t.Errorf("defaults = %+v", st)
	}
	if err := h.rt.SetSettings(Settings{Alias: "  Studio PC  ", From: FromMine, PIN: "9876"}); err != nil {
		t.Fatal(err)
	}
	if st := h.rt.State(); st.Alias != "Studio PC" || st.From != FromMine || !st.PINSet {
		t.Errorf("state = %+v", st)
	}
	if err := h.rt.SetReceive(ReceiveOpen); err != nil {
		t.Fatal(err)
	}
	h.rt.Close()
	rt2, err := New(Config{Dir: h.dir, AllowLoopback: true, Packet: h.net.factory})
	if err != nil {
		t.Fatal(err)
	}
	defer rt2.Close()
	got := rt2.Settings()
	if got.Alias != "Studio PC" || got.From != FromMine || got.PIN != "9876" || got.Receive != ReceiveOpen {
		t.Errorf("reloaded = %+v", got)
	}
	// Clearing the alias returns to the hostname.
	if err := rt2.SetSettings(Settings{Alias: "", From: FromAnyone}); err != nil {
		t.Fatal(err)
	}
	if rt2.State().Alias == "" {
		t.Error("alias should fall back to the hostname")
	}
	for name, s := range map[string]Settings{
		"long alias": {Alias: strings.Repeat("a", 65), From: FromAnyone},
		"bad from":   {From: "everyone"},
		"long pin":   {From: FromAnyone, PIN: strings.Repeat("1", MaxPINLen+1)},
	} {
		err := rt2.SetSettings(s)
		var ae *core.AppError
		if !core.IsCode(err, core.CodeValidation) {
			t.Errorf("%s: %v", name, err)
			continue
		}
		ae, _ = err.(*core.AppError)
		if len(ae.Fields) == 0 {
			t.Errorf("%s: no field messages", name)
		}
	}
	if err := rt2.SetReceive("sometimes"); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("bad mode: %v", err)
	}
	// settings.json is private.
	fi, err := os.Stat(filepath.Join(h.dir, "settings.json"))
	if err != nil || (os.PathSeparator == '/' && fi.Mode().Perm()&0o077 != 0) {
		t.Errorf("settings file: %v %v", fi, err)
	}
}

func TestHostnameStripsDomain(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Hostname = func() (string, error) { return "Nicoles-MacBook-Pro.local", nil } })
	if got := h.rt.State().Alias; got != "Nicoles-MacBook-Pro" {
		t.Errorf("alias = %q", got)
	}
}

func TestDefaultAliasNeverReadsHostname(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.DefaultAlias = "Toolbox Demo"
		c.Hostname = func() (string, error) { t.Error("hostname was read"); return "secret-host", nil }
	})
	if got := h.rt.State().Alias; got != "Toolbox Demo" {
		t.Errorf("alias = %q", got)
	}
}

func TestDeviceStore(t *testing.T) {
	h := newHarness(t)
	rt := h.rt
	rt.mu.Lock()
	for i := 0; i < MaxKnownDevices+20; i++ {
		fp := strings.Repeat("0", 60) + itoa(1000+i)
		d := &Device{Fingerprint: fp, Alias: "d" + itoa(i), Address: "127.0.0.1", Port: 1, Protocol: "https", LastSeen: int64(1000 + i)}
		rt.devs[fp] = d
		rt.storeLocked(d)
	}
	rt.saveDevicesLocked()
	stored := 0
	for _, d := range rt.devs {
		if d.Stored {
			stored++
		}
	}
	rt.mu.Unlock()
	if stored != MaxKnownDevices {
		t.Errorf("stored %d devices, want %d", stored, MaxKnownDevices)
	}
	data, err := os.ReadFile(filepath.Join(h.dir, "devices.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f devicesFile
	json.Unmarshal(data, &f)
	if len(f.Devices) != MaxKnownDevices {
		t.Errorf("devices.json has %d", len(f.Devices))
	}
	for _, d := range f.Devices {
		if d.LastSeen < 1020 {
			t.Errorf("the oldest should be evicted first, found %d", d.LastSeen)
		}
	}
	// Atomic writes leave no temp files.
	ents, _ := os.ReadDir(h.dir)
	for _, e := range ents {
		if strings.Contains(e.Name(), ".tmp") {
			t.Errorf("leftover %s", e.Name())
		}
	}
}

func TestForgetAndAutoAccept(t *testing.T) {
	h := newHarness(t)
	peer := newIdentity(t)
	h.addPaired(peer, false)
	if err := h.rt.SetAutoAccept(peer.Fingerprint, true); err != nil {
		t.Fatal(err)
	}
	if d, _ := h.rt.Device(peer.Fingerprint); !d.AutoAccept {
		t.Error("auto-accept on")
	}
	h.rt.mu.Lock()
	h.rt.devs["ab"] = &Device{Fingerprint: "ab", Alias: "LocalSend phone", Stored: true}
	h.rt.mu.Unlock()
	if err := h.rt.SetAutoAccept("ab", true); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("only paired Toolbox devices: %v", err)
	}
	if err := h.rt.SetAutoAccept("nope", true); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("unknown: %v", err)
	}
	if err := h.rt.SetAutoAccept("ab", false); err != nil {
		t.Errorf("turning off is always fine: %v", err)
	}
	if err := h.rt.Forget(peer.Fingerprint); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.rt.Device(peer.Fingerprint); ok {
		t.Error("forgotten device (not seen recently) must disappear")
	}
	data, _ := os.ReadFile(filepath.Join(h.dir, "devices.json"))
	if bytes.Contains(data, []byte(peer.Fingerprint)) {
		t.Error("forgotten device is still in devices.json")
	}
	if err := h.rt.Forget("nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("unknown: %v", err)
	}
	// A device seen a moment ago stays as an unpaired nearby device.
	h.rt.noteDevice(Info{Alias: "Near", Fingerprint: "cc", Port: 1}, "cc", "127.0.0.1", true)
	h.rt.mu.Lock()
	h.rt.devs["cc"].Paired, h.rt.devs["cc"].Stored, h.rt.devs["cc"].Toolbox = true, true, true
	h.rt.mu.Unlock()
	h.rt.Forget("cc")
	if d, ok := h.rt.Device("cc"); !ok || d.Paired || d.Stored || d.AutoAccept {
		t.Errorf("after forget: %+v %v", d, ok)
	}
}

func TestDevicesOrderAndEvents(t *testing.T) {
	h := newHarness(t)
	h.rt.noteDevice(Info{Alias: "zed", Fingerprint: "aa", Port: 1}, "aa", "127.0.0.1", false)
	h.rt.noteDevice(Info{Alias: "Alpha", Fingerprint: "bb", Port: 1}, "bb", "127.0.0.1", false)
	h.rt.noteDevice(Info{Alias: "Mine", Fingerprint: "cc", Port: 1, Toolbox: 1}, "cc", "127.0.0.1", false)
	h.rt.mu.Lock()
	h.rt.devs["cc"].Paired = true
	h.rt.mu.Unlock()
	h.rt.emitDevicesIfChanged()
	var order []string
	for _, d := range h.rt.Devices() {
		order = append(order, d.Alias)
	}
	if strings.Join(order, ",") != "Mine,Alpha,zed" {
		t.Errorf("order = %v", order)
	}
	n := len(h.eventsNamed(EventDevices))
	h.rt.noteDevice(Info{Alias: "zed", Fingerprint: "aa", Port: 1}, "aa", "127.0.0.1", false) // nothing changed
	if got := len(h.eventsNamed(EventDevices)); got != n {
		t.Errorf("a repeat sighting emitted %d new events", got-n)
	}
	h.rt.noteDevice(Info{Alias: "zed 2", Fingerprint: "aa", Port: 1}, "aa", "127.0.0.1", false)
	if got := len(h.eventsNamed(EventDevices)); got != n+1 {
		t.Errorf("a rename should emit one event, got %d", got-n)
	}
	last := h.eventsNamed(EventDevices)[n].(DevicesChanged)
	if len(last.Devices) != 3 {
		t.Errorf("event carries %d devices", len(last.Devices))
	}
}

func TestMessagesAndActivityAreBounded(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < MaxMessages+10; i++ {
		h.rt.addMessage(Device{Alias: "x"}, "m"+itoa(i))
	}
	msgs := h.rt.Messages()
	if len(msgs) != MaxMessages || msgs[0].Text != "m10" || msgs[len(msgs)-1].Text != "m"+itoa(MaxMessages+9) {
		t.Errorf("messages: %d, first %q", len(msgs), msgs[0].Text)
	}
	for i := 0; i < 130; i++ {
		h.rt.AddActivity("a" + itoa(i))
	}
	acts := h.rt.Activity()
	if len(acts) != 100 || acts[0].Text != "a30" {
		t.Errorf("activity: %d, first %q", len(acts), acts[0].Text)
	}
	if len(h.eventsNamed(EventActivity)) != 130 {
		t.Error("each activity line emits an event")
	}
}

func TestStateEventsAndPrivacy(t *testing.T) {
	h := newHarness(t)
	h.listen()
	states := h.eventsNamed(EventState)
	if len(states) == 0 {
		t.Fatal("no state events")
	}
	last := states[len(states)-1].(State)
	if !last.Listening || last.Mode != ReceiveAlways || last.Port == 0 {
		t.Errorf("last state event = %+v", last)
	}
	b, _ := json.Marshal(last)
	if strings.Contains(string(b), "pin") && strings.Contains(string(b), `"pin":"`) {
		t.Errorf("state leaks the PIN: %s", b)
	}
	if err := h.rt.SetSettings(Settings{From: FromAnyone, PIN: "4242"}); err != nil {
		t.Fatal(err)
	}
	for _, e := range h.eventsNamed(EventState) {
		if b, _ := json.Marshal(e); strings.Contains(string(b), "4242") {
			t.Errorf("a state event contains the PIN: %s", b)
		}
	}
}
