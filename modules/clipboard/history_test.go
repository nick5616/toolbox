package clipboard

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/store"
)

// ---- fakes ----

type write struct {
	kind core.ClipKind
	data []byte
}

// fakeSource never touches the real clipboard.
type fakeSource struct {
	mu       sync.Mutex
	initErr  error
	in       chan change
	kill     chan struct{}
	watches  int
	images   bool
	writes   []write
	writeErr error
	wg       sync.WaitGroup
}

func newFake() *fakeSource { return &fakeSource{in: make(chan change)} }

func (f *fakeSource) Init() error { return f.initErr }

func (f *fakeSource) Watch(ctx context.Context, images bool) <-chan change {
	out := make(chan change)
	kill := make(chan struct{})
	f.mu.Lock()
	f.watches++
	f.images = images
	f.kill = kill
	f.mu.Unlock()
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		defer close(out)
		for {
			select {
			case c := <-f.in:
				select {
				case out <- c:
				case <-ctx.Done():
					return
				}
			case <-kill:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

func (f *fakeSource) Write(_ context.Context, kind core.ClipKind, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.writeErr != nil {
		return f.writeErr
	}
	f.writes = append(f.writes, write{kind, data})
	return nil
}

func (f *fakeSource) send(t *testing.T, c change) {
	t.Helper()
	select {
	case f.in <- c:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out sending a clipboard change (is the watcher running?)")
	}
}

func (f *fakeSource) watchCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.watches
}

func (f *fakeSource) lastImages() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.images
}

func (f *fakeSource) killWatch() {
	f.mu.Lock()
	k := f.kill
	f.mu.Unlock()
	close(k)
}

type event struct {
	name string
	data any
}

type events struct {
	mu sync.Mutex
	l  []event
}

func (e *events) Emit(name string, data any) {
	e.mu.Lock()
	e.l = append(e.l, event{name, data})
	e.mu.Unlock()
}

func (e *events) all(name string) []any {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []any
	for _, ev := range e.l {
		if ev.name == name {
			out = append(out, ev.data)
		}
	}
	return out
}

func (e *events) count(name string) int { return len(e.all(name)) }

type clock struct{ ns atomic.Int64 }

func (c *clock) now() time.Time          { return time.Unix(0, c.ns.Load()) }
func (c *clock) advance(d time.Duration) { c.ns.Add(int64(d)) }

type env struct {
	t     *testing.T
	h     *History
	db    *store.DB
	set   *core.SettingsService
	src   *fakeSource
	ev    *events
	dir   string
	clk   *clock
	tick  chan time.Time
	stops atomic.Int32
}

func newEnv(t *testing.T, cs core.ClipboardSettings) *env {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "toolbox.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	ev := &events{}
	set, err := core.NewSettingsService(db, ev, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := set.Update(context.Background(), core.SettingsPatch{Clipboard: &cs}); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, db: db, set: set, src: newFake(), ev: ev, dir: filepath.Join(t.TempDir(), "clips"),
		clk: &clock{}, tick: make(chan time.Time)}
	e.clk.ns.Store(time.Now().UnixNano())
	e.h = New(Config{Store: db, Settings: set, Emitter: ev, Dir: e.dir})
	e.h.src = e.src
	e.h.now = e.clk.now
	e.h.newTicker = func(time.Duration) (<-chan time.Time, func()) { return e.tick, func() {} }
	e.h.backoffMin, e.h.backoffMax = 5*time.Millisecond, 20*time.Millisecond
	return e
}

func (e *env) start() {
	e.t.Helper()
	e.h.Start(context.Background())
	e.t.Cleanup(e.h.Stop)
}

func (e *env) update(cs core.ClipboardSettings) {
	e.t.Helper()
	if _, err := e.set.Update(context.Background(), core.SettingsPatch{Clipboard: &cs}); err != nil {
		e.t.Fatal(err)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (e *env) waitRecording() {
	e.t.Helper()
	eventually(e.t, "recording", func() bool { return e.h.State().Recording })
}

func (e *env) list() []core.ClipItem {
	e.t.Helper()
	p, err := e.h.List(context.Background(), core.ClipQuery{})
	if err != nil {
		e.t.Fatal(err)
	}
	return p.Items
}

// record sends a change and waits until it was processed (added event or a
// sentinel-free settle based on the added count).
func (e *env) recordText(s string) {
	e.t.Helper()
	n := e.ev.count(core.EventClipboardAdded)
	e.src.send(e.t, change{Kind: core.ClipText, Bytes: []byte(s)})
	eventually(e.t, "added event", func() bool { return e.ev.count(core.EventClipboardAdded) > n })
}

var enabled = core.ClipboardSettings{Enabled: true, Images: true, RetentionDays: 0, MaxItems: 500}

func pngBytes(w, h int) []byte {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		panic(err)
	}
	return b.Bytes()
}

func dirFiles(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

// ---- tests ----

func TestDisabledByDefaultDoesNotWatch(t *testing.T) {
	e := newEnv(t, core.DefaultClipboardSettings())
	e.start()
	time.Sleep(50 * time.Millisecond)
	if e.src.watchCount() != 0 || e.h.State().Recording {
		t.Fatal("watching while disabled")
	}
}

func TestTextRecordedWithPreview(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	e.recordText("  hello \n\n  world\t!  \n\n")
	items := e.list()
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	it := items[0]
	if it.Kind != core.ClipText || it.Text != "  hello \n\n  world\t!" || it.Preview != "hello world !" {
		t.Fatalf("item = %+v", it)
	}
	long := strings.Repeat("ab ", 400)
	e.recordText(long)
	for _, it := range e.list() {
		if strings.HasPrefix(it.Text, "ab") && len([]rune(it.Preview)) != 300 {
			t.Fatalf("preview len = %d", len([]rune(it.Preview)))
		}
	}
}

func TestSkips(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	e.src.send(t, change{Kind: core.ClipText, Bytes: []byte("secret"), Sensitive: true})
	e.src.send(t, change{Kind: core.ClipText, Bytes: []byte(" \n\t ")})
	e.src.send(t, change{Kind: core.ClipText, Bytes: bytes.Repeat([]byte("a"), maxTextBytes+1)})
	e.src.send(t, change{Kind: core.ClipImage, Bytes: []byte("not a png")})
	e.recordText("ok")
	items := e.list()
	if len(items) != 1 || items[0].Text != "ok" {
		t.Fatalf("items = %+v", items)
	}
	if len(dirFiles(t, e.dir)) != 0 {
		t.Fatal("files written for skipped items")
	}
	// exactly at the limit is accepted
	e.recordText(strings.Repeat("a", maxTextBytes))
}

func TestImageRecorded(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	data := pngBytes(7, 3)
	n := e.ev.count(core.EventClipboardAdded)
	e.src.send(t, change{Kind: core.ClipImage, Bytes: data})
	eventually(t, "added", func() bool { return e.ev.count(core.EventClipboardAdded) > n })
	items := e.list()
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	it := items[0]
	if it.Kind != core.ClipImage || it.Width != 7 || it.Height != 3 || it.ByteSize != int64(len(data)) {
		t.Fatalf("item = %+v", it)
	}
	if it.ImagePath != filepath.Join(e.dir, it.ID+".png") {
		t.Fatalf("path = %s", it.ImagePath)
	}
	got, err := os.ReadFile(it.ImagePath)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("file: %v", err)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(it.ImagePath)
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("file perm = %v", st.Mode().Perm())
		}
		ds, _ := os.Stat(e.dir)
		if ds.Mode().Perm() != 0o700 {
			t.Fatalf("dir perm = %v", ds.Mode().Perm())
		}
	}
	// duplicate image bumps and leaves exactly one file
	e.clk.advance(time.Minute)
	n = e.ev.count(core.EventClipboardAdded)
	e.src.send(t, change{Kind: core.ClipImage, Bytes: data})
	eventually(t, "added", func() bool { return e.ev.count(core.EventClipboardAdded) > n })
	if len(e.list()) != 1 || len(dirFiles(t, e.dir)) != 1 {
		t.Fatalf("items=%d files=%v", len(e.list()), dirFiles(t, e.dir))
	}
}

func TestImagesDisabledAndToggle(t *testing.T) {
	cs := enabled
	cs.Images = false
	e := newEnv(t, cs)
	e.start()
	e.waitRecording()
	if e.src.lastImages() {
		t.Fatal("watching images while disabled")
	}
	e.src.send(t, change{Kind: core.ClipImage, Bytes: pngBytes(2, 2)})
	e.recordText("t")
	if len(e.list()) != 1 {
		t.Fatalf("image recorded while disabled: %+v", e.list())
	}
	e.update(enabled)
	eventually(t, "watch restart with images", func() bool { return e.src.watchCount() == 2 && e.src.lastImages() })
	e.waitRecording()
}

func TestDedupeBump(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	e.recordText("same")
	first := e.list()[0]
	e.clk.advance(time.Minute)
	e.recordText("same\n")
	items := e.list()
	if len(items) != 1 || items[0].ID != first.ID || items[0].LastUsedAt <= first.LastUsedAt {
		t.Fatalf("items = %+v (first %+v)", items, first)
	}
}

func TestCopyTextAndSelfSuppression(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	e.recordText("first")
	e.clk.advance(time.Minute)
	e.recordText("second")
	first := e.list()[1]
	if first.Text != "first" {
		t.Fatalf("order: %+v", e.list())
	}
	e.clk.advance(time.Minute)
	n := e.ev.count(core.EventClipboardAdded)
	if err := e.h.Copy(context.Background(), first.ID); err != nil {
		t.Fatal(err)
	}
	if len(e.src.writes) != 1 || e.src.writes[0].kind != core.ClipText || string(e.src.writes[0].data) != "first" {
		t.Fatalf("writes = %+v", e.src.writes)
	}
	if e.ev.count(core.EventClipboardAdded) != n+1 {
		t.Fatal("copy should emit added")
	}
	if got := e.list()[0]; got.ID != first.ID {
		t.Fatalf("copied item not bumped to top: %+v", e.list())
	}
	// the OS echoes our own write: ignored (no extra event, no new item)
	e.src.send(t, change{Kind: core.ClipText, Bytes: []byte("first")})
	// a following real copy is recorded normally, proving the echo was processed
	e.recordText("third")
	if e.ev.count(core.EventClipboardAdded) != n+2 || len(e.list()) != 3 {
		t.Fatalf("added=%d items=%d", e.ev.count(core.EventClipboardAdded), len(e.list()))
	}
	// suppression is one-shot: copying "first" again by hand bumps normally
	e.clk.advance(time.Minute)
	e.recordText("first")
	if len(e.list()) != 3 {
		t.Fatalf("items = %d", len(e.list()))
	}
	if err := e.h.Copy(context.Background(), "nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("copy unknown: %v", err)
	}
}

func TestCopyImage(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	data := pngBytes(4, 4)
	e.src.send(t, change{Kind: core.ClipImage, Bytes: data})
	eventually(t, "item", func() bool { return len(e.list()) == 1 })
	id := e.list()[0].ID
	if err := e.h.Copy(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if len(e.src.writes) != 1 || e.src.writes[0].kind != core.ClipImage || !bytes.Equal(e.src.writes[0].data, data) {
		t.Fatal("image not written back")
	}
	// OS re-encodes the PNG: still suppressed, no duplicate item
	e.src.send(t, change{Kind: core.ClipImage, Bytes: pngBytes(4, 4)[:len(data)]})
	e.recordText("x")
	if len(e.list()) != 2 {
		t.Fatalf("items = %d", len(e.list()))
	}
	e.src.writeErr = errors.New("boom")
	if err := e.h.Copy(context.Background(), id); err == nil {
		t.Fatal("expected write error")
	}
}

func TestPauseResume(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	if err := e.h.Pause(); err != nil {
		t.Fatal(err)
	}
	if s := e.h.State(); s.Recording || !s.Paused {
		t.Fatalf("state = %+v", s)
	}
	eventually(t, "watch stopped", func() bool {
		e.src.wg.Wait()
		return true
	})
	if err := e.h.Resume(); err != nil {
		t.Fatal(err)
	}
	e.waitRecording()
	e.recordText("after resume")
	states := e.ev.all(core.EventClipboardState)
	var sawPaused, sawRec bool
	for _, s := range states {
		cs := s.(core.ClipboardState)
		sawPaused = sawPaused || cs.Paused
		sawRec = sawRec || cs.Recording
	}
	if !sawPaused || !sawRec {
		t.Fatalf("states = %+v", states)
	}
}

func TestEnableDisableViaSettings(t *testing.T) {
	e := newEnv(t, core.DefaultClipboardSettings())
	e.start()
	e.update(enabled)
	e.waitRecording()
	e.recordText("a")
	cs := enabled
	cs.Enabled = false
	e.update(cs)
	eventually(t, "stopped", func() bool {
		e.h.mu.Lock()
		defer e.h.mu.Unlock()
		return !e.h.running
	})
	e.src.wg.Wait() // watcher goroutine exited
	e.update(enabled)
	e.waitRecording()
	if e.src.watchCount() != 2 {
		t.Fatalf("watch count = %d", e.src.watchCount())
	}
}

func TestInitFailure(t *testing.T) {
	e := newEnv(t, enabled)
	e.src.initErr = errors.New("no display")
	e.start()
	eventually(t, "error state", func() bool { return e.h.State().Error == "Clipboard unavailable" })
	if e.h.State().Recording || e.src.watchCount() != 0 {
		t.Fatal("should stay idle")
	}
	if err := e.h.Copy(context.Background(), "x"); err == nil {
		t.Fatal("copy should fail")
	}
}

func TestErrorBackoffAndRecovery(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	e.src.send(t, change{Err: errors.New("clipboard busy")})
	eventually(t, "error state event", func() bool {
		for _, s := range e.ev.all(core.EventClipboardState) {
			if strings.Contains(s.(core.ClipboardState).Error, "busy") {
				return true
			}
		}
		return false
	})
	eventually(t, "recovered", func() bool { s := e.h.State(); return s.Recording && s.Error == "" })
	if e.src.watchCount() != 2 {
		t.Fatalf("watch count = %d", e.src.watchCount())
	}
	e.recordText("back")
	// a watcher that dies by itself is also retried
	e.src.killWatch()
	eventually(t, "re-watch", func() bool { return e.src.watchCount() == 3 && e.h.State().Recording })
	e.recordText("again")
}

func TestRetentionTimerAndFileCleanup(t *testing.T) {
	cs := enabled
	cs.RetentionDays = 1
	e := newEnv(t, cs)
	ctx := context.Background()
	if err := os.MkdirAll(e.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	mk := func(id string, age time.Duration, pinned bool) core.ClipItem {
		p := filepath.Join(e.dir, id+".png")
		if err := os.WriteFile(p, pngBytes(1, 1), 0o600); err != nil {
			t.Fatal(err)
		}
		ts := e.clk.now().Add(-age).UnixMilli()
		it, _, err := e.db.UpsertClip(ctx, core.ClipItem{ID: id, Kind: core.ClipImage, ImagePath: p, Hash: id,
			Pinned: pinned, CreatedAt: ts, LastUsedAt: ts})
		if err != nil {
			t.Fatal(err)
		}
		return it
	}
	mk("old", 48*time.Hour, false)
	mk("oldpinned", 48*time.Hour, true)
	mk("fresh", time.Hour, false)
	e.start() // prune on start
	eventually(t, "start prune", func() bool { return e.ev.count(core.EventClipboardRemoved) == 1 })
	if got := dirFiles(t, e.dir); len(got) != 2 {
		t.Fatalf("files = %v", got)
	}
	rm := e.ev.all(core.EventClipboardRemoved)[0].(core.ClipsRemoved)
	if len(rm.IDs) != 1 || rm.IDs[0] != "old" {
		t.Fatalf("removed = %+v", rm)
	}
	// hourly tick after the clock moved: fresh expires, pinned stays
	e.clk.advance(30 * time.Hour)
	e.tick <- time.Now()
	eventually(t, "hourly prune", func() bool { return e.ev.count(core.EventClipboardRemoved) == 2 })
	if got := dirFiles(t, e.dir); len(got) != 1 || got[0] != "oldpinned.png" {
		t.Fatalf("files = %v", got)
	}
	// shortening retention via settings prunes immediately (forever -> 1 day is the
	// same here, so use the max-items path below instead)
}

func TestMaxItemsPrunesAfterInsert(t *testing.T) {
	cs := enabled
	cs.MaxItems = core.MinClipItems
	e := newEnv(t, cs)
	ctx := context.Background()
	for i := 0; i < core.MinClipItems; i++ {
		id := string(rune('a'+i/26)) + string(rune('a'+i%26))
		ts := e.clk.now().Add(-time.Duration(1000-i) * time.Minute).UnixMilli()
		if _, _, err := e.db.UpsertClip(ctx, core.ClipItem{ID: id, Kind: core.ClipText, Text: id, Preview: id, Hash: id, CreatedAt: ts, LastUsedAt: ts}); err != nil {
			t.Fatal(err)
		}
	}
	e.start()
	e.waitRecording()
	e.recordText("one too many")
	eventually(t, "removed", func() bool { return e.ev.count(core.EventClipboardRemoved) == 1 })
	items := e.list()
	if len(items) != core.MinClipItems || items[0].Text != "one too many" {
		t.Fatalf("items = %d first=%q", len(items), items[0].Text)
	}
	if rm := e.ev.all(core.EventClipboardRemoved)[0].(core.ClipsRemoved); len(rm.IDs) != 1 || rm.IDs[0] != "aa" {
		t.Fatalf("removed = %+v", rm)
	}
}

func TestRetentionSettingChangePrunes(t *testing.T) {
	e := newEnv(t, enabled) // forever
	ts := e.clk.now().Add(-10 * 24 * time.Hour).UnixMilli()
	if _, _, err := e.db.UpsertClip(context.Background(), core.ClipItem{ID: "x", Kind: core.ClipText, Text: "x", Preview: "x", Hash: "x", CreatedAt: ts, LastUsedAt: ts}); err != nil {
		t.Fatal(err)
	}
	e.start()
	time.Sleep(20 * time.Millisecond)
	if len(e.list()) != 1 {
		t.Fatal("pruned with forever retention")
	}
	cs := enabled
	cs.RetentionDays = 7
	e.update(cs)
	eventually(t, "pruned", func() bool { return len(e.list()) == 0 })
}

func TestDeleteClearPinAndFiles(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	ctx := context.Background()
	for i, w := range []int{1, 2, 3} {
		n := e.ev.count(core.EventClipboardAdded)
		e.src.send(t, change{Kind: core.ClipImage, Bytes: pngBytes(w, 1)})
		eventually(t, "added", func() bool { return e.ev.count(core.EventClipboardAdded) > n })
		_ = i
	}
	e.recordText("txt")
	items := e.list()
	if len(items) != 4 || len(dirFiles(t, e.dir)) != 3 {
		t.Fatalf("items=%d files=%v", len(items), dirFiles(t, e.dir))
	}
	var img core.ClipItem
	for _, it := range items {
		if it.Kind == core.ClipImage {
			img = it
			break
		}
	}
	pinned, err := e.h.Pin(ctx, img.ID, true)
	if err != nil || !pinned.Pinned {
		t.Fatalf("pin: %+v %v", pinned, err)
	}
	if last := e.ev.all(core.EventClipboardAdded); !last[len(last)-1].(core.ClipItem).Pinned {
		t.Fatal("pin should emit added with updated item")
	}
	if _, err := e.h.Pin(ctx, "nope", true); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("pin unknown: %v", err)
	}
	var other core.ClipItem
	for _, it := range items {
		if it.Kind == core.ClipImage && it.ID != img.ID {
			other = it
			break
		}
	}
	if err := e.h.Delete(ctx, []string{other.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(other.ImagePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("image file not removed on delete")
	}
	if n, err := e.h.Clear(ctx, true); err != nil || n != 2 {
		t.Fatalf("clear keepPinned = %d %v", n, err)
	}
	if got := dirFiles(t, e.dir); len(got) != 1 || got[0] != img.ID+".png" {
		t.Fatalf("files = %v", got)
	}
	if n, err := e.h.Clear(ctx, false); err != nil || n != 1 {
		t.Fatalf("clear all = %d %v", n, err)
	}
	if len(dirFiles(t, e.dir)) != 0 || e.ev.count(core.EventClipboardRemoved) != 3 {
		t.Fatalf("files=%v removed events=%d", dirFiles(t, e.dir), e.ev.count(core.EventClipboardRemoved))
	}
}

func TestRemoveImageStaysInsideDir(t *testing.T) {
	e := newEnv(t, enabled)
	outside := filepath.Join(t.TempDir(), "keep.png")
	if err := os.WriteFile(outside, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.h.removeImage(core.ClipItem{ImagePath: outside})
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("deleted a file outside the clipboard dir")
	}
}

func TestImageDataURL(t *testing.T) {
	e := newEnv(t, enabled)
	e.start()
	e.waitRecording()
	ctx := context.Background()
	data := pngBytes(2, 2)
	e.src.send(t, change{Kind: core.ClipImage, Bytes: data})
	eventually(t, "item", func() bool { return len(e.list()) == 1 })
	img := e.list()[0]
	url, err := e.h.ImageDataURL(ctx, img.ID)
	if err != nil || !strings.HasPrefix(url, "data:image/png;base64,") || len(url) < 30 {
		t.Fatalf("url = %.40q err=%v", url, err)
	}
	e.recordText("t")
	var txt core.ClipItem
	for _, it := range e.list() {
		if it.Kind == core.ClipText {
			txt = it
		}
	}
	if _, err := e.h.ImageDataURL(ctx, txt.ID); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("text item: %v", err)
	}
	if _, err := e.h.ImageDataURL(ctx, "nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	os.Remove(img.ImagePath)
	if _, err := e.h.ImageDataURL(ctx, img.ID); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("missing file: %v", err)
	}
}

func TestStopLeavesNoGoroutines(t *testing.T) {
	e := newEnv(t, enabled)
	e.h.Start(context.Background())
	e.waitRecording()
	e.recordText("x")
	done := make(chan struct{})
	go func() { e.h.Stop(); e.h.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop hung")
	}
	fakeDone := make(chan struct{})
	go func() { e.src.wg.Wait(); close(fakeDone) }()
	select {
	case <-fakeDone:
	case <-time.After(3 * time.Second):
		t.Fatal("watch goroutine still running")
	}
	if e.h.State().Recording {
		t.Fatal("still recording after Stop")
	}
}

func TestParentContextCancelStops(t *testing.T) {
	e := newEnv(t, enabled)
	ctx, cancel := context.WithCancel(context.Background())
	e.h.Start(ctx)
	e.waitRecording()
	cancel()
	e.h.Stop() // waits for goroutines
	if e.h.State().Recording {
		t.Fatal("still recording")
	}
}

func TestPopupOpener(t *testing.T) {
	e := newEnv(t, enabled)
	if err := e.h.OpenPopup(); err == nil {
		t.Fatal("expected error without opener")
	}
	called := false
	e.h.SetPopupOpener(func() error { called = true; return nil })
	if err := e.h.OpenPopup(); err != nil || !called {
		t.Fatal("opener not called")
	}
}
