package lan

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"toolbox/core"
)

// listener is one listening period: the TCP/TLS server, the multicast socket
// and their goroutines. It exists only while receiving is on.
type listener struct {
	r        *Runtime
	ctx      context.Context
	cancel   context.CancelFunc
	srv      *http.Server
	mc       PacketConn
	port     int
	wg       sync.WaitGroup // background goroutines
	hwg      sync.WaitGroup // in-flight handlers
	stopping bool           // guarded by r.mu
	sem      chan struct{}  // bounds concurrent announcement answers
}

// spawn runs fn as a tracked goroutine unless the listener is stopping.
func (l *listener) spawn(fn func()) bool {
	l.r.mu.Lock()
	if l.stopping {
		l.r.mu.Unlock()
		return false
	}
	l.wg.Add(1)
	l.r.mu.Unlock()
	go func() {
		defer l.wg.Done()
		fn()
	}()
	return true
}

func (r *Runtime) bind() (net.Listener, error) {
	host := ""
	if r.cfg.AllowLoopback {
		host = "127.0.0.1"
	}
	port := r.cfg.Port
	if port == 0 && !r.cfg.AllowLoopback {
		port = DefaultPort
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil && port != 0 {
		ln, err = net.Listen("tcp", net.JoinHostPort(host, "0"))
	}
	if err != nil {
		return nil, core.Errorf(CodePortUnavailable, "Toolbox can't open a port to receive files").
			WithHint("Close other file-sharing apps and try again").WithCause(err)
	}
	return ln, nil
}

// filterListener closes connections from addresses we never talk to, before TLS.
type filterListener struct {
	net.Listener
	allow func(netip.Addr) bool
}

func (f *filterListener) Accept() (net.Conn, error) {
	for {
		c, err := f.Listener.Accept()
		if err != nil {
			return nil, err
		}
		ip, ok := hostOf(c.RemoteAddr().String())
		if !ok || !f.allow(ip) {
			c.Close()
			continue
		}
		_ = c.SetDeadline(time.Now().Add(15 * time.Second)) // the handshake; net/http replaces it per request
		return c, nil
	}
}

// startListenerLocked binds and starts serving (r.lifeMu held).
func (r *Runtime) startListenerLocked() error {
	ln, err := r.bind()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(r.rootCtx)
	l := &listener{r: r, ctx: ctx, cancel: cancel, port: ln.Addr().(*net.TCPAddr).Port, sem: make(chan struct{}, 8)}
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{r.id.Cert},
		ClientAuth:   tls.RequestClientCert,
		MinVersion:   tls.VersionTLS12,
		NextProtos:   []string{"http/1.1"},
	}
	fl := &filterListener{Listener: ln, allow: func(a netip.Addr) bool { return AllowedAddr(a, r.cfg.AllowLoopback) }}
	l.srv = &http.Server{
		Handler:           l,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	tln := tls.NewListener(fl, tlsCfg)
	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		_ = l.srv.Serve(tln)
	}()

	r.mu.Lock()
	r.lis = l
	r.lastErr = ""
	r.mu.Unlock()

	if mc, err := r.openPacket(true); err == nil {
		l.mc = mc
		l.wg.Add(2)
		go func() { defer l.wg.Done(); l.readLoop() }()
		go func() { defer l.wg.Done(); l.announceLoop() }()
	} else {
		r.mu.Lock()
		r.lastErr = "Other devices can't find this computer automatically (" + err.Error() + "). You can still add it by address."
		r.mu.Unlock()
	}
	return nil
}

func (r *Runtime) openPacket(listen bool) (PacketConn, error) {
	if r.cfg.Packet != nil {
		return r.cfg.Packet(listen)
	}
	return realPacket(listen)
}

// stopListenerLocked tears the listener down and waits for every goroutine (r.lifeMu held).
func (r *Runtime) stopListenerLocked() {
	r.mu.Lock()
	l := r.lis
	if l == nil {
		r.mu.Unlock()
		return
	}
	l.stopping = true
	sess := r.session
	r.lis = nil
	r.mu.Unlock()

	l.cancel()
	if sess != nil {
		sess.Cancel()
	}
	_ = l.srv.Close()
	if l.mc != nil {
		_ = l.mc.Close()
	}
	l.hwg.Wait()
	l.wg.Wait()
	r.mu.Lock()
	r.lastErr = ""
	r.mu.Unlock()
	r.emitState()
}

// ---- HTTP routing ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeStatus(w http.ResponseWriter, status int) {
	w.WriteHeader(status)
}

func writeRefusal(w http.ResponseWriter, status int, reason, msg string) {
	writeJSON(w, status, errorBody{Error: reason, Message: msg})
}

// peerFP is the fingerprint of the client certificate the peer presented ("" = none).
func peerFP(req *http.Request) string {
	if req.TLS == nil || len(req.TLS.PeerCertificates) == 0 {
		return ""
	}
	return Fingerprint(req.TLS.PeerCertificates[0].Raw)
}

func (r *Runtime) clientIP(req *http.Request) string {
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		host = req.RemoteAddr
	}
	if a, ok := hostOf(host); ok {
		host = a.String()
	}
	if r.ipHook != nil {
		return r.ipHook(host, req.Header.Get("X-Test-IP"))
	}
	return host
}

func (l *listener) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r := l.r
	r.mu.Lock()
	if l.stopping {
		r.mu.Unlock()
		writeStatus(w, http.StatusServiceUnavailable)
		return
	}
	l.hwg.Add(1)
	r.mu.Unlock()
	defer l.hwg.Done()

	ip := r.clientIP(req)
	if !r.allow(ip) {
		writeStatus(w, http.StatusTooManyRequests)
		return
	}
	path := req.URL.Path
	post := req.Method == http.MethodPost
	switch {
	case post && path == APIBase+"/register":
		l.handleRegister(w, req, ip)
	case req.Method == http.MethodGet && path == APIBase+"/info":
		writeJSON(w, http.StatusOK, r.selfInfo(false))
	case post && path == APIBase+"/prepare-upload":
		l.handlePrepare(w, req, ip)
	case post && path == APIBase+"/upload":
		l.handleUpload(w, req, ip)
	case post && path == APIBase+"/cancel":
		l.handleCancel(w, req, ip)
	case post && path == PairPath:
		l.handlePair(w, req, ip)
	default:
		writeStatus(w, http.StatusNotFound)
	}
}

func decodeBody(w http.ResponseWriter, req *http.Request, v any) bool {
	req.Body = http.MaxBytesReader(w, req.Body, MaxJSONBytes)
	if err := json.NewDecoder(req.Body).Decode(v); err != nil {
		writeStatus(w, http.StatusBadRequest)
		return false
	}
	return true
}

func (l *listener) handleRegister(w http.ResponseWriter, req *http.Request, ip string) {
	var in Info
	if !decodeBody(w, req, &in) {
		return
	}
	fp := normFP(in.Fingerprint)
	vfp := peerFP(req)
	if vfp != "" {
		fp = vfp
	}
	if fp == "" {
		writeStatus(w, http.StatusBadRequest)
		return
	}
	if fp != l.r.id.Fingerprint {
		l.r.noteDevice(in, fp, ip, vfp != "")
	}
	writeJSON(w, http.StatusOK, l.r.selfInfo(false))
}

// ---- prepare-upload ----

func buildFiles(in prepareRequest) ([]FileMeta, int64, error) {
	if len(in.Files) == 0 {
		return nil, 0, errors.New("no files")
	}
	if len(in.Files) > MaxFilesPerSess {
		return nil, 0, errors.New("too many files")
	}
	keys := make([]string, 0, len(in.Files))
	for k := range in.Files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var total int64
	out := make([]FileMeta, 0, len(keys))
	for _, k := range keys {
		f := in.Files[k]
		id := f.ID
		if id == "" {
			id = k
		}
		if id == "" || f.Size < 0 || f.FileName == "" {
			return nil, 0, errors.New("bad file entry")
		}
		for _, c := range strings.Split(strings.ReplaceAll(f.FileName, "\\", "/"), "/") {
			if len(c) > MaxNameBytes {
				return nil, 0, errors.New("name too long")
			}
		}
		rel, err := SanitizePath(f.FileName)
		if err != nil {
			return nil, 0, err
		}
		sha := ""
		if f.SHA256 != nil && *f.SHA256 != "" {
			sha = strings.ToLower(*f.SHA256)
			if len(sha) != 64 || strings.Trim(sha, "0123456789abcdef") != "" {
				return nil, 0, errors.New("bad sha256")
			}
		}
		var mod int64
		if f.Metadata != nil {
			mod = parseISO(f.Metadata.Modified)
		}
		if total+f.Size < total {
			return nil, 0, errors.New("size overflow")
		}
		total += f.Size
		ft := f.FileType
		if ft == "" {
			ft = "application/octet-stream"
		}
		out = append(out, FileMeta{ID: id, RelPath: rel, Size: f.Size, Type: ft, SHA256: sha, Modified: mod})
	}
	seen := map[string]bool{}
	for _, m := range out {
		if seen[m.ID] {
			return nil, 0, errors.New("duplicate file id")
		}
		seen[m.ID] = true
	}
	return out, total, nil
}

func promptFiles(metas []FileMeta) []PromptFile {
	n := min(len(metas), 20)
	out := make([]PromptFile, 0, n)
	for _, m := range metas[:n] {
		out = append(out, PromptFile{Name: m.RelPath, Size: m.Size, Type: m.Type})
	}
	return out
}

// reserve claims the single prompt/session slot.
func (r *Runtime) reserve() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.busy {
		return false
	}
	r.busy = true
	return true
}

func (r *Runtime) unreserve() {
	r.mu.Lock()
	r.busy = false
	r.mu.Unlock()
}

// freeSpaceOK checks there is room for total bytes plus the margin; the
// second result is the number of bytes that were needed.
func (r *Runtime) freeSpaceOK(total int64) (bool, int64) {
	if r.cfg.FreeSpace == nil || r.cfg.ReceiveDir == nil {
		return true, 0
	}
	need := total + FreeSpaceMargin
	dir := r.cfg.ReceiveDir()
	for dir != "" {
		free, err := r.cfg.FreeSpace(dir)
		if err == nil {
			return free >= uint64(need), need
		}
		parent := parentDir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return true, 0
}

func parentDir(p string) string {
	p = strings.TrimRight(p, `/\`)
	i := strings.LastIndexAny(p, `/\`)
	if i <= 0 {
		return p
	}
	return p[:i]
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < 4; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTP"[exp])
}

func (l *listener) handlePrepare(w http.ResponseWriter, req *http.Request, ip string) {
	r := l.r
	if !r.allowPrepare(ip) {
		writeStatus(w, http.StatusTooManyRequests)
		return
	}
	var in prepareRequest
	if !decodeBody(w, req, &in) {
		return
	}
	metas, total, err := buildFiles(in)
	if err != nil {
		writeStatus(w, http.StatusBadRequest)
		return
	}

	// Who is this? A presented client certificate makes the sender verified,
	// and then its fingerprint is the certificate's, not the claimed one.
	vfp := peerFP(req)
	verified := vfp != ""
	r.mu.Lock()
	settings := r.settings
	var stored *Device
	if verified {
		if d := r.devs[vfp]; d != nil {
			c := *d
			stored = &c
		}
	}
	r.mu.Unlock()
	trusted := verified && stored != nil && stored.Paired
	autoAccept := trusted && stored.AutoAccept && stored.Toolbox
	var from Device
	if stored != nil {
		from = *stored
		from.Address = ip
	} else {
		fp := normFP(in.Info.Fingerprint)
		if verified {
			fp = vfp
		}
		from = Device{
			Fingerprint: fp, Alias: cleanAlias(in.Info.Alias), DeviceType: strings.TrimSpace(in.Info.DeviceType),
			DeviceModel: strings.TrimSpace(in.Info.DeviceModel), Address: ip, Port: in.Info.Port, Protocol: "https",
			LastSeen: r.now().UnixMilli(),
		}
	}

	// 4. Only my devices.
	if settings.From == FromMine && !trusted {
		r.AddActivity(fmt.Sprintf("Turned away a transfer from %s (not one of your devices)", from.Alias))
		writeStatus(w, http.StatusForbidden)
		return
	}
	// 5. PIN.
	if settings.PIN != "" && !trusted {
		r.mu.Lock()
		st := r.ipStateLocked(ip)
		locked := r.now().Before(st.lockedUntil)
		r.mu.Unlock()
		if locked {
			writeStatus(w, http.StatusForbidden)
			return
		}
		pin := req.URL.Query().Get("pin")
		if pin == "" {
			writeStatus(w, http.StatusUnauthorized)
			return
		}
		if subtle.ConstantTimeCompare([]byte(pin), []byte(settings.PIN)) != 1 {
			r.mu.Lock()
			st := r.ipStateLocked(ip)
			st.pinFails++
			if st.pinFails >= maxPINFails {
				st.lockedUntil = r.now().Add(pinLockout)
				st.pinFails = 0
			}
			r.mu.Unlock()
			writeStatus(w, http.StatusUnauthorized)
			return
		}
		r.mu.Lock()
		r.ipStateLocked(ip).pinFails = 0
		r.mu.Unlock()
	}
	// 6. Space.
	if ok, need := r.freeSpaceOK(total); !ok {
		r.AddActivity(fmt.Sprintf("Turned away a transfer from %s: it needs %s free", from.Alias, humanBytes(need)))
		writeRefusal(w, http.StatusForbidden, reasonSpace, "Not enough free space")
		return
	}

	textOnly := isTextOnly(in.Files)
	immediate := textOnly && autoAccept
	reserved := false
	if !immediate {
		if !r.reserve() {
			writeStatus(w, http.StatusConflict)
			return
		}
		reserved = true
	}
	defer func() {
		if reserved {
			r.unreserve()
		}
	}()

	// 7. Text only.
	if textOnly {
		var parts []string
		keys := make([]string, 0, len(in.Files))
		for k := range in.Files {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			parts = append(parts, *in.Files[k].Preview)
		}
		text := strings.Join(parts, "\n")
		if !autoAccept {
			acc, _, ok := r.ask(l, req.Context(), Prompt{Kind: PromptMessage, Device: from, Verified: verified, Text: text})
			if !ok {
				return
			}
			if !acc {
				writeStatus(w, http.StatusForbidden)
				return
			}
		}
		r.addMessage(from, text)
		writeStatus(w, http.StatusNoContent)
		return
	}

	// 8/9. Auto-accept or ask.
	if !autoAccept {
		acc, always, ok := r.ask(l, req.Context(), Prompt{
			Kind: PromptTransfer, Device: from, Verified: verified, Files: promptFiles(metas),
			FileCount: len(metas), TotalBytes: total, CanAlways: trusted && stored.Toolbox && !stored.AutoAccept,
		})
		if !ok {
			return
		}
		if !acc {
			writeStatus(w, http.StatusForbidden)
			return
		}
		if always && trusted {
			_ = r.SetAutoAccept(vfp, true)
		}
	}

	// 10. Accepted.
	r.mu.Lock()
	sink := r.sink
	r.mu.Unlock()
	if sink == nil {
		writeStatus(w, http.StatusInternalServerError)
		return
	}
	s := newSession(r, l, from, verified, ip, metas, total)
	r.mu.Lock()
	r.session = s
	r.mu.Unlock()
	reserved = false // the session owns the slot until it is released
	if err := sink.Accepted(s); err != nil {
		s.cancelWith(err)
		writeStatus(w, http.StatusInternalServerError)
		return
	}
	resp := prepareResponse{SessionID: s.id, Files: make(map[string]string, len(metas))}
	for _, m := range metas {
		resp.Files[m.ID] = s.files[m.ID].token
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---- prompts ----

type promptAnswer struct{ accept, always bool }

type promptEntry struct {
	prompt Prompt
	ch     chan promptAnswer
}

// ask shows a prompt and waits for the answer, the timeout, the sender
// hanging up, or the listener stopping. ok is false when the sender went away
// (nothing to reply to).
func (r *Runtime) ask(l *listener, reqCtx context.Context, p Prompt) (accept, always, ok bool) {
	p.ID = randHex(8)
	p.ExpiresAt = r.now().Add(promptTimeout).UnixMilli()
	if p.Files == nil {
		p.Files = []PromptFile{}
	}
	e := &promptEntry{prompt: p, ch: make(chan promptAnswer, 1)}
	r.mu.Lock()
	r.prompts[p.ID] = e
	r.mu.Unlock()
	r.emit(EventPrompt, p)

	timer := time.NewTimer(promptTimeout)
	defer timer.Stop()
	reason := "cancelled"
	ok = true
	select {
	case a := <-e.ch:
		accept, always = a.accept, a.always
		reason = "declined"
		if accept {
			reason = "accepted"
		}
	case <-timer.C:
		reason = "timeout"
	case <-reqCtx.Done():
		ok = false
	case <-l.ctx.Done():
		ok = false
	}
	r.mu.Lock()
	delete(r.prompts, p.ID)
	r.mu.Unlock()
	r.emit(EventPromptClose, PromptClosed{ID: p.ID, Reason: reason})
	return accept, always, ok
}

// Respond answers a prompt.
func (r *Runtime) Respond(promptID string, accept, always bool) error {
	r.mu.Lock()
	e := r.prompts[promptID]
	r.mu.Unlock()
	if e == nil {
		return core.Errorf(core.CodeNotFound, "That request has already been answered")
	}
	select {
	case e.ch <- promptAnswer{accept: accept, always: always && accept && e.prompt.CanAlways}:
	default:
	}
	return nil
}

// ---- pairing (server side) ----

func (l *listener) handlePair(w http.ResponseWriter, req *http.Request, ip string) {
	r := l.r
	vfp := peerFP(req)
	if vfp == "" || vfp == r.id.Fingerprint {
		writeStatus(w, http.StatusForbidden)
		return
	}
	var in pairRequest
	if !decodeBody(w, req, &in) {
		return
	}
	alias := cleanAlias(in.Alias)
	port := in.Port
	if port <= 0 || port > 65535 {
		port = DefaultPort
	}
	if !r.reserve() {
		writeStatus(w, http.StatusConflict)
		return
	}
	defer r.unreserve()
	dev := Device{
		Fingerprint: vfp, Alias: alias, DeviceType: "desktop", DeviceModel: DeviceModel, Toolbox: true,
		Address: ip, Port: port, Protocol: "https", LastSeen: r.now().UnixMilli(),
	}
	acc, _, ok := r.ask(l, req.Context(), Prompt{
		Kind: PromptPair, Device: dev, Verified: true, PairCode: PairCode(r.id.Fingerprint, vfp),
	})
	if !ok {
		return
	}
	if !acc {
		writeStatus(w, http.StatusForbidden)
		return
	}
	r.mu.Lock()
	d := r.devs[vfp]
	if d == nil {
		c := dev
		d = &c
		r.devs[vfp] = d
	} else {
		keep := d.AutoAccept
		*d = dev
		d.AutoAccept = keep
	}
	d.Paired, d.Toolbox = true, true
	r.storeLocked(d)
	r.saveDevicesLocked()
	r.mu.Unlock()
	r.emitDevicesIfChanged()
	writeJSON(w, http.StatusOK, pairResponse{Alias: r.alias()})
}

// ---- sessions ----

var (
	// ErrSessionCancelled is what a session's Next returns after Cancel (by the sender or locally).
	ErrSessionCancelled = errors.New("lan: transfer cancelled")
	errSessionTimeout   = errors.New("lan: the sender stopped sending")
	errIncomplete       = errors.New("lan: not every file arrived")
	errAborted          = errors.New("lan: upload interrupted")
	errNotRead          = errors.New("lan: file was not read to its end")
	// ErrMismatch is wrapped by body errors when the bytes don't match what was announced (size or sha256).
	ErrMismatch = errors.New("lan: upload doesn't match what was announced")
	errShort    = fmt.Errorf("%w: file is shorter than announced", ErrMismatch)
	errSize     = fmt.Errorf("%w: file is longer than announced", ErrMismatch)
	errHash     = fmt.Errorf("%w: checksum differs", ErrMismatch)
)

const (
	fileIdle = iota
	fileActive
	fileDone
)

type fileState struct {
	meta  FileMeta
	token string
	state int
	up    *upload
}

type session struct {
	r        *Runtime
	l        *listener
	id       string
	from     Device
	verified bool
	ip       string
	metas    []FileMeta
	total    int64
	files    map[string]*fileState

	arrive    chan *upload
	cancelled chan struct{}

	mu        sync.Mutex
	completed int
	cancelErr error
	changed   chan struct{}
	last      time.Time
	released  bool
}

func newSession(r *Runtime, l *listener, from Device, verified bool, ip string, metas []FileMeta, total int64) *session {
	s := &session{
		r: r, l: l, id: randHex(16), from: from, verified: verified, ip: ip, metas: metas, total: total,
		files:     make(map[string]*fileState, len(metas)),
		arrive:    make(chan *upload, len(metas)*2+2),
		cancelled: make(chan struct{}),
		changed:   make(chan struct{}),
		last:      r.now(),
	}
	for _, m := range metas {
		s.files[m.ID] = &fileState{meta: m, token: randHex(16)}
	}
	return s
}

func (s *session) ID() string        { return s.id }
func (s *session) From() Device      { return s.from }
func (s *session) Verified() bool    { return s.verified }
func (s *session) Files() []FileMeta { return append([]FileMeta(nil), s.metas...) }
func (s *session) TotalBytes() int64 { return s.total }
func (s *session) touch()            { s.mu.Lock(); s.last = s.r.now(); s.mu.Unlock() }
func (s *session) lastActivity() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}

// broadcastLocked wakes everything waiting in Next.
func (s *session) broadcastLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// Next waits for the next uploaded file; io.EOF once every file arrived.
func (s *session) Next(ctx context.Context) (FileStream, error) {
	for {
		s.mu.Lock()
		if s.cancelErr != nil {
			err := s.cancelErr
			s.mu.Unlock()
			return FileStream{}, err
		}
		if s.completed >= len(s.metas) {
			s.mu.Unlock()
			return FileStream{}, io.EOF
		}
		ch := s.changed
		s.mu.Unlock()
		select {
		case up := <-s.arrive:
			if up.isFinished() {
				continue
			}
			s.touch()
			return FileStream{File: up.fs.meta, Body: up, Done: up.complete}, nil
		case <-ch:
		case <-s.cancelled:
		case <-ctx.Done():
			return FileStream{}, ctx.Err()
		}
	}
}

// Cancel ends the session (the sender's next request fails).
func (s *session) Cancel() { s.cancelWith(ErrSessionCancelled) }

func (s *session) cancelWith(err error) {
	if err == nil {
		err = ErrSessionCancelled
	}
	s.mu.Lock()
	if s.cancelErr != nil {
		s.mu.Unlock()
		s.release()
		return
	}
	s.cancelErr = err
	close(s.cancelled)
	var ups []*upload
	for _, f := range s.files {
		if f.up != nil {
			ups = append(ups, f.up)
		}
	}
	s.broadcastLocked()
	s.mu.Unlock()
	for _, up := range ups {
		up.abort(err)
	}
	s.release()
}

// Finished releases the session after the sink is done (nil = success).
func (s *session) Finished(err error) {
	s.mu.Lock()
	complete := s.completed >= len(s.metas)
	s.mu.Unlock()
	if err != nil || !complete {
		if err == nil {
			err = errIncomplete
		}
		s.cancelWith(err)
		return
	}
	s.release()
}

// release frees the runtime's single-session slot (once).
func (s *session) release() {
	s.mu.Lock()
	if s.released {
		s.mu.Unlock()
		return
	}
	s.released = true
	s.mu.Unlock()
	r := s.r
	r.mu.Lock()
	if r.session == s {
		r.session = nil
		r.busy = false
	}
	r.mu.Unlock()
}

// ---- upload ----

type upload struct {
	s  *session
	fs *fileState
	rc *http.ResponseController
	rb io.Reader

	hash interface {
		io.Writer
		Sum([]byte) []byte
	}

	mu        sync.Mutex
	remaining int64
	err       error
	eofOK     bool
	finished  bool
	final     error
	done      chan error
}

func (up *upload) isFinished() bool {
	up.mu.Lock()
	defer up.mu.Unlock()
	return up.finished
}

// abort fails the upload (idempotent) and unblocks a pending network read.
func (up *upload) abort(err error) {
	up.mu.Lock()
	if up.err == nil {
		up.err = err
	}
	up.mu.Unlock()
	_ = up.rc.SetReadDeadline(time.Now())
}

// complete is the stream's Done: it records the outcome once.
func (up *upload) complete(err error) {
	up.mu.Lock()
	if up.finished {
		up.mu.Unlock()
		return
	}
	up.finished = true
	if err == nil && up.err != nil {
		err = up.err
	}
	if err == nil && !up.eofOK {
		err = errNotRead
	}
	if err != nil && up.err == nil {
		up.err = err
	}
	up.final = err
	up.mu.Unlock()

	s := up.s
	s.mu.Lock()
	if up.fs.up == up {
		up.fs.up = nil
	}
	if err == nil {
		up.fs.state = fileDone
		s.completed++
	} else if up.fs.state != fileDone {
		up.fs.state = fileIdle
	}
	s.last = s.r.now()
	s.broadcastLocked()
	s.mu.Unlock()
	up.done <- err
}

func (up *upload) Read(p []byte) (int, error) {
	up.mu.Lock()
	if up.err != nil {
		e := up.err
		up.mu.Unlock()
		return 0, e
	}
	if up.eofOK {
		up.mu.Unlock()
		return 0, io.EOF
	}
	rem := up.remaining
	up.mu.Unlock()
	if rem <= 0 {
		return 0, up.verify()
	}
	if int64(len(p)) > rem {
		p = p[:rem]
	}
	_ = up.rc.SetReadDeadline(time.Now().Add(uploadIdle))
	n, err := up.rb.Read(p)
	up.mu.Lock()
	up.hash.Write(p[:n])
	up.remaining -= int64(n)
	if err != nil && up.err == nil {
		switch {
		case errors.Is(err, io.EOF):
			if up.remaining > 0 {
				up.err = errShort
			}
		case errors.Is(err, io.ErrUnexpectedEOF):
			up.err = errShort
		case errors.Is(err, errAborted):
			up.err = errAborted
		default:
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				up.err = errSessionTimeout
				defer up.s.cancelWith(errSessionTimeout)
			} else {
				up.err = fmt.Errorf("reading upload: %w", err)
			}
		}
	}
	e := up.err
	up.mu.Unlock()
	up.s.touch()
	if e != nil {
		return n, e
	}
	return n, nil
}

// verify runs at the end of the declared size: nothing may follow, and the sha256 must match.
func (up *upload) verify() error {
	_ = up.rc.SetReadDeadline(time.Now().Add(uploadIdle))
	var one [1]byte
	n, err := up.rb.Read(one[:])
	up.mu.Lock()
	defer up.mu.Unlock()
	if up.err != nil {
		return up.err
	}
	switch {
	case n > 0:
		up.err = errSize
	case err != nil && !errors.Is(err, io.EOF):
		up.err = fmt.Errorf("reading upload: %w", err)
	case up.fs.meta.SHA256 != "" && fmt.Sprintf("%x", up.hash.Sum(nil)) != up.fs.meta.SHA256:
		up.err = errHash
	default:
		up.eofOK = true
		return io.EOF
	}
	return up.err
}

func (l *listener) handleUpload(w http.ResponseWriter, req *http.Request, ip string) {
	r := l.r
	q := req.URL.Query()
	sid, fid, tok := q.Get("sessionId"), q.Get("fileId"), q.Get("token")
	if sid == "" || fid == "" || tok == "" {
		writeStatus(w, http.StatusBadRequest)
		return
	}
	r.mu.Lock()
	s := r.session
	r.mu.Unlock()
	if s == nil || s.id != sid {
		writeStatus(w, http.StatusConflict)
		return
	}
	if ip != s.ip {
		writeStatus(w, http.StatusForbidden)
		return
	}
	fs := s.files[fid]
	if fs == nil || subtle.ConstantTimeCompare([]byte(tok), []byte(fs.token)) != 1 {
		writeStatus(w, http.StatusForbidden)
		return
	}
	if req.ContentLength >= 0 && req.ContentLength != fs.meta.Size {
		writeStatus(w, http.StatusUnprocessableEntity)
		return
	}
	up := &upload{s: s, fs: fs, rc: http.NewResponseController(w), rb: req.Body, hash: newSHA256(), remaining: fs.meta.Size, done: make(chan error, 1)}
	s.mu.Lock()
	if s.cancelErr != nil || fs.state != fileIdle {
		cancelled := s.cancelErr != nil
		s.mu.Unlock()
		_ = cancelled
		writeStatus(w, http.StatusConflict)
		return
	}
	fs.state = fileActive
	fs.up = up
	s.last = r.now()
	s.mu.Unlock()

	select {
	case s.arrive <- up:
	case <-s.cancelled:
		up.complete(ErrSessionCancelled)
		writeStatus(w, http.StatusConflict)
		return
	case <-req.Context().Done():
		up.abort(errAborted)
		up.complete(errAborted)
		return
	}
	select {
	case err := <-up.done:
		switch {
		case err == nil:
			writeStatus(w, http.StatusOK)
		case errors.Is(err, ErrMismatch):
			writeStatus(w, http.StatusUnprocessableEntity)
		case errors.Is(err, ErrSessionCancelled), errors.Is(err, errSessionTimeout):
			writeStatus(w, http.StatusConflict)
		default:
			writeStatus(w, http.StatusInternalServerError)
		}
	case <-s.cancelled:
		up.abort(ErrSessionCancelled)
		up.complete(ErrSessionCancelled)
		writeStatus(w, http.StatusConflict)
	case <-req.Context().Done():
		up.abort(errAborted)
		up.complete(errAborted)
	case <-l.ctx.Done():
		up.abort(errAborted)
		up.complete(errAborted)
	}
}

func (l *listener) handleCancel(w http.ResponseWriter, req *http.Request, ip string) {
	r := l.r
	sid := req.URL.Query().Get("sessionId")
	if sid == "" {
		writeStatus(w, http.StatusBadRequest)
		return
	}
	r.mu.Lock()
	s := r.session
	r.mu.Unlock()
	if s == nil || s.id != sid {
		writeStatus(w, http.StatusOK)
		return
	}
	if ip != s.ip {
		writeStatus(w, http.StatusForbidden)
		return
	}
	s.Cancel()
	writeStatus(w, http.StatusOK)
}
