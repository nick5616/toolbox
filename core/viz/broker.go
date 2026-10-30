package viz

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"toolbox/core"
)

// RenderBroker hands render plans to the webview's RenderHost and receives
// the encoded stream back over raw messages (SPEC.md §7.2).
type RenderBroker struct {
	emitter core.Emitter
	urlFor  func(path string) (string, error)
	labDir  string // "" unless TOOLBOX_VIZLAB=1

	mu      sync.Mutex
	origins map[string]bool
	sem     chan struct{}
	active  map[string]*render // by token (RB1)
}

// Tunables (variables so tests can shorten them).
var (
	startTimeout = 20 * time.Second
	idleTimeout  = 30 * time.Second
	cancelWait   = 3 * time.Second
	ackEvery     = int64(4 << 20)
	maxBytes     = int64(8 << 30)
)

type renderEventKind int

const (
	evStart renderEventKind = iota
	evProgress
	evDone
	evError
	evCancelled
	evFail
)

type renderEvent struct {
	kind          renderEventKind
	frame, frames int
	bytes         int64
	err           error
	message       string
	detail        string
}

type startInfo struct {
	Encoder string `json:"encoder"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	FPS     int    `json:"fps"`
	Frames  int    `json:"frames"`
}

// render is one in-flight render.
type render struct {
	token   string
	job     *core.JobContext
	tempDir string
	plan    RenderPlan
	planned int

	events chan renderEvent // control events for the Render loop
	touch  chan struct{}    // "a message arrived" (resets the idle timer)
	done   chan struct{}    // closed when Render returns

	mu       sync.Mutex // guards the fields below and serialises handlers
	started  bool
	failed   bool
	closed   bool // writeCh closed
	nextSeq  int
	received int64
	info     startInfo
	codec    string
	file     *os.File
	writeCh  chan []byte
	writerWG chan struct{} // closed when the writer goroutine exits

	written  atomic.Int64
	writeErr atomic.Pointer[error]
}

// push delivers a control event unless the render is already over.
func (r *render) push(ev renderEvent) {
	select {
	case r.events <- ev:
	case <-r.done:
	}
}

// fail ends the render with err (once).
func (r *render) failLocked(err error) {
	if r.failed {
		return
	}
	r.failed = true
	go r.push(renderEvent{kind: evFail, err: err})
}

func (r *render) fail(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.failLocked(err)
}

// closeWriter stops accepting data and waits for the writer to drain.
func (r *render) closeWriter() {
	r.mu.Lock()
	if r.writeCh != nil && !r.closed {
		r.closed = true
		close(r.writeCh)
	}
	wg := r.writerWG
	r.mu.Unlock()
	if wg != nil {
		<-wg
	}
	r.mu.Lock()
	if r.file != nil {
		_ = r.file.Close()
		r.file = nil
	}
	r.mu.Unlock()
}

func (r *render) writer(b *RenderBroker, f *os.File, ch chan []byte, exited chan struct{}) {
	defer close(exited)
	var lastAck int64
	for chunk := range ch {
		if r.writeErr.Load() != nil {
			continue // drain
		}
		if _, err := f.Write(chunk); err != nil {
			e := fmt.Errorf("write render stream: %w", err)
			r.writeErr.Store(&e)
			go r.push(renderEvent{kind: evFail, err: e}) // not r.fail: a handler may hold r.mu while blocked on us
			continue
		}
		n := r.written.Add(int64(len(chunk)))
		if n-lastAck >= ackEvery {
			lastAck = n
			b.emitter.Emit(EventRenderAck, RenderAck{Token: r.token, Bytes: n})
		}
	}
}

// NewRenderBroker builds a broker. urlFor turns a file path into a /media
// URL (MediaService.URLFor). labDir enables the VizLab sink when non-empty.
func NewRenderBroker(emitter core.Emitter, urlFor func(string) (string, error), labDir string) *RenderBroker {
	return &RenderBroker{emitter: emitter, urlFor: urlFor, labDir: labDir, origins: map[string]bool{},
		sem: make(chan struct{}, 1), active: map[string]*render{}}
}

// SetAppOrigins sets the origins raw messages may come from (the app's own).
func (b *RenderBroker) SetAppOrigins(origins ...string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, o := range origins {
		b.origins[strings.TrimRight(o, "/")] = true
	}
}

// originOf reduces a source (WebView2 reports the full page URL) to scheme://host.
func originOf(s string) string {
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimRight(s, "/")
	}
	return u.Scheme + "://" + u.Host
}

func (b *RenderBroker) originOK(origin, topOrigin string) bool {
	origin, topOrigin = originOf(origin), originOf(topOrigin)
	b.mu.Lock()
	defer b.mu.Unlock()
	return origin == topOrigin && b.origins[origin]
}

// Render blocks until the renderer finishes and returns the stream it wrote
// in job.TempDir (SPEC.md §7.2). RB1's.
func (b *RenderBroker) Render(ctx context.Context, job *core.JobContext, plan RenderPlan) (RenderOutput, error) {
	return b.render(ctx, job, plan)
}

func (b *RenderBroker) render(ctx context.Context, job *core.JobContext, plan RenderPlan) (RenderOutput, error) {
	select {
	case b.sem <- struct{}{}:
	default:
		job.Progress(core.IndeterminateProgress, "Waiting for another render to finish")
		select {
		case b.sem <- struct{}{}:
		case <-ctx.Done():
			return RenderOutput{}, ctx.Err()
		}
	}
	defer func() { <-b.sem }()
	if err := ctx.Err(); err != nil {
		return RenderOutput{}, err
	}

	tok := make([]byte, 16)
	if _, err := rand.Read(tok); err != nil {
		return RenderOutput{}, fmt.Errorf("render token: %w", err)
	}
	r := &render{
		token: hex.EncodeToString(tok), job: job, tempDir: job.TempDir, plan: plan,
		planned: plannedFrames(plan),
		events:  make(chan renderEvent, 64), touch: make(chan struct{}, 1), done: make(chan struct{}),
	}
	planURL, err := writePlan(job.TempDir, plan, b.urlFor)
	if err != nil {
		return RenderOutput{}, core.Errorf(core.CodeInternal, "Couldn't prepare the render").WithCause(err)
	}

	b.mu.Lock()
	b.active[r.token] = r
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.active, r.token)
		b.mu.Unlock()
		close(r.done)
		r.closeWriter()
	}()

	job.Progress(0, "Starting the visual renderer…")
	b.emitter.Emit(EventRender, RenderStart{Token: r.token, PlanURL: planURL, JobID: job.ID})
	cancelRenderer := func() { b.emitter.Emit(EventRenderCancel, RenderCancel{Token: r.token}) }

	timer := time.NewTimer(startTimeout)
	defer timer.Stop()
	var start *startInfo
	for {
		select {
		case <-ctx.Done():
			cancelRenderer()
			wait := time.NewTimer(cancelWait)
			defer wait.Stop()
		drain:
			for {
				select {
				case ev := <-r.events:
					if ev.kind == evCancelled || ev.kind == evDone || ev.kind == evError {
						break drain
					}
				case <-wait.C:
					break drain
				}
			}
			return RenderOutput{}, context.Canceled
		case <-r.touch:
			timer.Reset(idleTimeout)
		case <-timer.C:
			cancelRenderer()
			if start == nil {
				return RenderOutput{}, core.Errorf(core.CodeInternal, "The visual renderer didn't start").
					WithHint("Show Toolbox's window and try again")
			}
			return RenderOutput{}, core.Errorf(core.CodeInternal, "The visual renderer stopped responding").
				WithHint("Show Toolbox's window and try again")
		case ev := <-r.events:
			timer.Reset(idleTimeout)
			switch ev.kind {
			case evStart:
				s := r.startSnapshot()
				start = &s
				job.Progress(0, "Rendering…")
			case evProgress:
				if ev.frames > 0 {
					p := float64(ev.frame) / float64(ev.frames)
					job.Progress(math.Min(math.Max(p, 0), 1), fmt.Sprintf("Rendering frame %d of %d", ev.frame, ev.frames))
				}
			case evFail:
				cancelRenderer()
				return RenderOutput{}, ev.err
			case evError:
				cancelRenderer()
				msg := ev.message
				if msg == "" {
					msg = "The visual renderer failed"
				}
				return RenderOutput{}, core.Errorf(core.CodeToolFailed, "%s", msg).WithHint(ev.detail)
			case evCancelled:
				return RenderOutput{}, core.Errorf(core.CodeCancelled, "The visual renderer stopped")
			case evDone:
				return b.finish(r, start, ev)
			}
		}
	}
}

func (r *render) startSnapshot() startInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.info
}

// finish verifies a done message against what was received and written.
func (b *RenderBroker) finish(r *render, start *startInfo, ev renderEvent) (RenderOutput, error) {
	r.closeWriter()
	if err := r.writeErr.Load(); err != nil {
		return RenderOutput{}, core.Errorf(core.CodeInternal, "Couldn't save the rendered video").WithCause(*err)
	}
	r.mu.Lock()
	received, codec, path := r.received, r.codec, ""
	if start != nil {
		path = filepath.Join(r.tempDir, streamFile(codec))
	}
	r.mu.Unlock()
	if start == nil {
		return RenderOutput{}, core.Errorf(core.CodeInternal, "The renderer finished before it started")
	}
	if ev.frames != r.planned {
		return RenderOutput{}, core.Errorf(core.CodeInternal, "The renderer produced %d frames instead of %d", ev.frames, r.planned)
	}
	if ev.bytes != received || r.written.Load() != received {
		return RenderOutput{}, core.Errorf(core.CodeInternal, "The renderer's video didn't arrive intact").
			WithHint("Try the render again")
	}
	r.job.Progress(1, "Rendered")
	return RenderOutput{Path: path, Codec: codec, Frames: ev.frames, Encoder: start.Encoder}, nil
}

func streamFile(codec string) string {
	if codec == "mjpeg" {
		return "frames.mjpeg"
	}
	return "video.h264"
}

// HandleRawMessage receives a raw message from the webview (main.go wires it
// to application.Options.RawMessageHandler).
func (b *RenderBroker) HandleRawMessage(msg, origin, topOrigin string) {
	switch {
	case strings.HasPrefix(msg, RawPrefix):
		if !b.originOK(origin, topOrigin) {
			slog.Debug("viz: dropped a render message from another origin")
			return
		}
		b.handleRender(msg[len(RawPrefix):])
	case strings.HasPrefix(msg, LabPrefix) && b.labDir != "":
		if !b.originOK(origin, topOrigin) {
			return
		}
		b.handleLab(msg[len(LabPrefix):])
	}
}

// handleRender parses "<token>|<kind>|…" (SPEC.md §7.2). Unknown tokens and
// malformed messages are dropped; content is never logged.
func (b *RenderBroker) handleRender(body string) {
	token, rest, ok := strings.Cut(body, "|")
	if !ok {
		return
	}
	b.mu.Lock()
	r := b.active[token]
	b.mu.Unlock()
	if r == nil {
		slog.Debug("viz: dropped a render message with an unknown token")
		return
	}
	kind, args, _ := strings.Cut(rest, "|")
	select {
	case r.touch <- struct{}{}:
	default:
	}
	switch kind {
	case "start":
		b.handleStart(r, args)
	case "data":
		b.handleData(r, args)
	case "progress":
		f, t, ok := strings.Cut(args, "|")
		fi, e1 := strconv.Atoi(f)
		ti, e2 := strconv.Atoi(t)
		if ok && e1 == nil && e2 == nil {
			r.push(renderEvent{kind: evProgress, frame: fi, frames: ti})
		}
	case "done":
		var d struct {
			Frames int   `json:"frames"`
			Bytes  int64 `json:"bytes"`
		}
		if err := json.Unmarshal([]byte(args), &d); err != nil {
			r.fail(core.Errorf(core.CodeInternal, "The renderer sent an unreadable message"))
			return
		}
		r.push(renderEvent{kind: evDone, frames: d.Frames, bytes: d.Bytes})
	case "cancelled":
		r.push(renderEvent{kind: evCancelled})
	case "error":
		var e struct {
			Message string `json:"message"`
			Detail  string `json:"detail"`
		}
		_ = json.Unmarshal([]byte(args), &e)
		r.push(renderEvent{kind: evError, message: e.Message, detail: e.Detail})
	}
}

func (b *RenderBroker) handleStart(r *render, args string) {
	if r.beginStream(b, args) {
		r.push(renderEvent{kind: evStart})
	}
}

// beginStream validates the start message and opens the output file.
func (r *render) beginStream(b *RenderBroker, args string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started || r.failed {
		return false
	}
	var info startInfo
	if err := json.Unmarshal([]byte(args), &info); err != nil {
		r.failLocked(core.Errorf(core.CodeInternal, "The renderer sent an unreadable message"))
		return false
	}
	switch info.Encoder {
	case "h264-hw", "h264-sw":
		r.codec = "h264"
	case "jpeg":
		r.codec = "mjpeg"
	default:
		r.failLocked(core.Errorf(core.CodeInternal, "The renderer chose an unknown encoder"))
		return false
	}
	if info.Frames != r.planned || info.Width != r.plan.Width || !heightOK(r.plan, info.Height) || info.FPS != r.plan.FPS {
		r.failLocked(core.Errorf(core.CodeInternal, "The renderer is set up differently from the plan"))
		return false
	}
	f, err := os.Create(filepath.Join(r.tempDir, streamFile(r.codec)))
	if err != nil {
		r.failLocked(core.Errorf(core.CodeInternal, "Couldn't save the rendered video").WithCause(err))
		return false
	}
	r.file, r.info, r.started = f, info, true
	r.writeCh = make(chan []byte, 32)
	r.writerWG = make(chan struct{})
	go r.writer(b, f, r.writeCh, r.writerWG)
	return true
}

func (b *RenderBroker) handleData(r *render, args string) {
	seqStr, payload, ok := strings.Cut(args, "|")
	seq, err := strconv.Atoi(seqStr)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failed || r.closed {
		return
	}
	if !ok || err != nil || !r.started {
		r.failLocked(core.Errorf(core.CodeInternal, "The renderer sent data out of order"))
		return
	}
	if seq != r.nextSeq {
		r.failLocked(core.Errorf(core.CodeInternal, "The renderer sent data out of order"))
		return
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		r.failLocked(core.Errorf(core.CodeInternal, "The renderer sent damaged data"))
		return
	}
	if r.received+int64(len(raw)) > maxBytes {
		r.failLocked(core.Errorf(core.CodeInternal, "The rendered video is too large").
			WithHint("Use a lower resolution or a shorter range"))
		return
	}
	r.nextSeq++
	r.received += int64(len(raw))
	r.writeCh <- raw
}

// heightOK accepts the plan height, or twice it for the stacked colour/alpha
// canvas of overlay renders.
func heightOK(plan RenderPlan, h int) bool {
	return h == plan.Height || (plan.Mode == ModeOverlay && h == 2*plan.Height)
}

var labName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,120}$`)

// handleLab writes "name|base64" into labDir (VizLab, SPEC.md §11.4).
func (b *RenderBroker) handleLab(body string) {
	name, data, ok := strings.Cut(body, "|")
	if !ok || !labName.MatchString(name) || strings.HasPrefix(name, ".") {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return
	}
	if err := os.MkdirAll(b.labDir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(b.labDir, name), raw, 0o644)
}
