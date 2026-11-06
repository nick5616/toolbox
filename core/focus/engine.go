package focus

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"toolbox/core"
)

// errDenied is what a Platform wraps when the OS refused to stop a process
// (elevated or protected). The engine reports it as "runs as administrator".
var errDenied = errors.New("access denied")

type pkey struct {
	pid     uint32
	created int64
}

type seenEntry struct {
	info     ProcInfo
	v        Verdict
	goneAt   int64 // clock ms; 0 while running
	existing bool  // was already running when the watch started
}

// watcher is the loop's per-run state: one per session (or per learn run).
type watcher struct {
	seen    map[pkey]*seenEntry
	byPID   map[uint32]*seenEntry
	toolbox map[uint32]int64
	initial bool // the first tick decides what is already running
	resumed bool // a session resumed after a restart: OnStart isn't re-applied
	learn   bool
	rules   []AllowRule // learn mode's rules (Always allowed + last profile)
	failed  int

	pending      map[pkey]bool // asked to close, waiting for StillOpenAfter
	pendingAt    int64
	failedPaths  map[string]bool
	unknownNames map[string]bool
}

func newWatcher(self ProcInfo) *watcher {
	w := &watcher{
		seen: map[pkey]*seenEntry{}, byPID: map[uint32]*seenEntry{}, toolbox: map[uint32]int64{},
		initial: true, pending: map[pkey]bool{}, failedPaths: map[string]bool{}, unknownNames: map[string]bool{},
	}
	if self.PID != 0 {
		w.toolbox[self.PID] = self.Created
	}
	return w
}

// Lookup implements Ancestry.
func (w *watcher) Lookup(pid uint32) (ProcInfo, Verdict, bool) {
	if e, ok := w.byPID[pid]; ok {
		return e.info, e.v, true
	}
	return ProcInfo{}, Verdict{}, false
}

const seenCap = 20000
const seenKeepGone = 60 * 1000

// Engine owns the focus session, the enforcement loop and learn mode.
type Engine struct {
	o Options

	mu           sync.Mutex
	settings     Settings
	session      *Session
	last         *Session
	w            *watcher
	stillOpen    []OpenApp
	friction     *Friction
	quitReleased bool
	self         ProcInfo
	interactive  uint32
	sysRoot      string

	root       context.Context
	rootCancel context.CancelFunc
	loopCancel context.CancelFunc
	wg         sync.WaitGroup
	tickMu     sync.Mutex
	manual     bool // tests drive ticks themselves

	notifyMu sync.Mutex
	subs     map[int]func(State)
	nextSub  int
}

// New builds an Engine; nothing runs until Start.
func New(o Options) *Engine {
	if o.Clock == nil {
		o.Clock = time.Now
	}
	if o.Platform == nil {
		o.Platform = NewPlatform()
	}
	e := &Engine{o: o, settings: DefaultSettings(), subs: map[int]func(State){}}
	e.root, e.rootCancel = context.WithCancel(context.Background())
	return e
}

func (e *Engine) nowMs() int64 { return e.o.Clock().UnixMilli() }

func (e *Engine) supported() error { return e.o.Platform.Supported() }

// Start loads settings, prunes old events, resumes an active session
// (SPEC.md §2.5) and starts learn mode when it is on.
func (e *Engine) Start(ctx context.Context) error {
	e.mu.Lock()
	if e.root.Err() != nil {
		e.root, e.rootCancel = context.WithCancel(context.Background())
	}
	e.self = e.o.Platform.Self()
	e.interactive = e.o.Platform.InteractiveSession()
	e.sysRoot = e.o.Platform.SystemRoot()
	e.mu.Unlock()

	if s, ok, err := e.o.Store.GetSettings(ctx); err != nil {
		return fmt.Errorf("loading Focus settings: %w", err)
	} else if ok {
		e.mu.Lock()
		e.settings = normalizeSettings(s)
		e.mu.Unlock()
	}
	now := e.nowMs()
	_ = e.o.Store.PruneEvents(ctx, now-int64(EventsKeepDays)*24*3600*1000, EventsKeepRows)

	if e.supported() != nil {
		e.notify()
		return nil
	}
	if last, err := e.o.Store.RecentSessions(ctx, 1); err == nil && len(last) > 0 {
		e.mu.Lock()
		e.last = &last[0]
		e.mu.Unlock()
	}
	active, err := e.o.Store.ActiveSession(ctx)
	if err != nil {
		return fmt.Errorf("loading the Focus session: %w", err)
	}
	e.mu.Lock()
	if active != nil {
		if now >= active.EndsAt {
			e.session = active
			e.endLocked(EndTime)
		} else {
			e.session = active
			e.startWatchLocked(false, true)
		}
	} else if e.settings.Learn {
		e.startWatchLocked(true, false)
	}
	e.mu.Unlock()
	e.notify()
	return nil
}

// Stop stops the loop. The active session stays in the store (it resumes at
// the next Start).
func (e *Engine) Stop() {
	e.mu.Lock()
	e.rootCancel()
	if e.loopCancel != nil {
		e.loopCancel()
		e.loopCancel = nil
	}
	e.w = nil
	e.mu.Unlock()
	e.wg.Wait()
}

func (e *Engine) dryLocked() bool {
	return e.o.DryRun || (e.session != nil && e.session.DryRun)
}

// State is what the UI shows.
func (e *Engine) State() State {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stateLocked()
}

func (e *Engine) stateLocked() State {
	st := State{
		Supported: true, OS: OS(), DryRun: e.dryLocked(), Learn: e.settings.Learn,
		StillOpen: append([]OpenApp{}, e.stillOpen...), QuitReleased: e.quitReleased,
	}
	if err := e.supported(); err != nil {
		st.Supported = false
		st.Unsupported = err.Error()
		if ae := core.AsAppError(err); ae != nil {
			st.Unsupported = ae.Message
		}
	}
	if e.session != nil {
		c := cloneSession(*e.session)
		st.Session = &c
	}
	if e.last != nil {
		c := cloneSession(*e.last)
		st.Last = &c
	}
	if e.friction != nil {
		f := *e.friction
		if f.Rule != nil {
			r := *f.Rule
			f.Rule = &r
		}
		st.Friction = &f
	}
	return st
}

func cloneRules(r []AllowRule) []AllowRule { return append([]AllowRule{}, r...) }

func cloneSession(s Session) Session {
	s.Profile.Rules = cloneRules(s.Profile.Rules)
	s.Always = cloneRules(s.Always)
	s.Extra = cloneRules(s.Extra)
	s.Launched = cloneRules(s.Launched)
	return s
}

// notify sends the current State to the emitter and subscribers.
func (e *Engine) notify() {
	e.notifyMu.Lock()
	defer e.notifyMu.Unlock()
	e.mu.Lock()
	st := e.stateLocked()
	subs := make([]func(State), 0, len(e.subs))
	ids := make([]int, 0, len(e.subs))
	for id := range e.subs {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		subs = append(subs, e.subs[id])
	}
	e.mu.Unlock()
	if e.o.Emit != nil {
		e.o.Emit(EventChanged, st)
	}
	for _, fn := range subs {
		fn(st)
	}
}

// Subscribe calls fn (from the engine's goroutine; never block) whenever the
// State changes. It returns the unsubscribe function.
func (e *Engine) Subscribe(fn func(State)) (unsubscribe func()) {
	e.mu.Lock()
	id := e.nextSub
	e.nextSub++
	e.subs[id] = fn
	e.mu.Unlock()
	return func() {
		e.mu.Lock()
		delete(e.subs, id)
		e.mu.Unlock()
	}
}

// ---- watching --------------------------------------------------------------

// startWatchLocked (re)starts the loop with a fresh watcher.
func (e *Engine) startWatchLocked(learn, resumed bool) {
	if e.loopCancel != nil {
		e.loopCancel()
		e.loopCancel = nil
	}
	w := newWatcher(e.self)
	w.learn, w.resumed = learn, resumed
	if learn {
		w.rules = e.learnRulesLocked()
	}
	e.w = w
	if e.manual || e.root.Err() != nil {
		return
	}
	ctx, cancel := context.WithCancel(e.root)
	e.loopCancel = cancel
	e.wg.Add(1)
	go e.loop(ctx, w)
}

func (e *Engine) stopWatchLocked() {
	if e.loopCancel != nil {
		e.loopCancel()
		e.loopCancel = nil
	}
	e.w = nil
}

func (e *Engine) learnRulesLocked() []AllowRule {
	rules := cloneRules(e.settings.AlwaysAllowed)
	if id := e.settings.LastProfileID; id != "" {
		if ps, err := e.o.Store.Profiles(context.Background()); err == nil {
			for _, p := range ps {
				if p.ID == id {
					rules = append(rules, p.Rules...)
				}
			}
		}
	}
	return rules
}

func (e *Engine) pollInterval() time.Duration {
	e.mu.Lock()
	ms := e.settings.PollMs
	e.mu.Unlock()
	ms = clampInt(ms, MinPollMs, MaxPollMs)
	if runtime.GOOS == "darwin" && ms > 500 {
		ms = 500
	}
	return time.Duration(ms) * time.Millisecond
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

const kickGap = 50 * time.Millisecond

func (e *Engine) loop(ctx context.Context, w *watcher) {
	defer e.wg.Done()
	kicks := e.o.Platform.Kicks(ctx)
	timer := time.NewTimer(0)
	defer timer.Stop()
	var lastTick time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case _, ok := <-kicks:
			if !ok {
				kicks = nil
				continue
			}
			// Coalesce: at most one tick per kickGap.
			wait := kickGap - time.Since(lastTick)
			if wait < 0 {
				wait = 0
			}
			timer.Reset(wait)
			continue
		}
		e.tick(ctx, w)
		if ctx.Err() != nil {
			return
		}
		e.mu.Lock()
		alive := e.w == w
		e.mu.Unlock()
		if !alive {
			return
		}
		lastTick = time.Now()
		timer.Reset(e.pollInterval())
	}
}

// tickNow runs one tick synchronously (tests).
func (e *Engine) tickNow() {
	e.mu.Lock()
	w := e.w
	e.mu.Unlock()
	if w != nil {
		e.tick(context.Background(), w)
	}
}

func (w *watcher) insert(ent *seenEntry) {
	k := pkey{ent.info.PID, ent.info.Created}
	w.seen[k] = ent
	w.byPID[ent.info.PID] = ent
}

func (w *watcher) prune(now int64) {
	for k, ent := range w.seen {
		if ent.goneAt > 0 && now-ent.goneAt > seenKeepGone {
			delete(w.seen, k)
			if w.byPID[k.pid] == ent {
				delete(w.byPID, k.pid)
			}
		}
	}
	if len(w.seen) > seenCap {
		gone := []*seenEntry{}
		for _, ent := range w.seen {
			if ent.goneAt > 0 {
				gone = append(gone, ent)
			}
		}
		sort.Slice(gone, func(i, j int) bool { return gone[i].goneAt < gone[j].goneAt })
		for _, ent := range gone {
			if len(w.seen) <= seenCap {
				break
			}
			k := pkey{ent.info.PID, ent.info.Created}
			delete(w.seen, k)
			if w.byPID[k.pid] == ent {
				delete(w.byPID, k.pid)
			}
		}
	}
}

func (e *Engine) policyLocked(w *watcher) *SessionPolicy {
	pol := &SessionPolicy{Self: e.self, Session: e.interactive, SystemRoot: e.sysRoot, ToolboxPIDs: w.toolbox}
	if w.learn || e.session == nil {
		pol.Rules = w.rules
		return pol
	}
	s := e.session
	pol.Rules = append(append(cloneRules(s.Always), s.Profile.Rules...), s.Extra...)
	pol.Launched = s.Launched
	return pol
}

// safeToStop is the last guard before anything is closed or terminated.
func (e *Engine) safeToStopLocked(p ProcInfo, w *watcher) bool {
	if e.dryLocked() || w == nil || w.learn || e.session == nil {
		return false
	}
	if p.PID == 0 || p.Session != e.interactive || p.PID == e.self.PID {
		return false
	}
	if c, ok := w.toolbox[p.PID]; ok && c == p.Created {
		return false
	}
	if e.o.Scope != nil && !e.o.Scope(p) {
		return false
	}
	if path := segments(p.Path); p.Path != "" {
		if isSystemPath(path, e.sysRoot) {
			return false
		}
		for _, x := range WindowsExtras() {
			if underFolder(segments(expandVars(x)), path) {
				return false
			}
		}
	}
	return true
}

type stopAction struct {
	p   ProcInfo
	key pkey
}

func (e *Engine) tick(ctx context.Context, w *watcher) {
	e.tickMu.Lock()
	defer e.tickMu.Unlock()
	if ctx.Err() != nil {
		return
	}
	e.mu.Lock()
	if e.w != w {
		e.mu.Unlock()
		return
	}
	if !w.learn && e.session != nil && e.nowMs() >= e.session.EndsAt {
		e.endLocked(EndTime)
		e.mu.Unlock()
		e.notify()
		return
	}
	interactive := e.interactive
	e.mu.Unlock()

	procs, err := e.o.Platform.Snapshot(ctx)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		e.mu.Lock()
		ended := false
		if e.w == w {
			w.failed++
			if w.failed >= FailedTicksToEnd {
				if !w.learn && e.session != nil {
					e.endLocked(EndError)
					ended = true
				} else {
					w.failed = 0
				}
			}
		}
		e.mu.Unlock()
		if ended {
			e.notify()
		}
		return
	}

	alive := make(map[pkey]bool, len(procs))
	var fresh []ProcInfo
	for _, p := range procs {
		if p.Session != interactive {
			continue
		}
		if e.o.Scope != nil && !e.o.Scope(p) {
			continue
		}
		k := pkey{p.PID, p.Created}
		alive[k] = true
		if _, ok := w.seen[k]; !ok {
			fresh = append(fresh, p)
		}
	}
	sort.Slice(fresh, func(i, j int) bool {
		if fresh[i].Created != fresh[j].Created {
			return fresh[i].Created < fresh[j].Created
		}
		return fresh[i].PID < fresh[j].PID
	})
	if len(fresh) > 0 {
		e.o.Platform.Paths(fresh)
	}

	e.mu.Lock()
	if e.w != w {
		e.mu.Unlock()
		return
	}
	w.failed = 0
	now := e.nowMs()
	for k, ent := range w.seen {
		if ent.goneAt == 0 && !alive[k] {
			ent.goneAt = now
			if c, ok := w.toolbox[k.pid]; ok && c == k.created && k.pid != e.self.PID {
				delete(w.toolbox, k.pid) // a reused PID is a new program
			}
		}
	}
	dry := e.dryLocked()
	closeMode := !w.learn && !w.resumed && e.session != nil && e.session.OnStart == OnStartClose
	var windows map[uint32]bool
	if w.initial && closeMode {
		e.mu.Unlock()
		windows = e.o.Platform.Windows()
		e.mu.Lock()
		if e.w != w {
			e.mu.Unlock()
			return
		}
	}
	pol := e.policyLocked(w)
	sessionID := ""
	if !w.learn && e.session != nil {
		sessionID = e.session.ID
	}
	var events []BlockEvent
	var terminate, ask []stopAction
	for _, p := range fresh {
		ent := &seenEntry{info: p, existing: w.initial}
		w.insert(ent)
		v := Decide(p, pol, w)
		ent.v = v
		if v.Reason == "toolbox" {
			w.toolbox[p.PID] = p.Created
		}
		if v.Allow {
			if v.Reason == "unknown" && !w.initial && !w.learn && !w.unknownNames[p.Name] {
				w.unknownNames[p.Name] = true
				events = append(events, BlockEvent{SessionID: sessionID, At: now, Path: p.Path, Name: p.Name, Result: ResultUnknown})
			}
			continue
		}
		k := pkey{p.PID, p.Created}
		switch {
		case w.learn:
			if !w.initial {
				events = append(events, BlockEvent{At: now, Path: p.Path, Name: p.Name, Result: ResultWouldStop})
			}
		case w.initial:
			if closeMode && windows[p.PID] {
				if dry {
					events = append(events, BlockEvent{SessionID: sessionID, At: now, Path: p.Path, Name: p.Name, Result: ResultWouldStop})
				} else if e.safeToStopLocked(p, w) {
					ask = append(ask, stopAction{p, k})
				}
			}
		case dry:
			events = append(events, BlockEvent{SessionID: sessionID, At: now, Path: p.Path, Name: p.Name, Result: ResultWouldStop})
		case e.safeToStopLocked(p, w):
			terminate = append(terminate, stopAction{p, k})
		}
	}
	w.initial = false
	if len(ask) > 0 && w.pendingAt == 0 {
		w.pendingAt = now + StillOpenAfter.Milliseconds()
	}
	// Previously listed apps that exited drop off.
	changed := false
	if len(e.stillOpen) > 0 {
		kept := e.stillOpen[:0]
		for _, a := range e.stillOpen {
			if alive[pkey{a.PID, a.Created}] {
				kept = append(kept, a)
			}
		}
		if len(kept) != len(e.stillOpen) {
			changed = true
		}
		e.stillOpen = kept
	}
	// Apps asked to close that are still open after StillOpenAfter.
	if len(w.pending) > 0 && w.pendingAt > 0 && now >= w.pendingAt {
		for k := range w.pending {
			if ent, ok := w.seen[k]; ok && alive[k] {
				e.stillOpen = append(e.stillOpen, OpenApp{PID: k.pid, Created: k.created, Name: ent.info.Name, Path: ent.info.Path})
			}
		}
		sort.Slice(e.stillOpen, func(i, j int) bool { return e.stillOpen[i].Created < e.stillOpen[j].Created })
		w.pending = map[pkey]bool{}
		w.pendingAt = 0
		changed = true
	}
	w.prune(now)
	e.mu.Unlock()

	// Stop things without holding the lock (a polite quit can take seconds).
	for _, a := range terminate {
		events = append(events, e.doTerminate(w, a, sessionID, now))
	}
	for _, a := range ask {
		if ev, ok := e.doAsk(w, a, sessionID, now); ok {
			events = append(events, ev)
		}
	}
	events = compactEvents(events)
	e.record(w, sessionID, events, changed || len(ask) > 0)
}

func compactEvents(evs []BlockEvent) []BlockEvent {
	out := evs[:0]
	for _, ev := range evs {
		if ev.Result != "" {
			out = append(out, ev)
		}
	}
	return out
}

func denyMessage(err error) string {
	if errors.Is(err, errDenied) {
		return "It runs as administrator"
	}
	return err.Error()
}

func (e *Engine) doTerminate(w *watcher, a stopAction, sessionID string, now int64) BlockEvent {
	ev := BlockEvent{SessionID: sessionID, At: now, Path: a.p.Path, Name: a.p.Name}
	err := e.o.Platform.Terminate(a.p)
	switch {
	case err == nil:
		ev.Result = ResultStopped
	case errors.Is(err, ErrGone):
		return BlockEvent{} // it left by itself
	default:
		ev.Result, ev.Error = ResultFailed, denyMessage(err)
		e.mu.Lock()
		dup := w.failedPaths[a.p.Path]
		w.failedPaths[a.p.Path] = true
		e.mu.Unlock()
		if dup {
			return BlockEvent{}
		}
	}
	return ev
}

func (e *Engine) doAsk(w *watcher, a stopAction, sessionID string, now int64) (BlockEvent, bool) {
	ev := BlockEvent{SessionID: sessionID, At: now, Path: a.p.Path, Name: a.p.Name}
	asked, err := e.o.Platform.AskToClose(a.p)
	switch {
	case errors.Is(err, ErrGone):
		return ev, false
	case err != nil:
		ev.Result, ev.Error = ResultFailed, denyMessage(err)
		e.mu.Lock()
		w.pending[a.key] = true // still listed after the wait, so the user can Force close
		e.mu.Unlock()
		return ev, true
	case !asked:
		return ev, false // windowless: left alone
	}
	ev.Result = ResultClosed
	e.mu.Lock()
	w.pending[a.key] = true
	e.mu.Unlock()
	return ev, true
}

// record stores events, bumps the session's count and notifies.
func (e *Engine) record(w *watcher, sessionID string, events []BlockEvent, changed bool) {
	if len(events) > 0 {
		_ = e.o.Store.AddEvents(context.Background(), events)
		e.mu.Lock()
		if e.w == w && e.session != nil && !w.learn {
			for _, ev := range events {
				switch ev.Result {
				case ResultStopped, ResultClosed, ResultWouldStop:
					e.session.Blocked++
				}
			}
			_ = e.o.Store.PutSession(context.Background(), *e.session)
		}
		e.mu.Unlock()
		if e.o.Emit != nil {
			for _, ev := range events {
				e.o.Emit(EventBlocked, ev)
			}
		}
		changed = true
	}
	if changed {
		e.notify()
	}
}

// ---- sessions --------------------------------------------------------------

func validStrength(s Strength) bool {
	return s == StrengthSoft || s == StrengthFirm || s == StrengthStrict
}

// Begin starts a session; CodeActive when one is on.
func (e *Engine) Begin(req StartRequest) (Session, error) {
	if err := e.supported(); err != nil {
		return Session{}, err
	}
	ctx := context.Background()
	e.mu.Lock()
	if e.session != nil {
		e.mu.Unlock()
		return Session{}, core.Errorf(CodeActive, "A focus session is already on").WithHint("End it or extend it instead.")
	}
	settings := e.settings
	e.mu.Unlock()

	now := e.nowMs()
	var endsAt int64
	switch {
	case req.Until > 0:
		d := req.Until - now
		if d > int64(MaxMinutes)*60000 {
			return Session{}, core.Errorf(CodeTooLong, "A session can last 12 hours at most")
		}
		if d < 60000 {
			return Session{}, core.ValidationError("Pick a time at least a minute ahead", map[string]string{"until": "Pick a time at least a minute ahead"})
		}
		endsAt = req.Until
	case req.Minutes > MaxMinutes:
		return Session{}, core.Errorf(CodeTooLong, "A session can last 12 hours at most")
	case req.Minutes < 1:
		return Session{}, core.ValidationError("Pick how long to focus", map[string]string{"minutes": "Pick how long to focus"})
	default:
		endsAt = now + int64(req.Minutes)*60000
	}
	strength := req.Strength
	if strength == "" {
		strength = settings.DefaultStrength
	}
	if !validStrength(strength) {
		return Session{}, core.ValidationError("Pick soft, firm or strict", map[string]string{"strength": "Pick soft, firm or strict"})
	}
	onStart := req.OnStart
	if onStart == "" {
		onStart = settings.OnStart
	}
	if onStart != OnStartClose && onStart != OnStartLeave {
		return Session{}, core.ValidationError("Pick close or leave", map[string]string{"onStart": "Pick close or leave"})
	}
	if len(req.Extra) > MaxExtra {
		return Session{}, core.ValidationError("Too many extra apps", map[string]string{"extra": "At most 20 extra apps"})
	}
	extra := []AllowRule{}
	for _, r := range req.Extra {
		if r.ID == "" {
			r.ID = core.NewID()
		}
		if err := CheckRule(r); err != nil {
			return Session{}, err
		}
		extra = append(extra, r)
	}
	profiles, err := e.o.Store.Profiles(ctx)
	if err != nil {
		return Session{}, fmt.Errorf("loading Focus profiles: %w", err)
	}
	var prof *Profile
	for i := range profiles {
		if profiles[i].ID == req.ProfileID {
			prof = &profiles[i]
		}
	}
	if prof == nil {
		return Session{}, core.Errorf(core.CodeNotFound, "That Focus profile no longer exists")
	}

	s := Session{
		ID: core.NewID(), Profile: *prof, Always: cloneRules(settings.AlwaysAllowed), Extra: extra, Launched: []AllowRule{},
		Strength: strength, OnStart: onStart, StartedAt: now, EndsAt: endsAt, RunID: req.RunID, StepID: req.StepID,
		DryRun: e.o.DryRun,
	}
	s.Profile.Rules = cloneRules(prof.Rules)

	e.mu.Lock()
	if e.session != nil { // lost a race
		e.mu.Unlock()
		return Session{}, core.Errorf(CodeActive, "A focus session is already on")
	}
	if err := e.o.Store.PutSession(ctx, s); err != nil {
		e.mu.Unlock()
		return Session{}, fmt.Errorf("saving the Focus session: %w", err)
	}
	e.session = &s
	e.friction = nil
	e.quitReleased = false
	e.stillOpen = nil
	e.settings.LastProfileID = prof.ID
	if req.Minutes > 0 {
		e.settings.LastMinutes = req.Minutes
	}
	_ = e.o.Store.PutSettings(ctx, e.settings)
	e.startWatchLocked(false, false)
	out := cloneSession(s)
	e.mu.Unlock()
	e.notify()
	return out, nil
}

// endLocked ends the active session and starts learn mode if it is on.
func (e *Engine) endLocked(reason string) {
	s := e.session
	if s == nil {
		return
	}
	end := e.nowMs()
	if reason == EndTime {
		end = s.EndsAt
	}
	s.EndedAt, s.EndReason = end, reason
	_ = e.o.Store.PutSession(context.Background(), *s)
	c := cloneSession(*s)
	e.last = &c
	e.session = nil
	e.friction = nil
	e.stillOpen = nil
	e.quitReleased = false
	e.stopWatchLocked()
	if e.settings.Learn && e.supported() == nil {
		e.startWatchLocked(true, false)
	}
}

func (e *Engine) activeLocked() (*Session, error) {
	if e.session == nil {
		return nil, core.Errorf(CodeNotActive, "No focus session is on")
	}
	return e.session, nil
}

// Extend moves the end later by minutes (1–720), never past 12 h from the start.
func (e *Engine) Extend(minutes int) (Session, error) {
	if minutes < 1 || minutes > MaxMinutes {
		return Session{}, core.ValidationError("Extend by 1 to 720 minutes", map[string]string{"minutes": "Extend by 1 to 720 minutes"})
	}
	e.mu.Lock()
	s, err := e.activeLocked()
	if err != nil {
		e.mu.Unlock()
		return Session{}, err
	}
	limit := s.StartedAt + int64(MaxMinutes)*60000
	if s.EndsAt >= limit {
		e.mu.Unlock()
		return Session{}, core.Errorf(CodeTooLong, "A session can last 12 hours at most")
	}
	s.EndsAt = min(s.EndsAt+int64(minutes)*60000, limit)
	_ = e.o.Store.PutSession(context.Background(), *s)
	out := cloneSession(*s)
	e.mu.Unlock()
	e.notify()
	return out, nil
}

// ExtendTo moves the end to until (Unix ms) when that is later; never earlier.
func (e *Engine) ExtendTo(until int64) (Session, error) {
	e.mu.Lock()
	s, err := e.activeLocked()
	if err != nil {
		e.mu.Unlock()
		return Session{}, err
	}
	limit := s.StartedAt + int64(MaxMinutes)*60000
	until = min(until, limit)
	if until <= s.EndsAt {
		out := cloneSession(*s)
		e.mu.Unlock()
		return out, nil
	}
	s.EndsAt = until
	_ = e.o.Store.PutSession(context.Background(), *s)
	out := cloneSession(*s)
	e.mu.Unlock()
	e.notify()
	return out, nil
}

// RequestWeaken starts the friction for a weakening action (SPEC.md §2.3).
func (e *Engine) RequestWeaken(a Weaken, rule *AllowRule) (Friction, error) {
	e.mu.Lock()
	s, err := e.activeLocked()
	if err != nil {
		e.mu.Unlock()
		return Friction{}, err
	}
	switch a {
	case WeakenEnd, WeakenAllow, WeakenQuit, WeakenEmergency:
	default:
		e.mu.Unlock()
		return Friction{}, core.Errorf(core.CodeValidation, "Unknown action")
	}
	if s.Strength == StrengthStrict && a != WeakenEmergency {
		e.mu.Unlock()
		return Friction{}, core.Errorf(core.CodeConflict, "This session is strict").
			WithHint("Only Emergency unlock can end it.")
	}
	var r *AllowRule
	if a == WeakenAllow {
		if rule == nil {
			e.mu.Unlock()
			return Friction{}, core.ValidationError("Pick an app to allow", map[string]string{"rule": "Pick an app to allow"})
		}
		c := *rule
		if c.ID == "" {
			c.ID = core.NewID()
		}
		if err := CheckRule(c); err != nil {
			e.mu.Unlock()
			return Friction{}, err
		}
		r = &c
	}
	if f := e.friction; f != nil && f.Action == a && (a != WeakenAllow || (f.Rule != nil && r != nil && f.Rule.Path == r.Path && f.Rule.Kind == r.Kind)) {
		out := *f // the countdown keeps running
		e.mu.Unlock()
		return out, nil
	}
	now := e.nowMs()
	f := &Friction{Action: a, ReadyAt: now, Rule: r}
	switch {
	case a == WeakenEmergency && s.Strength == StrengthStrict:
		f.Phrase, f.ReadyAt = Phrase, now+EmergencyWait.Milliseconds()
	case s.Strength == StrengthSoft:
	default:
		f.Phrase, f.ReadyAt = Phrase, now+FirmCountdown.Milliseconds()
	}
	e.friction = f
	out := *f
	e.mu.Unlock()
	e.notify()
	return out, nil
}

var spaceRe = strings.NewReplacer("’", "'", "‘", "'", "ʼ", "'")

func normPhrase(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(spaceRe.Replace(s)), " "))
}

// ConfirmWeaken checks the phrase and the countdown, then acts.
func (e *Engine) ConfirmWeaken(a Weaken, phrase string) error {
	e.mu.Lock()
	if _, err := e.activeLocked(); err != nil {
		e.mu.Unlock()
		return err
	}
	f := e.friction
	if f == nil || f.Action != a {
		e.mu.Unlock()
		return core.Errorf(core.CodeConflict, "Start that action first")
	}
	if e.nowMs() < f.ReadyAt {
		e.mu.Unlock()
		return core.Errorf(CodeCountdown, "Wait for the countdown to finish")
	}
	if f.Phrase != "" && normPhrase(phrase) != normPhrase(f.Phrase) {
		e.mu.Unlock()
		return core.Errorf(CodePhrase, "That doesn't match the phrase").WithHint(`Type: ` + f.Phrase)
	}
	e.friction = nil
	switch a {
	case WeakenEnd:
		e.endLocked(EndUser)
	case WeakenEmergency:
		e.endLocked(EndEmergency)
	case WeakenAllow:
		if f.Rule != nil {
			e.session.Extra = append(e.session.Extra, *f.Rule)
			_ = e.o.Store.PutSession(context.Background(), *e.session)
		}
	case WeakenQuit:
		e.quitReleased = true
	}
	e.mu.Unlock()
	e.notify()
	return nil
}

// CancelWeaken drops a friction in progress.
func (e *Engine) CancelWeaken() {
	e.mu.Lock()
	had := e.friction != nil
	e.friction = nil
	e.mu.Unlock()
	if had {
		e.notify()
	}
}

// EndFor ends the session for a pipeline's End step: only a session runID
// started, or any soft one; CodeNotYours otherwise. No session = nil.
func (e *Engine) EndFor(runID string) error {
	e.mu.Lock()
	s := e.session
	if s == nil {
		e.mu.Unlock()
		return nil
	}
	if !(runID != "" && s.RunID == runID) && s.Strength != StrengthSoft {
		e.mu.Unlock()
		return core.Errorf(CodeNotYours, "Another focus session is on").
			WithHint("This pipeline didn't start it, so it can't end it.")
	}
	e.endLocked(EndPipeline)
	e.mu.Unlock()
	e.notify()
	return nil
}

// ---- apps still open --------------------------------------------------------

func (e *Engine) stillInfoLocked(pid uint32, created int64) (ProcInfo, bool) {
	listed := false
	for _, a := range e.stillOpen {
		if a.PID == pid && a.Created == created {
			listed = true
		}
	}
	if !listed || e.w == nil {
		return ProcInfo{}, false
	}
	ent, ok := e.w.seen[pkey{pid, created}]
	if !ok {
		return ProcInfo{}, false
	}
	return ent.info, true
}

func (e *Engine) dropStillLocked(pid uint32, created int64) {
	kept := e.stillOpen[:0]
	for _, a := range e.stillOpen {
		if !(a.PID == pid && a.Created == created) {
			kept = append(kept, a)
		}
	}
	e.stillOpen = kept
}

// CloseAgain asks a still-open app to close again.
func (e *Engine) CloseAgain(pid uint32, created int64) error {
	e.mu.Lock()
	p, ok := e.stillInfoLocked(pid, created)
	safe := ok && e.safeToStopLocked(p, e.w)
	e.mu.Unlock()
	if !ok {
		return core.Errorf(core.CodeNotFound, "That app isn't in the list any more")
	}
	if !safe {
		return nil
	}
	_, err := e.o.Platform.AskToClose(p)
	if errors.Is(err, ErrGone) {
		e.mu.Lock()
		e.dropStillLocked(pid, created)
		e.mu.Unlock()
		e.notify()
		return nil
	}
	if err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't ask %s to close", p.Name).WithHint(denyMessage(err))
	}
	return nil
}

// ForceClose terminates a still-open app (the user clicked Force close).
func (e *Engine) ForceClose(pid uint32, created int64) error {
	e.mu.Lock()
	p, ok := e.stillInfoLocked(pid, created)
	safe := ok && e.safeToStopLocked(p, e.w)
	w := e.w
	sessionID := ""
	if e.session != nil {
		sessionID = e.session.ID
	}
	e.mu.Unlock()
	if !ok {
		return core.Errorf(core.CodeNotFound, "That app isn't in the list any more")
	}
	if !safe {
		return nil
	}
	err := e.o.Platform.Terminate(p)
	if err != nil && !errors.Is(err, ErrGone) {
		e.record(w, sessionID, []BlockEvent{{SessionID: sessionID, At: e.nowMs(), Path: p.Path, Name: p.Name, Result: ResultFailed, Error: denyMessage(err)}}, true)
		return core.Errorf(core.CodeToolFailed, "Couldn't close %s", p.Name).WithHint(denyMessage(err))
	}
	e.mu.Lock()
	e.dropStillLocked(pid, created)
	e.mu.Unlock()
	if err == nil {
		e.record(w, sessionID, []BlockEvent{{SessionID: sessionID, At: e.nowMs(), Path: p.Path, Name: p.Name, Result: ResultStopped}}, true)
	} else {
		e.notify()
	}
	return nil
}

// LeaveOpen drops a still-open app from the list and leaves it running.
func (e *Engine) LeaveOpen(pid uint32, created int64) {
	e.mu.Lock()
	e.dropStillLocked(pid, created)
	e.mu.Unlock()
	e.notify()
}

// NoteLaunch records an app Toolbox launched (Open in app) in the active
// session, so it stays allowed after a restart. No-op when idle.
func (e *Engine) NoteLaunch(path string) {
	if strings.TrimSpace(path) == "" {
		return
	}
	e.mu.Lock()
	s := e.session
	if s == nil {
		e.mu.Unlock()
		return
	}
	r := AllowRule{ID: core.NewID(), Kind: RuleExe, Path: path, Children: true}
	r.Label = filepath.Base(path)
	if runtime.GOOS == "darwin" || style.mac {
		if i := strings.Index(path, ".app"); i >= 0 {
			r.Kind, r.Path = RuleFolder, path[:i+4]
			r.Label = filepath.Base(r.Path)
		}
	}
	r.Label = strings.TrimSuffix(strings.TrimSuffix(r.Label, ".exe"), ".app")
	for _, l := range s.Launched {
		if l.Kind == r.Kind && strings.EqualFold(l.Path, r.Path) {
			e.mu.Unlock()
			return
		}
	}
	s.Launched = append(s.Launched, r)
	_ = e.o.Store.PutSession(context.Background(), *s)
	e.mu.Unlock()
	e.notify()
}

// Resumed re-checks the session's end against the wall clock now (power resume).
func (e *Engine) Resumed() {
	e.mu.Lock()
	ended := false
	if e.session != nil && e.nowMs() >= e.session.EndsAt {
		e.endLocked(EndTime)
		ended = true
	}
	e.mu.Unlock()
	if ended {
		e.notify()
	}
}

// ---- learn mode -------------------------------------------------------------

// SetLearn turns learn mode on or off.
func (e *Engine) SetLearn(on bool) error {
	if on {
		if err := e.supported(); err != nil {
			return err
		}
	}
	e.mu.Lock()
	e.applyLearnLocked(on)
	err := e.o.Store.PutSettings(context.Background(), e.settings)
	e.mu.Unlock()
	e.notify()
	return err
}

func (e *Engine) applyLearnLocked(on bool) {
	if on == e.settings.Learn {
		return
	}
	e.settings.Learn = on
	if on {
		e.settings.LearnSince = e.nowMs()
		if e.session == nil {
			e.startWatchLocked(true, false)
		}
	} else if e.session == nil {
		e.stopWatchLocked()
	}
}

// LearnList lists learn mode's would-stop programs since learn mode started.
func (e *Engine) LearnList() ([]LearnEntry, error) {
	e.mu.Lock()
	since := e.settings.LearnSince
	e.mu.Unlock()
	return e.o.Store.LearnEntries(context.Background(), since)
}

// IgnoreLearn forgets a program's learn entries ("" = all).
func (e *Engine) IgnoreLearn(path string) error {
	return e.o.Store.ClearLearn(context.Background(), path)
}

// ---- profiles and settings --------------------------------------------------

// Profiles lists the saved profiles by name.
func (e *Engine) Profiles() ([]Profile, error) {
	ps, err := e.o.Store.Profiles(context.Background())
	if err != nil {
		return nil, err
	}
	return ps, nil
}

func errProfile(msg string, fields map[string]string) error {
	ae := core.Errorf(CodeProfile, "%s", msg)
	ae.Fields = fields
	return ae
}

// SaveProfile validates and stores a profile (new when ID is ""); CodeProfile
// or a validation error naming the bad rule.
func (e *Engine) SaveProfile(p Profile) (Profile, error) {
	ctx := context.Background()
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" || len(p.Rules) == 0 {
		return Profile{}, errProfile("A profile needs a name and at least one app", map[string]string{"name": "Give the profile a name", "rules": "Add at least one app"})
	}
	if len([]rune(p.Name)) > MaxProfileName {
		return Profile{}, errProfile("Profile names are 40 characters at most", map[string]string{"name": "40 characters at most"})
	}
	if len(p.Rules) > MaxRules {
		return Profile{}, errProfile("A profile holds 100 apps at most", map[string]string{"rules": "100 apps at most"})
	}
	rules := make([]AllowRule, 0, len(p.Rules))
	for i, r := range p.Rules {
		if r.ID == "" {
			r.ID = core.NewID()
		}
		r.Label = strings.TrimSpace(r.Label)
		if err := CheckRule(r); err != nil {
			if ae := core.AsAppError(err); ae != nil {
				ae.Message = fmt.Sprintf("%s: %s", labelOr(r, i), ae.Message)
				return Profile{}, ae
			}
			return Profile{}, err
		}
		rules = append(rules, r)
	}
	p.Rules = rules
	existing, err := e.o.Store.Profiles(ctx)
	if err != nil {
		return Profile{}, err
	}
	now := e.nowMs()
	p.UpdatedAt = now
	p.CreatedAt = now
	for _, o := range existing {
		if o.ID != p.ID && strings.EqualFold(o.Name, p.Name) {
			return Profile{}, core.ValidationError("A profile with that name already exists", map[string]string{"name": "That name is taken"})
		}
		if o.ID == p.ID {
			p.CreatedAt = o.CreatedAt
		}
	}
	if p.ID == "" {
		p.ID = core.NewID()
	}
	if err := e.o.Store.PutProfile(ctx, p); err != nil {
		return Profile{}, err
	}
	e.refreshLearnRules()
	return p, nil
}

// refreshLearnRules rebuilds learn mode's rules after a profile changed.
func (e *Engine) refreshLearnRules() {
	e.mu.Lock()
	if e.w != nil && e.w.learn {
		e.w.rules = e.learnRulesLocked()
	}
	e.mu.Unlock()
}

func labelOr(r AllowRule, i int) string {
	if r.Label != "" {
		return r.Label
	}
	return fmt.Sprintf("App %d", i+1)
}

// DeleteProfile deletes a profile (an active session keeps its snapshot).
func (e *Engine) DeleteProfile(id string) error {
	if err := e.o.Store.DeleteProfile(context.Background(), id); err != nil {
		return err
	}
	defer e.refreshLearnRules()
	e.mu.Lock()
	if e.settings.LastProfileID == id {
		e.settings.LastProfileID = ""
		_ = e.o.Store.PutSettings(context.Background(), e.settings)
	}
	e.mu.Unlock()
	return nil
}

func normalizeSettings(s Settings) Settings {
	if s.AlwaysAllowed == nil {
		s.AlwaysAllowed = []AllowRule{}
	}
	if !validStrength(s.DefaultStrength) {
		s.DefaultStrength = StrengthFirm
	}
	if s.OnStart != OnStartClose && s.OnStart != OnStartLeave {
		s.OnStart = OnStartClose
	}
	if s.PollMs == 0 {
		s.PollMs = DefaultPollMs
	}
	s.PollMs = clampInt(s.PollMs, MinPollMs, MaxPollMs)
	if s.LastMinutes < 1 || s.LastMinutes > MaxMinutes {
		s.LastMinutes = DefaultMinutes
	}
	return s
}

// Settings returns the standing settings.
func (e *Engine) Settings() Settings {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.settings
	s.AlwaysAllowed = cloneRules(s.AlwaysAllowed)
	return s
}

// SaveSettings validates and stores the settings. Always-allowed edits never
// change an active session (it holds a snapshot).
func (e *Engine) SaveSettings(s Settings) (Settings, error) {
	if len(s.AlwaysAllowed) > MaxRules {
		return Settings{}, core.ValidationError("Always allowed holds 100 apps at most", map[string]string{"alwaysAllowed": "100 apps at most"})
	}
	rules := make([]AllowRule, 0, len(s.AlwaysAllowed))
	for i, r := range s.AlwaysAllowed {
		if r.ID == "" {
			r.ID = core.NewID()
		}
		r.Label = strings.TrimSpace(r.Label)
		if err := CheckRule(r); err != nil {
			if ae := core.AsAppError(err); ae != nil {
				ae.Message = fmt.Sprintf("%s: %s", labelOr(r, i), ae.Message)
				return Settings{}, ae
			}
			return Settings{}, err
		}
		rules = append(rules, r)
	}
	s.AlwaysAllowed = rules
	s = normalizeSettings(s)
	if s.Learn {
		if err := e.supported(); err != nil {
			return Settings{}, err
		}
	}
	e.mu.Lock()
	learn, since := s.Learn, e.settings.LearnSince
	s.LearnSince = since
	s.Learn = e.settings.Learn
	e.settings = s
	e.applyLearnLocked(learn)
	if e.w != nil && e.w.learn {
		e.w.rules = e.learnRulesLocked()
	}
	out := e.settings
	err := e.o.Store.PutSettings(context.Background(), out)
	out.AlwaysAllowed = cloneRules(out.AlwaysAllowed)
	e.mu.Unlock()
	e.notify()
	if err != nil {
		return Settings{}, err
	}
	return out, nil
}

// ---- reports ----------------------------------------------------------------

// Blocked groups the active (or last) session's events by program, newest first.
func (e *Engine) Blocked(limit int) ([]BlockedApp, error) {
	e.mu.Lock()
	id := ""
	if e.session != nil {
		id = e.session.ID
	} else if e.last != nil {
		id = e.last.ID
	}
	e.mu.Unlock()
	if id == "" {
		return []BlockedApp{}, nil
	}
	evs, err := e.o.Store.Events(context.Background(), id, 2000)
	if err != nil {
		return nil, err
	}
	out := []BlockedApp{}
	idx := map[string]int{}
	for _, ev := range evs { // newest first
		if ev.Result == ResultUnknown {
			continue
		}
		i, ok := idx[ev.Path]
		if !ok {
			idx[ev.Path] = len(out)
			out = append(out, BlockedApp{Path: ev.Path, Name: ev.Name, Count: 1, Last: ev.At, Result: ev.Result, Error: ev.Error})
			continue
		}
		out[i].Count++
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// Recent lists ended sessions, newest first.
func (e *Engine) Recent(limit int) ([]Session, error) {
	return e.o.Store.RecentSessions(context.Background(), limit)
}
