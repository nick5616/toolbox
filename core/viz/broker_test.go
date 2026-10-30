package viz

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

const testOrigin = "http://wails.localhost"

type capture struct {
	mu     sync.Mutex
	events []capturedEvent
	ch     chan capturedEvent
}

type capturedEvent struct {
	name string
	data any
}

func newCapture() *capture { return &capture{ch: make(chan capturedEvent, 256)} }

func (c *capture) Emit(name string, data any) {
	c.mu.Lock()
	c.events = append(c.events, capturedEvent{name, data})
	c.mu.Unlock()
	select {
	case c.ch <- capturedEvent{name, data}:
	default:
	}
}

func (c *capture) named(name string) []capturedEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []capturedEvent
	for _, e := range c.events {
		if e.name == name {
			out = append(out, e)
		}
	}
	return out
}

// waitStart blocks until the broker emitted viz:render and returns it.
func (c *capture) waitStart(t *testing.T) RenderStart {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-c.ch:
			if e.name == EventRender {
				return e.data.(RenderStart)
			}
		case <-deadline:
			t.Fatal("no viz:render event")
		}
	}
}

func testPlan() RenderPlan {
	return RenderPlan{
		Analysis: AnalysisRef{AudioJSON: "/a/audio.json", FeaturesPath: "/a/f.bin", TextJSON: "/a/text.json",
			Summary: AnalysisSummary{DurationMs: 2000}},
		ShowJSON: `{"v":1}`, Width: 640, Height: 360, FPS: 30, StartMs: 0, EndMs: 1000, Mode: ModeOpaque, Seed: 7,
	}
}

type harness struct {
	t   *testing.T
	b   *RenderBroker
	em  *capture
	job *core.JobContext
	mu  sync.Mutex
	prg []float64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, em: newCapture()}
	h.b = NewRenderBroker(h.em, func(p string) (string, error) { return "/media/x/" + filepath.Base(p), nil }, "")
	h.b.SetAppOrigins(testOrigin)
	h.job = core.NewJobContext(core.JobContext{ID: "job1", TempDir: t.TempDir()}, core.JobHooks{
		Progress: func(p float64, _ string) { h.mu.Lock(); h.prg = append(h.prg, p); h.mu.Unlock() },
	})
	return h
}

type result struct {
	out RenderOutput
	err error
}

func (h *harness) run(ctx context.Context, plan RenderPlan) <-chan result {
	ch := make(chan result, 1)
	go func() {
		out, err := h.b.Render(ctx, h.job, plan)
		ch <- result{out, err}
	}()
	return ch
}

func (h *harness) send(token, rest string) {
	h.b.HandleRawMessage(RawPrefix+token+"|"+rest, testOrigin, testOrigin)
}

func startMsg(plan RenderPlan, enc string) string {
	return "start|" + fmt.Sprintf(`{"encoder":%q,"width":%d,"height":%d,"fps":%d,"frames":%d}`,
		enc, plan.Width, plan.Height, plan.FPS, plannedFrames(plan))
}

func dataMsg(seq int, b []byte) string {
	return fmt.Sprintf("data|%d|%s", seq, base64.StdEncoding.EncodeToString(b))
}

func doneMsg(frames int, bytes int) string {
	return fmt.Sprintf(`done|{"frames":%d,"bytes":%d}`, frames, bytes)
}

func wait(t *testing.T, ch <-chan result) result {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("render didn't return")
		return result{}
	}
}

func appErr(t *testing.T, err error) *core.AppError {
	t.Helper()
	var ae *core.AppError
	if !errors.As(err, &ae) {
		t.Fatalf("not an AppError: %v", err)
	}
	return ae
}

func TestPlannedFrames(t *testing.T) {
	p := testPlan()
	cases := []struct {
		start, end int64
		fps, want  int
	}{
		{0, 1000, 30, 30}, {0, 0, 30, 60}, {500, 10500, 24, 240}, {0, 10, 30, 1}, {0, 1017, 60, 61},
	}
	for _, c := range cases {
		p.StartMs, p.EndMs, p.FPS = c.start, c.end, c.fps
		if got := plannedFrames(p); got != c.want {
			t.Errorf("%d-%d@%d = %d, want %d", c.start, c.end, c.fps, got, c.want)
		}
	}
}

func TestPlanUsesURLs(t *testing.T) {
	dir := t.TempDir()
	p := testPlan()
	p.CoverPath = "/t/cover.png"
	u, err := writePlan(dir, p, func(s string) (string, error) { return "/media/tok/" + filepath.Base(s), nil })
	if err != nil {
		t.Fatal(err)
	}
	if u != "/media/tok/render-plan.json" {
		t.Errorf("plan url %q", u)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, planFileName))
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	an := got["analysis"].(map[string]any)
	if an["audioJsonUrl"] != "/media/tok/audio.json" || an["featuresUrl"] != "/media/tok/f.bin" || an["textJsonUrl"] != "/media/tok/text.json" {
		t.Errorf("analysis urls: %v", an)
	}
	if got["coverUrl"] != "/media/tok/cover.png" || got["imageUrl"] != "" || got["mode"] != "opaque" || got["seed"].(float64) != 7 {
		t.Errorf("plan: %v", got)
	}
	if strings.Contains(string(raw), `"/a/`) {
		t.Error("plan still contains a file path")
	}
}

func TestRenderHappyPath(t *testing.T) {
	h := newHarness(t)
	plan := testPlan()
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	if st.JobID != "job1" || len(st.Token) != 32 || st.PlanURL != "/media/x/render-plan.json" {
		t.Fatalf("start event: %+v", st)
	}
	if _, err := os.Stat(filepath.Join(h.job.TempDir, planFileName)); err != nil {
		t.Fatal(err)
	}
	h.send(st.Token, startMsg(plan, "h264-sw"))
	h.send(st.Token, dataMsg(0, []byte("AAAA")))
	h.send(st.Token, dataMsg(1, []byte("BBB")))
	h.send(st.Token, "progress|15|30")
	h.send(st.Token, doneMsg(30, 7))
	r := wait(t, res)
	if r.err != nil {
		t.Fatal(r.err)
	}
	if r.out.Codec != "h264" || r.out.Frames != 30 || r.out.Encoder != "h264-sw" || filepath.Base(r.out.Path) != "video.h264" {
		t.Errorf("output %+v", r.out)
	}
	b, _ := os.ReadFile(r.out.Path)
	if string(b) != "AAAABBB" {
		t.Errorf("file %q", b)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	found := false
	for _, p := range h.prg {
		if p == 0.5 {
			found = true
		}
	}
	if !found {
		t.Errorf("progress %v lacks 0.5", h.prg)
	}
	// the token is gone afterwards
	h.b.mu.Lock()
	n := len(h.b.active)
	h.b.mu.Unlock()
	if n != 0 {
		t.Error("render still registered")
	}
}

func TestRenderMJPEG(t *testing.T) {
	h := newHarness(t)
	plan := testPlan()
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	h.send(st.Token, startMsg(plan, "jpeg"))
	h.send(st.Token, dataMsg(0, []byte("JPG")))
	h.send(st.Token, doneMsg(30, 3))
	r := wait(t, res)
	if r.err != nil || r.out.Codec != "mjpeg" || filepath.Base(r.out.Path) != "frames.mjpeg" {
		t.Fatalf("%+v %v", r.out, r.err)
	}
}

func TestRenderOverlayDoubleHeight(t *testing.T) {
	h := newHarness(t)
	plan := testPlan()
	plan.Mode = ModeOverlay
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	plan2 := plan
	plan2.Height *= 2
	h.send(st.Token, strings.Replace(startMsg(plan2, "h264-hw"), fmt.Sprintf(`"frames":%d`, plannedFrames(plan)), fmt.Sprintf(`"frames":%d`, plannedFrames(plan)), 1))
	h.send(st.Token, dataMsg(0, []byte("x")))
	h.send(st.Token, doneMsg(30, 1))
	if r := wait(t, res); r.err != nil {
		t.Fatal(r.err)
	}
}

// failing drives a render with the given messages and expects an AppError.
func failing(t *testing.T, msgs func(tok string, plan RenderPlan) []string, wantMsg string) *harness {
	t.Helper()
	h := newHarness(t)
	plan := testPlan()
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	for _, m := range msgs(st.Token, plan) {
		h.send(st.Token, m)
	}
	r := wait(t, res)
	if r.err == nil {
		t.Fatalf("expected %q, got success", wantMsg)
	}
	if ae := appErr(t, r.err); ae.Message != wantMsg {
		t.Fatalf("message %q, want %q", ae.Message, wantMsg)
	}
	if !strings.HasPrefix(wantMsg, "The renderer produced") && !strings.Contains(wantMsg, "arrive intact") && len(h.em.named(EventRenderCancel)) == 0 {
		t.Error("renderer was not told to cancel")
	}
	return h
}

func TestRenderSeqGapAndRepeat(t *testing.T) {
	for name, seqs := range map[string][]int{"gap": {0, 2}, "repeat": {0, 0}, "start at 1": {1}} {
		t.Run(name, func(t *testing.T) {
			failing(t, func(_ string, p RenderPlan) []string {
				m := []string{startMsg(p, "h264-sw")}
				for _, s := range seqs {
					m = append(m, dataMsg(s, []byte("x")))
				}
				return m
			}, "The renderer sent data out of order")
		})
	}
}

func TestRenderDataBeforeStart(t *testing.T) {
	failing(t, func(string, RenderPlan) []string { return []string{dataMsg(0, []byte("x"))} }, "The renderer sent data out of order")
}

func TestRenderBadBase64(t *testing.T) {
	failing(t, func(_ string, p RenderPlan) []string {
		return []string{startMsg(p, "h264-sw"), "data|0|!!!notbase64"}
	}, "The renderer sent damaged data")
}

func TestRenderFrameMismatch(t *testing.T) {
	failing(t, func(_ string, p RenderPlan) []string {
		return []string{startMsg(p, "h264-sw"), dataMsg(0, []byte("x")), doneMsg(29, 1)}
	}, "The renderer produced 29 frames instead of 30")
}

func TestRenderByteMismatch(t *testing.T) {
	failing(t, func(_ string, p RenderPlan) []string {
		return []string{startMsg(p, "h264-sw"), dataMsg(0, []byte("xx")), doneMsg(30, 5)}
	}, "The renderer's video didn't arrive intact")
}

func TestRenderStartMismatch(t *testing.T) {
	failing(t, func(_ string, p RenderPlan) []string {
		p.Width = 100
		return []string{startMsg(p, "h264-sw")}
	}, "The renderer is set up differently from the plan")
}

func TestRenderByteCap(t *testing.T) {
	old := maxBytes
	maxBytes = 10
	defer func() { maxBytes = old }()
	failing(t, func(_ string, p RenderPlan) []string {
		return []string{startMsg(p, "h264-sw"), dataMsg(0, make([]byte, 8)), dataMsg(1, make([]byte, 8))}
	}, "The rendered video is too large")
}

func TestRenderErrorMessage(t *testing.T) {
	h := newHarness(t)
	plan := testPlan()
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	h.send(st.Token, `error|{"message":"This computer's graphics can't run the visualizer","detail":"GPU: none"}`)
	r := wait(t, res)
	ae := appErr(t, r.err)
	if ae.Message != "This computer's graphics can't run the visualizer" || ae.Hint != "GPU: none" {
		t.Errorf("%+v", ae)
	}
}

func TestRenderIgnoresBadSenders(t *testing.T) {
	h := newHarness(t)
	plan := testPlan()
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	msg := RawPrefix + st.Token + "|" + startMsg(plan, "h264-sw")
	h.b.HandleRawMessage(msg, "http://evil.example", "http://evil.example")      // wrong origin
	h.b.HandleRawMessage(msg, testOrigin+"/frame", "http://wails.localhost/top") // fine origin but...
	h.b.HandleRawMessage(msg, testOrigin, "http://other.example")                // child frame
	h.b.HandleRawMessage(RawPrefix+strings.Repeat("0", 32)+"|"+startMsg(plan, "h264-sw"), testOrigin, testOrigin)
	h.b.HandleRawMessage("other|"+st.Token+"|cancelled", testOrigin, testOrigin)
	// only the second message (same origin after reduction) may have started it.
	h.b.mu.Lock()
	r := h.b.active[st.Token]
	h.b.mu.Unlock()
	r.mu.Lock()
	started := r.started
	r.mu.Unlock()
	if !started {
		t.Fatal("same-origin message was dropped")
	}
	// a child frame and a stranger must not be able to finish it.
	h.b.HandleRawMessage(RawPrefix+st.Token+"|"+doneMsg(30, 0), testOrigin, "http://other.example")
	h.b.HandleRawMessage(RawPrefix+st.Token+"|cancelled", "http://evil.example", "http://evil.example")
	select {
	case <-res:
		t.Fatal("render ended from a rejected sender")
	case <-time.After(100 * time.Millisecond):
	}
	h.send(st.Token, doneMsg(30, 0))
	if r := wait(t, res); r.err != nil {
		t.Fatal(r.err)
	}
}

func TestRenderOriginRejectedBeforeStart(t *testing.T) {
	h := newHarness(t)
	plan := testPlan()
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	h.b.HandleRawMessage(RawPrefix+st.Token+"|"+startMsg(plan, "h264-sw"), "http://evil.example", "http://evil.example")
	h.b.HandleRawMessage(RawPrefix+st.Token+"|"+startMsg(plan, "h264-sw"), testOrigin, "http://elsewhere")
	if _, err := os.Stat(filepath.Join(h.job.TempDir, "video.h264")); err == nil {
		t.Fatal("rejected start created the stream")
	}
	h.send(st.Token, "cancelled")
	wait(t, res)
}

func TestRenderStartTimeout(t *testing.T) {
	old := startTimeout
	startTimeout = 50 * time.Millisecond
	defer func() { startTimeout = old }()
	h := newHarness(t)
	r := wait(t, h.run(context.Background(), testPlan()))
	ae := appErr(t, r.err)
	if ae.Message != "The visual renderer didn't start" || ae.Hint != "Show Toolbox's window and try again" {
		t.Errorf("%+v", ae)
	}
	if len(h.em.named(EventRenderCancel)) == 0 {
		t.Error("no cancel event")
	}
}

func TestRenderIdleTimeout(t *testing.T) {
	old := idleTimeout
	idleTimeout = 100 * time.Millisecond
	defer func() { idleTimeout = old }()
	h := newHarness(t)
	plan := testPlan()
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	h.send(st.Token, startMsg(plan, "h264-sw"))
	// data keeps it alive past one idle period.
	for i := 0; i < 4; i++ {
		time.Sleep(50 * time.Millisecond)
		h.send(st.Token, dataMsg(i, []byte("x")))
	}
	select {
	case <-res:
		t.Fatal("timed out while data was flowing")
	default:
	}
	r := wait(t, res)
	if ae := appErr(t, r.err); ae.Message != "The visual renderer stopped responding" {
		t.Errorf("%+v", ae)
	}
}

func TestRenderCancel(t *testing.T) {
	h := newHarness(t)
	plan := testPlan()
	ctx, cancel := context.WithCancel(context.Background())
	res := h.run(ctx, plan)
	st := h.em.waitStart(t)
	h.send(st.Token, startMsg(plan, "h264-sw"))
	cancel()
	// the renderer answers.
	deadline := time.Now().Add(3 * time.Second)
	for len(h.em.named(EventRenderCancel)) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	ev := h.em.named(EventRenderCancel)
	if len(ev) != 1 || ev[0].data.(RenderCancel).Token != st.Token {
		t.Fatalf("cancel events: %+v", ev)
	}
	h.send(st.Token, "cancelled")
	if r := wait(t, res); !errors.Is(r.err, context.Canceled) {
		t.Fatalf("err = %v", r.err)
	}
}

func TestRenderCancelNoAnswer(t *testing.T) {
	old := cancelWait
	cancelWait = 80 * time.Millisecond
	defer func() { cancelWait = old }()
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	res := h.run(ctx, testPlan())
	h.em.waitStart(t)
	t0 := time.Now()
	cancel()
	if r := wait(t, res); !errors.Is(r.err, context.Canceled) {
		t.Fatalf("err = %v", r.err)
	}
	if time.Since(t0) < 60*time.Millisecond {
		t.Error("returned before the grace period")
	}
}

func TestRenderAckCadence(t *testing.T) {
	old := ackEvery
	ackEvery = 10
	defer func() { ackEvery = old }()
	h := newHarness(t)
	plan := testPlan()
	res := h.run(context.Background(), plan)
	st := h.em.waitStart(t)
	h.send(st.Token, startMsg(plan, "h264-sw"))
	for i := 0; i < 5; i++ {
		h.send(st.Token, dataMsg(i, make([]byte, 6)))
	}
	h.send(st.Token, doneMsg(30, 30))
	if r := wait(t, res); r.err != nil {
		t.Fatal(r.err)
	}
	var got []int64
	for _, e := range h.em.named(EventRenderAck) {
		a := e.data.(RenderAck)
		if a.Token != st.Token {
			t.Error("ack for another token")
		}
		got = append(got, a.Bytes)
	}
	// 6, 12 (ack), 18, 24 (ack: 24-12 >= 10), 30 (no: 30-24 < 10)
	want := []int64{12, 24}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("acks %v, want %v", got, want)
	}
}

func TestRenderOneAtATime(t *testing.T) {
	h := newHarness(t)
	plan := testPlan()
	ctx, cancel := context.WithCancel(context.Background())
	res1 := h.run(ctx, plan)
	st := h.em.waitStart(t)

	job2 := core.NewJobContext(core.JobContext{ID: "job2", TempDir: t.TempDir()}, core.JobHooks{})
	res2 := make(chan result, 1)
	go func() { o, e := h.b.Render(context.Background(), job2, plan); res2 <- result{o, e} }()
	select {
	case e := <-h.em.ch:
		if e.name == EventRender {
			t.Fatal("second render started while the first runs")
		}
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
	h.send(st.Token, "cancelled")
	wait(t, res1)
	st2 := h.em.waitStart(t)
	if st2.JobID != "job2" || st2.Token == st.Token {
		t.Fatalf("second start %+v", st2)
	}
	h.b.HandleRawMessage(RawPrefix+st2.Token+"|cancelled", testOrigin, testOrigin)
	wait(t, res2)
}
