package focus

import (
	"context"
	"os"
	"sort"
	"sync"
	"testing"
	"time"
)

// Tests use Windows-style paths unless a test flips the style itself.
func TestMain(m *testing.M) {
	style = pathStyle{windows: true}
	os.Exit(m.Run())
}

// ---- fake clock --------------------------------------------------------------

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)} }

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

// ---- fake platform -------------------------------------------------------------

type fakePlatform struct {
	mu      sync.Mutex
	procs   []ProcInfo
	paths   map[uint32]string
	windows map[uint32]bool
	snapErr error
	self    ProcInfo
	session uint32
	root    string
	kicks   chan struct{}

	terminated  []ProcInfo
	asked       []ProcInfo
	pathCalls   map[uint32]int
	termErr     map[uint32]error
	staysOpen   map[uint32]bool // AskToClose doesn't make it quit
	unsupported error
	askGate     chan struct{} // when set, AskToClose blocks until it is closed
}

func newFake() *fakePlatform {
	return &fakePlatform{
		paths: map[uint32]string{}, windows: map[uint32]bool{}, pathCalls: map[uint32]int{},
		termErr: map[uint32]error{}, staysOpen: map[uint32]bool{},
		self:    ProcInfo{PID: 100, Created: 1000, Session: 1, Name: "toolbox.exe", Path: `C:\Toolbox\toolbox.exe`},
		session: 1, root: `C:\Windows`, kicks: make(chan struct{}, 1),
	}
}

// add puts a process in the snapshot.
func (f *fakePlatform) add(pid, ppid uint32, created int64, path string) ProcInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	name := path
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '\\' {
			name = path[i+1:]
			break
		}
	}
	p := ProcInfo{PID: pid, ParentPID: ppid, Created: created, Session: f.session, Name: name}
	f.procs = append(f.procs, p)
	f.paths[pid] = path
	return p
}

func (f *fakePlatform) remove(pid uint32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.procs[:0]
	for _, p := range f.procs {
		if p.PID != pid {
			out = append(out, p)
		}
	}
	f.procs = out
}

func (f *fakePlatform) Snapshot(ctx context.Context) ([]ProcInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.snapErr != nil {
		return nil, f.snapErr
	}
	return append([]ProcInfo{f.selfInfo()}, f.procs...), nil
}

func (f *fakePlatform) selfInfo() ProcInfo {
	s := f.self
	s.Path = ""
	return s
}

func (f *fakePlatform) Paths(ps []ProcInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range ps {
		f.pathCalls[ps[i].PID]++
		if ps[i].PID == f.self.PID {
			ps[i].Path = f.self.Path
			continue
		}
		ps[i].Path = f.paths[ps[i].PID]
	}
}

func (f *fakePlatform) Windows() map[uint32]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[uint32]bool{}
	for k, v := range f.windows {
		out[k] = v
	}
	return out
}

func (f *fakePlatform) Terminate(p ProcInfo) error {
	f.mu.Lock()
	f.terminated = append(f.terminated, p)
	err := f.termErr[p.PID]
	f.mu.Unlock()
	if err != nil {
		return err
	}
	f.remove(p.PID)
	return nil
}

func (f *fakePlatform) AskToClose(p ProcInfo) (bool, error) {
	f.mu.Lock()
	f.asked = append(f.asked, p)
	has := f.windows[p.PID]
	stays := f.staysOpen[p.PID]
	gate := f.askGate
	f.mu.Unlock()
	if gate != nil {
		<-gate // a slow quit
	}
	if has && !stays {
		f.remove(p.PID)
	}
	return has, nil
}

func (f *fakePlatform) Self() ProcInfo             { return f.self }
func (f *fakePlatform) InteractiveSession() uint32 { return f.session }
func (f *fakePlatform) SystemRoot() string         { return f.root }
func (f *fakePlatform) Supported() error           { return f.unsupported }
func (f *fakePlatform) Kicks(ctx context.Context) <-chan struct{} {
	return f.kicks
}

func (f *fakePlatform) terminatedPIDs() []uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []uint32{}
	for _, p := range f.terminated {
		out = append(out, p.PID)
	}
	return out
}

func (f *fakePlatform) askedPIDs() []uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []uint32{}
	for _, p := range f.asked {
		out = append(out, p.PID)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] }) // asks run concurrently
	return out
}

// ---- in-memory store -----------------------------------------------------------

type memStore struct {
	mu       sync.Mutex
	profiles map[string]Profile
	sessions map[string]Session
	events   []BlockEvent
	settings *Settings
	pruned   [][2]int64
}

func newMemStore() *memStore {
	return &memStore{profiles: map[string]Profile{}, sessions: map[string]Session{}}
}

func (m *memStore) Profiles(context.Context) ([]Profile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Profile{}
	for _, p := range m.profiles {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
func (m *memStore) PutProfile(_ context.Context, p Profile) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.profiles[p.ID] = p
	return nil
}
func (m *memStore) DeleteProfile(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.profiles, id)
	return nil
}
func (m *memStore) ActiveSession(context.Context) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var best *Session
	for _, s := range m.sessions {
		s := s
		if s.EndedAt == 0 && (best == nil || s.StartedAt > best.StartedAt) {
			best = &s
		}
	}
	return best, nil
}
func (m *memStore) PutSession(_ context.Context, s Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[s.ID] = cloneSession(s)
	return nil
}
func (m *memStore) RecentSessions(_ context.Context, limit int) ([]Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Session{}
	for _, s := range m.sessions {
		if s.EndedAt > 0 {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt > out[j].StartedAt })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
func (m *memStore) AddEvents(_ context.Context, evs []BlockEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, evs...)
	return nil
}
func (m *memStore) Events(_ context.Context, id string, limit int) ([]BlockEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []BlockEvent{}
	for i := len(m.events) - 1; i >= 0; i-- {
		if m.events[i].SessionID == id {
			out = append(out, m.events[i])
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
func (m *memStore) LearnEntries(_ context.Context, since int64) ([]LearnEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	by := map[string]*LearnEntry{}
	order := []string{}
	for _, e := range m.events {
		if e.SessionID != "" || e.Result != ResultWouldStop || e.At < since {
			continue
		}
		le, ok := by[e.Path]
		if !ok {
			le = &LearnEntry{Path: e.Path, Name: e.Name}
			by[e.Path] = le
			order = append(order, e.Path)
		}
		le.Count++
		if e.At > le.LastSeen {
			le.LastSeen = e.At
		}
	}
	res := []LearnEntry{}
	for _, p := range order {
		res = append(res, *by[p])
	}
	return res, nil
}
func (m *memStore) ClearLearn(_ context.Context, path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	kept := m.events[:0]
	for _, e := range m.events {
		if e.SessionID == "" && e.Result == ResultWouldStop && (path == "" || e.Path == path) {
			continue
		}
		kept = append(kept, e)
	}
	m.events = kept
	return nil
}
func (m *memStore) PruneEvents(_ context.Context, before int64, keep int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruned = append(m.pruned, [2]int64{before, int64(keep)})
	return nil
}
func (m *memStore) GetSettings(context.Context) (Settings, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.settings == nil {
		return Settings{}, false, nil
	}
	return *m.settings, true, nil
}
func (m *memStore) PutSettings(_ context.Context, s Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := s
	m.settings = &c
	return nil
}

func (m *memStore) eventsFor(id string) []BlockEvent {
	evs, _ := m.Events(context.Background(), id, 0)
	return evs
}

// ---- harness -------------------------------------------------------------------

type harness struct {
	e     *Engine
	fp    *fakePlatform
	clock *fakeClock
	st    *memStore
	prof  Profile
}

const liveExe = `C:\Apps\Live\live.exe`

// newHarness builds a manual-tick engine (no goroutines) with one profile that
// allows liveExe, started and idle.
func newHarness(t *testing.T, dry bool) *harness {
	t.Helper()
	t.Setenv("ProgramFiles", `C:\Program Files`)
	t.Setenv("ProgramFiles(x86)", `C:\Program Files (x86)`)
	t.Setenv("LOCALAPPDATA", `C:\Users\me\AppData\Local`)
	t.Setenv("USERPROFILE", `C:\Users\me`)
	h := &harness{fp: newFake(), clock: newClock(), st: newMemStore()}
	h.e = New(Options{Platform: h.fp, Store: h.st, Clock: h.clock.Now, DryRun: dry})
	h.e.manual = true
	t.Cleanup(h.e.Stop)
	if err := h.e.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	p, err := h.e.SaveProfile(Profile{Name: "Music", Rules: []AllowRule{
		{Label: "Live", Kind: RuleExe, Path: liveExe, Children: true},
		{Label: "Code", Kind: RuleFolder, Path: `%LOCALAPPDATA%\Programs\Microsoft VS Code`, Children: true},
	}})
	if err != nil {
		t.Fatal(err)
	}
	h.prof = p
	return h
}

func (h *harness) begin(t *testing.T, strength Strength, minutes int) Session {
	t.Helper()
	s, err := h.e.Begin(StartRequest{ProfileID: h.prof.ID, Minutes: minutes, Strength: strength, OnStart: OnStartClose})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
