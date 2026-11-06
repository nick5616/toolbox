package lan

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"toolbox/core"
)

func newSHA256() interface {
	io.Writer
	Sum([]byte) []byte
} {
	return sha256.New()
}

var errWrongDevice = errors.New("lan: certificate doesn't match the paired device")

func errOffline(alias string) *core.AppError {
	return core.Errorf(CodeOffline, "%s isn't on this network right now", alias).
		WithHint("Open Toolbox or LocalSend on it and make sure it's receiving")
}

func errEncryptionOff(alias string) *core.AppError {
	return core.Errorf(CodeEncryptionOff, "Encryption is off on %s", alias).
		WithHint("Turn on encryption in LocalSend's settings on that device")
}

func errWrong(alias string) *core.AppError {
	return core.Errorf(CodeWrongDevice, "This isn't the device you paired with").
		WithHint(fmt.Sprintf("%s may have been reset. Forget it and pair again", alias))
}

// classifyErr turns a network error into the AppError the user should see.
func classifyErr(ctx context.Context, err error, alias string) *core.AppError {
	var ae *core.AppError
	if errors.As(err, &ae) {
		return ae
	}
	switch {
	case errors.Is(err, errWrongDevice):
		return errWrong(alias)
	case ctx != nil && errors.Is(ctx.Err(), context.Canceled), errors.Is(err, context.Canceled):
		return core.Errorf(core.CodeCancelled, "Cancelled")
	}
	msg := err.Error()
	if strings.Contains(msg, "first record does not look like a TLS handshake") || strings.Contains(msg, "server gave HTTP response") {
		return errEncryptionOff(alias)
	}
	return errOffline(alias).WithCause(err)
}

// transport builds an HTTPS transport that presents our certificate and, when
// pin is set, accepts only a server whose leaf fingerprint equals it.
func (r *Runtime) transport(pin string, dialTimeout time.Duration) *http.Transport {
	pin = normFP(pin)
	cfg := &tls.Config{
		InsecureSkipVerify: true, // identity is the pinned fingerprint, checked below
		MinVersion:         tls.VersionTLS12,
		Certificates:       []tls.Certificate{r.id.Cert},
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if pin == "" {
				return nil
			}
			if len(raw) == 0 || Fingerprint(raw[0]) != pin {
				return errWrongDevice
			}
			return nil
		},
	}
	return &http.Transport{
		DialContext:         (&net.Dialer{Timeout: dialTimeout}).DialContext,
		TLSClientConfig:     cfg,
		TLSHandshakeTimeout: 5 * time.Second,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
		DisableKeepAlives:   false,
	}
}

func baseURL(host string, port int) string {
	if port <= 0 {
		port = DefaultPort
	}
	return "https://" + net.JoinHostPort(host, strconv.Itoa(port))
}

// registerWith POSTs our info to a peer's /register and returns its info and
// the fingerprint of the certificate it presented.
func (r *Runtime) registerWith(ctx context.Context, host string, port int, pin string, timeout time.Duration) (Info, string, error) {
	tr := r.transport(pin, timeout)
	defer tr.CloseIdleConnections()
	tr.DisableKeepAlives = true
	body, _ := json.Marshal(r.selfInfo(false))
	rctx, cancel := context.WithTimeout(ctx, timeout+2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, baseURL(host, port)+APIBase+"/register", bytes.NewReader(body))
	if err != nil {
		return Info{}, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return Info{}, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return Info{}, "", fmt.Errorf("register answered %d", resp.StatusCode)
	}
	var info Info
	if err := json.NewDecoder(io.LimitReader(resp.Body, MaxJSONBytes)).Decode(&info); err != nil {
		return Info{}, "", fmt.Errorf("decoding register reply: %w", err)
	}
	certFP := ""
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		certFP = Fingerprint(resp.TLS.PeerCertificates[0].Raw)
	}
	return info, certFP, nil
}

// Client is the sending side, used by send jobs.
type Client struct{ r *Runtime }

// Client returns the sending side of the runtime.
func (r *Runtime) Client() *Client { return &Client{r: r} }

// Send sends files and/or a text to a device (see Runtime.Send).
func (c *Client) Send(ctx context.Context, req SendRequest, progress func(SendProgress)) (SendResult, error) {
	return c.r.Send(ctx, req, progress)
}

// Probe checks a device is reachable.
func (c *Client) Probe(ctx context.Context, fp string) (Device, error) { return c.r.Probe(ctx, fp) }

// ---- pairing (client side) ----

// PairCodeWith is the code that will be shown on both screens when pairing with fp.
func (r *Runtime) PairCodeWith(fp string) string { return PairCode(r.id.Fingerprint, fp) }

// Pair pairs with a nearby Toolbox device; it blocks until the other side answers (≤ PairTimeout) and returns the pair code.
func (r *Runtime) Pair(ctx context.Context, fp string) (string, error) {
	dev, ok := r.Device(fp)
	if !ok {
		return "", core.Errorf(core.CodeNotFound, "That device isn't nearby any more").WithHint("Refresh the list and try again")
	}
	if !dev.Toolbox {
		return "", core.Errorf(core.CodeValidation, "%s can't be paired", dev.Alias).
			WithHint("Only Toolbox devices pair. LocalSend devices ask every time")
	}
	if dev.Protocol == "http" {
		return "", errEncryptionOff(dev.Alias)
	}
	ctx, cancel := r.mergeCtx(ctx)
	defer cancel()
	ctx, cancel2 := context.WithTimeout(ctx, PairTimeout)
	defer cancel2()
	tr := r.transport(dev.Fingerprint, 3*time.Second)
	defer tr.CloseIdleConnections()
	self := r.selfInfo(false)
	body, _ := json.Marshal(pairRequest{Alias: r.alias(), Port: self.Port})
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL(dev.Address, dev.Port)+PairPath, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	hreq.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Transport: tr}).Do(hreq)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", core.Errorf(CodeDeclined, "%s didn't answer", dev.Alias).WithHint("Ask them to accept the pairing on their screen")
		}
		return "", classifyErr(ctx, err, dev.Alias)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusConflict:
		return "", core.Errorf(CodeBusy, "%s is busy with something else", dev.Alias).WithHint("Try again in a moment")
	case http.StatusForbidden:
		return "", core.Errorf(CodeDeclined, "%s didn't accept the pairing", dev.Alias).
			WithHint("Make sure receiving is on there and accept the request")
	default:
		return "", core.Errorf(core.CodeInternal, "Pairing with %s failed", dev.Alias).WithCause(fmt.Errorf("status %d", resp.StatusCode))
	}
	r.mu.Lock()
	d := r.devs[dev.Fingerprint]
	if d == nil {
		c := dev
		d = &c
		r.devs[dev.Fingerprint] = d
	}
	d.Paired, d.Toolbox = true, true
	d.LastSeen = r.now().UnixMilli()
	r.storeLocked(d)
	r.saveDevicesLocked()
	r.mu.Unlock()
	r.emitDevicesIfChanged()
	return PairCode(r.id.Fingerprint, dev.Fingerprint), nil
}

// ---- sending ----

// sendItem is one thing in an upload batch.
type sendItem struct {
	id      string
	name    string
	mime    string
	size    int64
	preview *string
	modMS   int64
	open    func() (io.ReadCloser, error)
}

type sender struct {
	r        *Runtime
	dev      Device
	tr       *http.Transport
	hc       *http.Client
	base     string
	pin      string
	progress func(SendProgress)

	pmu      sync.Mutex
	lastRep  time.Time
	doneB    atomic.Int64
	totalB   int64
	fileDone atomic.Int64
	fileCnt  int
	lastMove atomic.Int64 // unix nanos of the last byte moved
}

func (s *sender) report(stage string, force bool) {
	if s.progress == nil {
		return
	}
	s.pmu.Lock()
	defer s.pmu.Unlock()
	if !force && time.Since(s.lastRep) < 100*time.Millisecond {
		return
	}
	s.lastRep = time.Now()
	s.progress(SendProgress{Stage: stage, Done: s.doneB.Load(), Total: s.totalB, FileIndex: int(s.fileDone.Load()), FileCount: s.fileCnt})
}

// Send sends files and/or a text to a device. It pins the device's
// certificate, waits for the receiver to accept, uploads ≤ 3 files at once,
// and on ctx cancel tells the receiver (POST /cancel). The device is stored
// ("sent to") on success.
func (r *Runtime) Send(ctx context.Context, req SendRequest, progress func(SendProgress)) (SendResult, error) {
	dev := req.Device
	dev.Fingerprint = normFP(dev.Fingerprint)
	alias := dev.Alias
	if alias == "" {
		alias = "That device"
	}
	if dev.Protocol == "http" {
		return SendResult{}, errEncryptionOff(alias)
	}
	if dev.Address == "" || dev.Fingerprint == "" {
		return SendResult{}, errOffline(alias)
	}
	text := strings.TrimSpace(req.Text)
	if len(req.Files) == 0 && text == "" {
		return SendResult{}, core.ValidationError("Choose something to send", map[string]string{"files": "Add files or write a message"})
	}
	if len(req.Text) > MaxTextBytes {
		return SendResult{}, core.ValidationError("That message is too long", map[string]string{"text": "Use 64 KiB or less"})
	}
	if len(req.PIN) > MaxPINLen {
		return SendResult{}, core.ValidationError("That PIN is too long", map[string]string{"pin": "Use 32 characters or fewer"})
	}
	ctx, cancelCtx := r.mergeCtx(ctx)
	defer cancelCtx()

	tr := r.transport(dev.Fingerprint, 3*time.Second)
	defer tr.CloseIdleConnections()
	s := &sender{r: r, dev: dev, tr: tr, hc: &http.Client{Transport: tr}, base: baseURL(dev.Address, dev.Port) + APIBase, pin: req.PIN, progress: progress}
	s.lastMove.Store(time.Now().UnixNano())

	var res SendResult
	s.report("connecting", true)
	if text != "" {
		p := text
		items := []sendItem{{
			id: "text", name: "message.txt", mime: "text/plain", size: int64(len(text)), preview: &p, modMS: r.now().UnixMilli(),
			open: func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(text)), nil },
		}}
		asMsg, err := s.sendBatch(ctx, items, false)
		if err != nil {
			return SendResult{}, err
		}
		res.AsMessage = asMsg
	}
	if len(req.Files) > 0 {
		items := make([]sendItem, 0, len(req.Files))
		for i, f := range req.Files {
			f := f
			mime := f.Type
			if mime == "" {
				mime = "application/octet-stream"
			}
			var mod int64
			if fi, err := os.Stat(f.Path); err == nil {
				mod = fi.ModTime().UnixMilli()
			}
			items = append(items, sendItem{
				id: "f" + strconv.Itoa(i), name: f.RelPath, mime: mime, size: f.Size, modMS: mod,
				open: func() (io.ReadCloser, error) {
					fh, err := os.Open(f.Path)
					if err != nil {
						return nil, fmt.Errorf("opening %s: %w", f.RelPath, err)
					}
					if fi, err := fh.Stat(); err == nil && fi.Size() != f.Size {
						fh.Close()
						return nil, core.Errorf(core.CodeValidation, "%s changed while sending", f.RelPath)
					}
					return fh, nil
				},
			})
		}
		var total int64
		for _, it := range items {
			total += it.size
		}
		s.totalB, s.fileCnt = total, len(items)
		asMsg, err := s.sendBatch(ctx, items, true)
		if err != nil {
			return SendResult{}, err
		}
		if asMsg {
			res.AsMessage = true
		} else {
			res.Files = len(items)
			res.Bytes = total
		}
	}
	if res.AsMessage && len(req.Files) == 0 {
		res.Files = 0
	}
	s.report("uploading", true)
	r.rememberSent(dev)
	return res, nil
}

// sendBatch prepares and uploads items. The result says whether the receiver
// handled the batch as a message (204).
func (s *sender) sendBatch(ctx context.Context, items []sendItem, track bool) (bool, error) {
	alias := s.dev.Alias
	pr := prepareRequest{Info: s.r.selfInfo(false), Files: map[string]wireFile{}}
	for _, it := range items {
		wf := wireFile{ID: it.id, FileName: it.name, Size: it.size, FileType: it.mime, Preview: it.preview}
		if it.modMS > 0 {
			wf.Metadata = &wireMeta{Modified: formatISO(it.modMS)}
		}
		pr.Files[it.id] = wf
	}
	body, err := json.Marshal(pr)
	if err != nil {
		return false, fmt.Errorf("encoding request: %w", err)
	}
	s.report("waiting", true)
	pctx, pcancel := context.WithTimeout(ctx, prepareTimeout)
	defer pcancel()
	u := s.base + "/prepare-upload"
	if s.pin != "" {
		u += "?pin=" + url.QueryEscape(s.pin)
	}
	hreq, err := http.NewRequestWithContext(pctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	resp, err := s.hc.Do(hreq)
	if err != nil {
		if ctx.Err() != nil {
			return false, core.Errorf(core.CodeCancelled, "Cancelled")
		}
		if errors.Is(pctx.Err(), context.DeadlineExceeded) {
			return false, core.Errorf(CodeDeclined, "%s didn't answer", alias).WithHint("Ask them to accept on their screen")
		}
		return false, classifyErr(ctx, err, alias)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, MaxJSONBytes))
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNoContent:
		return true, nil
	case http.StatusUnauthorized:
		ae := core.Errorf(CodePinRequired, "%s needs a PIN", alias).WithHint("Enter the PIN shown in its settings")
		ae.Fields = map[string]string{"pin": "Enter the PIN"}
		if s.pin != "" {
			ae.Message = "That PIN isn't right"
		}
		return false, ae
	case http.StatusForbidden:
		var eb errorBody
		_ = json.Unmarshal(raw, &eb)
		if eb.Error == reasonSpace {
			return false, core.Errorf(CodeTooLarge, "%s doesn't have enough free space", alias).WithHint("Free up space there and try again")
		}
		return false, core.Errorf(CodeDeclined, "%s declined", alias).WithHint("They may have turned the request down, or only accept from paired devices")
	case http.StatusConflict:
		return false, core.Errorf(CodeBusy, "%s is busy with another transfer", alias).WithHint("Try again in a moment")
	case http.StatusTooManyRequests:
		return false, core.Errorf(CodeBusy, "%s has had too many requests", alias).WithHint("Wait a minute and try again")
	case http.StatusBadRequest:
		return false, core.Errorf(core.CodeInternal, "%s couldn't use that request", alias).WithHint("Check file names and the number of files")
	default:
		return false, core.Errorf(core.CodeInternal, "%s answered with an error (%d)", alias, resp.StatusCode)
	}
	var pres prepareResponse
	if err := json.Unmarshal(raw, &pres); err != nil || pres.SessionID == "" {
		return false, core.Errorf(core.CodeInternal, "%s sent an answer Toolbox can't read", alias)
	}
	for _, it := range items {
		if pres.Files[it.id] == "" {
			return false, core.Errorf(core.CodeInternal, "%s didn't accept every file", alias)
		}
	}

	uctx, ucancel := context.WithCancel(ctx)
	defer ucancel()
	s.lastMove.Store(time.Now().UnixNano())
	var stalled atomic.Bool
	wdDone := make(chan struct{})
	var wdWG sync.WaitGroup
	wdWG.Add(1)
	go func() { // no byte moved for uploadIdle: the transfer is stuck
		defer wdWG.Done()
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-wdDone:
				return
			case <-uctx.Done():
				return
			case <-t.C:
				if time.Since(time.Unix(0, s.lastMove.Load())) > uploadIdle {
					stalled.Store(true)
					ucancel()
					return
				}
			}
		}
	}()

	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup
	var errMu sync.Mutex
	var firstErr error
	fail := func(err error) {
		errMu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		errMu.Unlock()
		ucancel()
	}
dispatch:
	for _, it := range items {
		select {
		case sem <- struct{}{}:
		case <-uctx.Done():
			break dispatch
		}
		wg.Add(1)
		go func(it sendItem) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := s.uploadWithRetry(uctx, pres, it, track); err != nil {
				fail(err)
			}
		}(it)
	}
	wg.Wait()
	close(wdDone)
	wdWG.Wait()

	errMu.Lock()
	err = firstErr
	errMu.Unlock()
	if err == nil && ctx.Err() == nil && !stalled.Load() && uctx.Err() == nil {
		return false, nil
	}
	// Tell the receiver we are done with this session.
	s.cancelSession(pres.SessionID)
	switch {
	case ctx.Err() != nil:
		return false, core.Errorf(core.CodeCancelled, "Cancelled")
	case stalled.Load():
		return false, core.Errorf(CodeOffline, "%s stopped responding", alias).WithHint("Check that both computers are still on the network")
	case err != nil:
		return false, classifyUpload(err, alias)
	}
	return false, core.Errorf(core.CodeInternal, "Sending to %s was interrupted", alias)
}

func classifyUpload(err error, alias string) error {
	var ae *core.AppError
	if errors.As(err, &ae) {
		return ae
	}
	if errors.Is(err, errWrongDevice) {
		return errWrong(alias)
	}
	return core.Errorf(core.CodeInternal, "Sending to %s failed", alias).WithCause(err)
}

func (s *sender) cancelSession(sid string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+"/cancel?sessionId="+url.QueryEscape(sid), nil)
	if err != nil {
		return
	}
	if resp, err := s.hc.Do(req); err == nil {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
	}
}

type statusError struct{ code int }

func (e statusError) Error() string { return "status " + strconv.Itoa(e.code) }

func (s *sender) uploadWithRetry(ctx context.Context, pres prepareResponse, it sendItem, track bool) error {
	alias := s.dev.Alias
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		var counted int64
		err = s.uploadOne(ctx, pres, it, track, &counted)
		var se statusError
		if err == nil {
			if track {
				s.fileDone.Add(1)
				s.report("uploading", true)
			}
			return nil
		}
		if errors.As(err, &se) && se.code == http.StatusUnprocessableEntity && attempt == 0 {
			if track {
				s.doneB.Add(-counted) // the file starts over
			}
			continue
		}
		break
	}
	var se statusError
	if errors.As(err, &se) {
		switch se.code {
		case http.StatusForbidden:
			return core.Errorf(CodeDeclined, "%s refused the upload", alias).WithHint("The transfer was cancelled on the other device")
		case http.StatusConflict:
			return core.Errorf(CodeBusy, "%s ended the transfer", alias).WithHint("It may have been cancelled there")
		case http.StatusUnprocessableEntity:
			return core.Errorf(core.CodeInternal, "%s received %s damaged", alias, it.name).WithHint("Try sending it again")
		}
		return core.Errorf(core.CodeInternal, "%s couldn't store %s (%d)", alias, it.name, se.code)
	}
	return err
}

type progressReader struct {
	r      io.Reader
	onRead func(n int)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.onRead(n)
	}
	return n, err
}

func (s *sender) uploadOne(ctx context.Context, pres prepareResponse, it sendItem, track bool, counted *int64) error {
	rc, err := it.open()
	if err != nil {
		return err
	}
	defer rc.Close()
	q := url.Values{"sessionId": {pres.SessionID}, "fileId": {it.id}, "token": {pres.Files[it.id]}}
	var body io.Reader = &progressReader{r: rc, onRead: func(n int) {
		s.lastMove.Store(time.Now().UnixNano())
		if track {
			s.doneB.Add(int64(n))
			*counted += int64(n)
			s.report("uploading", false)
		}
	}}
	var rbody io.ReadCloser = io.NopCloser(body)
	if it.size == 0 {
		rbody = http.NoBody
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+"/upload?"+q.Encode(), rbody)
	if err != nil {
		return err
	}
	req.ContentLength = it.size
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := s.hc.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			return classifyErr(ctx, err, s.dev.Alias)
		}
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	s.lastMove.Store(time.Now().UnixNano())
	if resp.StatusCode != http.StatusOK {
		return statusError{code: resp.StatusCode}
	}
	return nil
}
