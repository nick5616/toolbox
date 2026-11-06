package lan

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }

func itoa(i int) string { return strconv.Itoa(i) }

func parseLeaf(id *Identity) (*x509.Certificate, error) {
	return x509.ParseCertificate(id.Cert.Certificate[0])
}

// fakeClock is an injectable clock.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)} }
func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// fakePacket is an in-memory multicast socket.
type fakePacket struct {
	in     chan datagram
	closed chan struct{}
	once   sync.Once
	mu     sync.Mutex
	sent   []sentPacket
	listen bool
}

type sentPacket struct {
	data []byte
	to   string
}

func (f *fakePacket) ReadFrom(b []byte) (int, string, error) {
	select {
	case d := <-f.in:
		return copy(b, d.data), d.from, nil
	case <-f.closed:
		return 0, "", errors.New("closed")
	}
}

func (f *fakePacket) WriteTo(b []byte, to string) error {
	f.mu.Lock()
	f.sent = append(f.sent, sentPacket{data: append([]byte(nil), b...), to: to})
	f.mu.Unlock()
	return nil
}

func (f *fakePacket) Close() error {
	f.once.Do(func() { close(f.closed) })
	return nil
}

func (f *fakePacket) sentPackets() []sentPacket {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentPacket(nil), f.sent...)
}

type fakeNet struct {
	mu    sync.Mutex
	conns []*fakePacket
}

func (n *fakeNet) factory(listen bool) (PacketConn, error) {
	f := &fakePacket{in: make(chan datagram, 16), closed: make(chan struct{}), listen: listen}
	n.mu.Lock()
	n.conns = append(n.conns, f)
	n.mu.Unlock()
	return f, nil
}

func (n *fakeNet) listener() *fakePacket {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, c := range n.conns {
		if c.listen {
			return c
		}
	}
	return nil
}

type recorded struct {
	name string
	data any
}

// harness is one Runtime on loopback with captured events and a test sink.
type harness struct {
	t     *testing.T
	rt    *Runtime
	net   *fakeNet
	dir   string
	recv  string
	clock *fakeClock

	mu       sync.Mutex
	events   []recorded
	onPrompt func(Prompt)
	sinkErr  chan error
}

func newHarness(t *testing.T, mutate ...func(*Config)) *harness {
	t.Helper()
	h := &harness{t: t, net: &fakeNet{}, dir: t.TempDir(), recv: t.TempDir(), clock: newClock(), sinkErr: make(chan error, 8)}
	cfg := Config{
		Dir:           h.dir,
		AllowLoopback: true,
		Packet:        h.net.factory,
		Now:           h.clock.Now,
		Hostname:      func() (string, error) { return "test-host.local", nil },
		Emit:          h.emit,
		Sink:          sinkFunc(h.sink),
	}
	for _, m := range mutate {
		m(&cfg)
	}
	rt, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	h.rt = rt
	t.Cleanup(func() { rt.Close() })
	return h
}

func (h *harness) emit(name string, data any) {
	h.mu.Lock()
	h.events = append(h.events, recorded{name, data})
	cb := h.onPrompt
	h.mu.Unlock()
	if p, ok := data.(Prompt); ok && name == EventPrompt && cb != nil {
		cb(p)
	}
}

func (h *harness) eventsNamed(name string) []any {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []any
	for _, e := range h.events {
		if e.name == name {
			out = append(out, e.data)
		}
	}
	return out
}

func (h *harness) setOnPrompt(f func(Prompt)) {
	h.mu.Lock()
	h.onPrompt = f
	h.mu.Unlock()
}

// answerPrompts makes the harness answer every prompt the same way.
func (h *harness) answerPrompts(accept, always bool) {
	h.setOnPrompt(func(p Prompt) {
		if err := h.rt.Respond(p.ID, accept, always); err != nil {
			h.t.Errorf("Respond: %v", err)
		}
	})
}

type sinkFunc func(IncomingSession) error

func (f sinkFunc) Accepted(s IncomingSession) error { return f(s) }

// sink writes accepted sessions into h.recv/<alias>/<relpath> like the real receive job.
func (h *harness) sink(s IncomingSession) error {
	go func() { h.sinkErr <- drain(context.Background(), s, h.recv) }()
	return nil
}

func drain(ctx context.Context, s IncomingSession, root string) (err error) {
	defer func() { s.Finished(err) }()
	for {
		fs, nerr := s.Next(ctx)
		if errors.Is(nerr, io.EOF) {
			return nil
		}
		if nerr != nil {
			return nerr
		}
		dir := filepath.Join(root, SafeFolderName(s.From().Alias))
		rel := UniqueName(dir, fs.File.RelPath)
		dst := filepath.Join(dir, filepath.FromSlash(rel))
		werr := writeStream(fs, dst)
		fs.Done(werr)
		if werr != nil {
			// The sender may retry the file; keep waiting for it.
			continue
		}
	}
}

func writeStream(fs FileStream, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, fs.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dst)
	}
	return err
}

// listen turns receiving on and returns the bound port.
func (h *harness) listen() int {
	h.t.Helper()
	if err := h.rt.SetReceive(ReceiveAlways); err != nil {
		h.t.Fatal(err)
	}
	st := h.rt.State()
	if !st.Listening || st.Port == 0 {
		h.t.Fatalf("not listening: %+v", st)
	}
	return st.Port
}

func (h *harness) url(path string) string {
	return "https://127.0.0.1:" + itoa(h.rt.State().Port) + path
}

// httpClient is a client that talks to the harness; cert (optional) is presented as a client certificate.
func httpClient(cert *tls.Certificate) *http.Client {
	cfg := &tls.Config{InsecureSkipVerify: true}
	if cert != nil {
		cfg.Certificates = []tls.Certificate{*cert}
	}
	return &http.Client{Transport: &http.Transport{TLSClientConfig: cfg, DisableKeepAlives: true}, Timeout: 20 * time.Second}
}

func post(t *testing.T, c *http.Client, url string, body any) (int, []byte) {
	t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	case io.Reader:
		rd = b
	default:
		j, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		rd = bytes.NewReader(j)
	}
	resp, err := c.Post(url, "application/json", rd)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

type tf struct {
	name    string
	data    string
	typ     string
	sha     *string
	preview *string
}

func prepBody(alias, fp string, files ...tf) prepareRequest {
	req := prepareRequest{
		Info:  Info{Alias: alias, Version: "2.0", DeviceType: "mobile", Fingerprint: fp, Port: 53317, Protocol: "https"},
		Files: map[string]wireFile{},
	}
	for i, f := range files {
		id := fmt.Sprintf("id%d", i)
		typ := f.typ
		if typ == "" {
			typ = "application/octet-stream"
		}
		req.Files[id] = wireFile{ID: id, FileName: f.name, Size: int64(len(f.data)), FileType: typ, SHA256: f.sha, Preview: f.preview}
	}
	return req
}

func decodePrepare(t *testing.T, b []byte) prepareResponse {
	t.Helper()
	var r prepareResponse
	if err := json.Unmarshal(b, &r); err != nil || r.SessionID == "" {
		t.Fatalf("bad prepare response %q: %v", b, err)
	}
	return r
}

func uploadURL(h *harness, sid, fid, tok string) string {
	return h.url(APIBase + "/upload?sessionId=" + sid + "&fileId=" + fid + "&token=" + tok)
}

// waitFor polls cond for up to 5 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
