package mediaindex

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"toolbox/core"
)

// Index is Smart search's index (SPEC.md Part A): the scanner, the scheduler,
// the vectors and labels, and the query.
type Index struct {
	cfg Config

	rootCtx    context.Context // cancelled by Close
	rootCancel context.CancelFunc
	runCtx     context.Context // from Start's ctx (nil before Start)
	wg         sync.WaitGroup

	mu       sync.Mutex
	settings core.SearchSettings
	excluded []string
	started  bool
	closed   bool

	// scheduler state (mu)
	wake         chan struct{}
	stopObserve  func()
	inflight     *inflight
	latest       map[string]core.Job // last snapshot of our running jobs
	finished     map[string]core.Job // terminal snapshots of our jobs
	solo         []string            // paths to retry one at a time
	force        map[string]bool     // speech: ignore the length cap
	addedQ       map[string]bool
	rescanReq    bool
	projDue      time.Time
	projDirty    bool
	backoffUntil time.Time
	waiting      bool
	lastError    string
	reconciled   bool
	labelsBusy   bool
	labelsRetry  time.Time
	recomputing  bool

	// status events (mu)
	lastEmit    time.Time
	emitTimer   *time.Timer
	bytesAt     time.Time
	bytesCached int64

	// warming query vectors (mu)
	warming  map[string]bool
	lastWarm time.Time

	vec     vecIndex
	labels  labelCache
	vocOnce sync.Once
	voc     *vocab
	vocErr  error

	// Test knobs.
	firstDelay  time.Duration // first reconcile after Start (60 s)
	tickEvery   time.Duration // scheduler re-check (15 s)
	userWait    time.Duration // a waiting user job cancels speech after this (20 s)
	failPause   time.Duration // pause after a failed job (30 s)
	matrixLimit int64
	nowFn       func() time.Time
}

// New makes an Index. Nothing runs until Start.
func New(cfg Config) *Index {
	ctx, cancel := context.WithCancel(context.Background())
	return &Index{
		cfg: cfg, settings: core.DefaultSearchSettings(),
		rootCtx: ctx, rootCancel: cancel,
		wake: make(chan struct{}, 1), latest: map[string]core.Job{}, finished: map[string]core.Job{},
		force: map[string]bool{}, addedQ: map[string]bool{}, warming: map[string]bool{},
		firstDelay: 60 * time.Second, tickEvery: 15 * time.Second, userWait: 20 * time.Second, failPause: 30 * time.Second,
		matrixLimit: DefaultMatrixCap,
	}
}

func (ix *Index) clock() time.Time {
	if ix.nowFn != nil {
		return ix.nowFn()
	}
	return time.Now()
}

func (ix *Index) matrixCapBytes() int64 { return ix.matrixLimit }

// bg is the context background work runs in.
func (ix *Index) bg() context.Context {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.runCtx != nil {
		return ix.runCtx
	}
	return ix.rootCtx
}

// signal wakes the scheduler loop (never blocks).
func (ix *Index) signal() {
	select {
	case ix.wake <- struct{}{}:
	default:
	}
}

// Start loads the settings and starts the scheduler goroutine (it reconciles
// the library, a stat walk, 60 s later) and returns at once; everything stops
// when ctx ends or Close is called.
func (ix *Index) Start(ctx context.Context) error {
	ix.mu.Lock()
	if ix.started || ix.closed {
		ix.mu.Unlock()
		return nil
	}
	ix.started = true
	ix.runCtx = ctx
	ix.mu.Unlock()

	s := ix.loadSettings(ctx)
	ix.mu.Lock()
	ix.settings = s
	ix.mu.Unlock()

	if ix.cfg.Jobs != nil {
		stop := ix.cfg.Jobs.Observe(ix.onJob)
		ix.mu.Lock()
		ix.stopObserve = stop
		ix.mu.Unlock()
	}
	ix.wg.Add(1)
	go func() {
		defer ix.wg.Done()
		ix.loop(ctx)
	}()
	return nil
}

// Close stops the scheduler and drops the in-memory matrix.
func (ix *Index) Close() {
	ix.mu.Lock()
	if ix.closed {
		ix.mu.Unlock()
		return
	}
	ix.closed = true
	stop, timer := ix.stopObserve, ix.emitTimer
	ix.stopObserve, ix.emitTimer = nil, nil
	ix.mu.Unlock()
	if stop != nil {
		stop()
	}
	if timer != nil {
		timer.Stop()
	}
	ix.rootCancel()
	ix.wg.Wait()
	ix.vec.drop()
}

func (ix *Index) isClosed() bool {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	return ix.closed
}

// ---- settings --------------------------------------------------------------

func (ix *Index) loadSettings(ctx context.Context) core.SearchSettings {
	s := core.DefaultSearchSettings()
	raw, ok, err := ix.cfg.Store.GetSetting(ctx, SettingsKey)
	if err == nil && ok && raw != "" {
		_ = json.Unmarshal([]byte(raw), &s)
	}
	if s.SpeechMaxMin < 1 || s.SpeechMaxMin > 600 {
		s.SpeechMaxMin = core.DefaultSearchSettings().SpeechMaxMin
	}
	if s.Skip == nil {
		s.Skip = []string{}
	}
	return s
}

// Settings implements core.MediaIndex.
func (ix *Index) Settings() core.SearchSettings {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	s := ix.settings
	s.Skip = append([]string{}, s.Skip...)
	return s
}

var driveRe = regexp.MustCompile(`^[A-Za-z]:`)

// cleanSkip validates one skip entry: library-relative and inside the library.
func cleanSkip(s string) (string, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, `\`, "/"))
	if s == "" {
		return "", nil
	}
	if strings.HasPrefix(s, "/") || driveRe.MatchString(s) {
		return "", core.Errorf(core.CodeValidation, "Skip folders are inside the library: %q isn't", s)
	}
	var parts []string
	for _, p := range strings.Split(s, "/") {
		switch p {
		case "", ".":
		case "..":
			return "", core.Errorf(core.CodeValidation, "Skip folders stay inside the library: %q leaves it", s)
		default:
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, "/"), nil
}

// SetSettings implements core.MediaIndex.
func (ix *Index) SetSettings(ctx context.Context, s core.SearchSettings) error {
	if s.SpeechMaxMin < 1 || s.SpeechMaxMin > 600 {
		return core.Errorf(core.CodeValidation, "Transcribe automatically up to 1 to 600 minutes per file")
	}
	var skip []string
	seen := map[string]bool{}
	for _, e := range s.Skip {
		c, err := cleanSkip(e)
		if err != nil {
			return err
		}
		if c != "" && !seen[strings.ToLower(c)] {
			seen[strings.ToLower(c)] = true
			skip = append(skip, c)
		}
	}
	sort.Strings(skip)
	if skip == nil {
		skip = []string{}
	}
	s.Skip = skip
	raw, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("encode search settings: %w", err)
	}
	if err := ix.cfg.Store.SetSetting(ctx, SettingsKey, string(raw)); err != nil {
		return err
	}
	ix.mu.Lock()
	old := ix.settings
	ix.settings = s
	if (s.Enabled && !old.Enabled) || !sameStrings(old.Skip, s.Skip) {
		ix.rescanReq = true
	}
	ix.mu.Unlock()
	if s.Speech && !old.Speech {
		if _, err := ix.cfg.Store.EnableSpeech(ctx); err != nil {
			return err
		}
	}
	if s.ReadText && !old.ReadText {
		if _, err := ix.cfg.Store.MarkTextKindsPending(ctx); err != nil {
			return err
		}
	}
	ix.signal()
	ix.emitStatus()
	return nil
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ---- library hooks ---------------------------------------------------------

// Added tells the index about new or changed library files (library:added).
// It only queues them; the scheduler loop reads them from disk.
func (ix *Index) Added(paths ...string) {
	if len(paths) == 0 {
		return
	}
	ix.mu.Lock()
	if ix.closed {
		ix.mu.Unlock()
		return
	}
	for _, p := range paths {
		ix.addedQ[p] = true
	}
	ix.mu.Unlock()
	ix.signal()
}

// Removed deletes the rows of files that are gone (Trash). A file that still
// exists keeps its row.
func (ix *Index) Removed(paths ...string) {
	var gone []string
	for _, p := range paths {
		if _, err := os.Lstat(p); err != nil && os.IsNotExist(err) {
			gone = append(gone, filepath.Clean(p))
		}
	}
	if len(gone) == 0 {
		return
	}
	ids, err := ix.cfg.Store.DeleteItems(ix.bg(), gone)
	if err == nil {
		ix.matrixRemoved(ids)
		ix.emitStatus()
	}
}

// Renamed moves a row to its new path (Library Rename). A file the index
// didn't know is queued like a new one.
func (ix *Index) Renamed(from, to string) {
	ok, err := ix.cfg.Store.RenameItem(ix.bg(), filepath.Clean(from), filepath.Clean(to))
	if err == nil && !ok {
		ix.Added(to)
	}
}

// ProjectSaved tells the index a project was saved: its thumbnail is looked at
// a few seconds later (the tool writes thumb.jpg around the save).
func (ix *Index) ProjectSaved(projectID string) {
	ix.mu.Lock()
	if ix.closed {
		ix.mu.Unlock()
		return
	}
	if !ix.projDirty {
		ix.projDirty = true
		ix.projDue = ix.clock().Add(3 * time.Second)
	}
	ix.mu.Unlock()
	time.AfterFunc(3100*time.Millisecond, ix.signal)
}

// ---- commands --------------------------------------------------------------

// Rescan implements core.MediaIndex: reconcile now (in the background).
func (ix *Index) Rescan() error {
	ix.mu.Lock()
	started := ix.started
	ix.rescanReq = true
	ix.mu.Unlock()
	if !started {
		_, err := ix.reconcile(ix.bg())
		return err
	}
	ix.signal()
	return nil
}

// Rebuild implements core.MediaIndex: everything becomes pending again (user
// and hidden labels are kept).
func (ix *Index) Rebuild(ctx context.Context) error {
	if err := ix.cfg.Store.MarkAllPending(ctx); err != nil {
		return err
	}
	ix.mu.Lock()
	ix.solo, ix.lastError = nil, ""
	ix.backoffUntil = time.Time{}
	ix.mu.Unlock()
	ix.signal()
	ix.emitStatus()
	return nil
}

// DeleteIndex implements core.MediaIndex: everything the index learned goes.
func (ix *Index) DeleteIndex(ctx context.Context) error {
	if err := ix.cfg.Store.DeleteAll(ctx); err != nil {
		return err
	}
	ix.vec.drop()
	ix.mu.Lock()
	ix.solo, ix.lastError = nil, ""
	ix.force = map[string]bool{}
	ix.mu.Unlock()
	ix.emitStatus()
	return nil
}

// ReadAgain implements core.MediaIndex: redo a file's OCR / transcription
// (the speech cap doesn't apply).
func (ix *Index) ReadAgain(ctx context.Context, path string) error {
	path = filepath.Clean(path)
	it, ok, err := ix.cfg.Store.GetItem(ctx, path)
	if err != nil {
		return err
	}
	if !ok {
		return core.Errorf(core.CodeNotFound, "That file isn't in the search index")
	}
	if it.Kind != core.MediaKindAudio {
		if err := ix.cfg.Store.SetItemState(ctx, path, StagePictures, StatePending, "", -1); err != nil {
			return err
		}
	}
	if it.Kind == core.MediaKindAudio || it.Kind == core.MediaKindVideo {
		if err := ix.cfg.Store.SetItemState(ctx, path, StageSpeech, SpeechPending, "", -1); err != nil {
			return err
		}
		ix.mu.Lock()
		ix.force[path] = true
		ix.mu.Unlock()
	}
	ix.signal()
	ix.emitStatus()
	return nil
}

// Retry implements core.MediaIndex: failed or skipped files are tried again.
func (ix *Index) Retry(ctx context.Context, paths []string) error {
	for _, p := range paths {
		p = filepath.Clean(p)
		it, ok, err := ix.cfg.Store.GetItem(ctx, p)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		if it.State == StateFailed || it.State == StateSkipped {
			if err := ix.cfg.Store.SetItemState(ctx, p, StagePictures, StatePending, "", -1); err != nil {
				return err
			}
		}
		if it.SpeechState == SpeechFailed || it.SpeechState == SpeechSkipped {
			if err := ix.cfg.Store.SetItemState(ctx, p, StageSpeech, SpeechPending, "", -1); err != nil {
				return err
			}
			ix.mu.Lock()
			ix.force[p] = it.SpeechState == SpeechSkipped // "Transcribe now" after a length skip
			ix.mu.Unlock()
		}
	}
	ix.mu.Lock()
	ix.backoffUntil = time.Time{}
	ix.mu.Unlock()
	ix.signal()
	ix.emitStatus()
	return nil
}

// Failures implements core.MediaIndex.
func (ix *Index) Failures(ctx context.Context, limit int) ([]core.SearchFailure, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	items, err := ix.cfg.Store.Failures(ctx, limit)
	if err != nil {
		return nil, err
	}
	out := make([]core.SearchFailure, 0, len(items))
	for _, it := range items {
		f := core.SearchFailure{Path: it.Path, Reason: it.Reason, Attempts: it.Attempts, At: it.IndexedAt}
		switch {
		case it.State == StateFailed || it.State == StateSkipped:
			f.State, f.Stage = it.State, StagePictures
		default:
			f.State, f.Stage = it.SpeechState, StageSpeech
		}
		out = append(out, f)
	}
	return out, nil
}

// ---- status ---------------------------------------------------------------

// Status implements core.MediaIndex.
func (ix *Index) Status() core.SearchStatus {
	s := ix.Settings()
	ctx := ix.bg()
	st := core.SearchStatus{Enabled: s.Enabled, Paused: s.Paused, Model: ix.Model().ID}
	if ix.cfg.Installed != nil {
		st.Installed = ix.cfg.Installed()
	}
	if c, err := ix.cfg.Store.Counts(ctx); err == nil {
		st.Total, st.Done, st.Pending, st.Failed, st.Skipped = c.Total, c.Done, c.Pending, c.Failed, c.Skipped
		st.SpeechPending, st.SpeechDone = c.SpeechPending, c.SpeechDone
	}
	ix.mu.Lock()
	st.Waiting, st.LastError = ix.waiting, ix.lastError
	var cur *core.Job
	if ix.inflight != nil {
		for id := range ix.inflight.ids {
			if j, ok := ix.latest[id]; ok && j.Status == core.JobRunning {
				jj := j
				cur = &jj
				break
			}
		}
	}
	if ix.clock().Sub(ix.bytesAt) > 30*time.Second {
		ix.bytesAt = ix.clock()
		ix.mu.Unlock()
		n, err := ix.cfg.Store.IndexBytes(ctx)
		ix.mu.Lock()
		if err == nil {
			ix.bytesCached = n
		}
	}
	st.IndexBytes = ix.bytesCached
	ix.mu.Unlock()
	if cur != nil {
		st.Stage, st.Current = stageOf(*cur)
	}
	return st
}

// stageOf derives the stage and the file being worked on from a running job.
func stageOf(j core.Job) (stage, current string) {
	if j.ModuleID == SpeechModuleID {
		stage = StageSpeech
	} else {
		stage = StagePictures
		m := strings.ToLower(j.Message)
		if strings.Contains(m, "text") || strings.Contains(m, "ocr") || strings.Contains(m, "reading") {
			stage = StageText
		}
	}
	if n := len(j.Inputs); n > 0 {
		i := 0
		if j.Progress > 0 && j.Progress < 1 {
			i = min(n-1, int(j.Progress*float64(n)))
		}
		current = filepath.Base(j.Inputs[i])
	}
	return stage, current
}

// emitStatus sends search:status, at most twice a second (a trailing send
// carries the latest numbers).
func (ix *Index) emitStatus() {
	if ix.cfg.Emitter == nil {
		return
	}
	ix.mu.Lock()
	if ix.closed {
		ix.mu.Unlock()
		return
	}
	now := ix.clock()
	if now.Sub(ix.lastEmit) >= 500*time.Millisecond {
		ix.lastEmit = now
		ix.mu.Unlock()
		ix.cfg.Emitter.Emit(core.EventSearchStatus, ix.Status())
		return
	}
	if ix.emitTimer == nil {
		wait := 500*time.Millisecond - now.Sub(ix.lastEmit)
		ix.emitTimer = time.AfterFunc(wait, func() {
			ix.mu.Lock()
			ix.emitTimer = nil
			closed := ix.closed
			ix.lastEmit = ix.clock()
			ix.mu.Unlock()
			if !closed {
				ix.cfg.Emitter.Emit(core.EventSearchStatus, ix.Status())
			}
		})
	}
	ix.mu.Unlock()
}

// ---- Writer ----------------------------------------------------------------

// Model implements Writer.
func (ix *Index) Model() Model {
	if ix.cfg.Model == nil {
		return Model{}
	}
	return ix.cfg.Model()
}

var pictureTextSources = []string{core.TextSourceOCR, core.TextSourcePDF, core.TextSourceDoc}

// StoreBatch implements Writer: one transaction per batch; auto labels are
// recomputed here from the vectors.
func (ix *Index) StoreBatch(ctx context.Context, results []ItemResult) error {
	model := ix.Model()
	batch := make([]BatchItem, 0, len(results))
	vecs := make([][]VectorAt, len(results))
	for i, r := range results {
		b := BatchItem{Path: filepath.Clean(r.Path), Size: r.Size, ModMs: r.ModMs}
		switch {
		case r.Failed != "":
			b.State, b.Reason = StateFailed, r.Failed
		case r.Skipped != "":
			b.State, b.Reason = StateSkipped, r.Skipped
		default:
			b.State = StateDone
			for _, v := range r.Vectors {
				if len(v.Vec) != model.Dim {
					continue
				}
				b.Vectors = append(b.Vectors, VecRow{Pos: v.Pos, Blob: EncodeVec(Normalize(append([]float32(nil), v.Vec...)))})
				vecs[i] = append(vecs[i], v)
			}
			if len(b.Vectors) > 0 {
				b.Model = model.ID
				b.Labels = ix.autoLabels(vecs[i])
			}
			for _, t := range r.Texts {
				if t.Source == core.TextSourceOCR || t.Source == core.TextSourcePDF || t.Source == core.TextSourceDoc {
					b.Texts = append(b.Texts, t)
				}
			}
			b.TextSources = pictureTextSources
		}
		batch = append(batch, b)
	}
	ids, err := ix.cfg.Store.StoreBatch(ctx, batch)
	if err != nil {
		ix.mu.Lock()
		ix.lastError = "Indexing stopped: " + err.Error()
		ix.mu.Unlock()
		return err
	}
	rows := map[int64][]VectorAt{}
	var stored []string
	for i, id := range ids {
		if id == 0 {
			continue
		}
		stored = append(stored, batch[i].Path)
		if batch[i].State == StateDone && len(vecs[i]) > 0 {
			rows[id] = vecs[i]
		}
	}
	ix.matrixStored(ids, rows)
	if len(stored) > 0 && ix.cfg.Emitter != nil {
		ix.cfg.Emitter.Emit(core.EventSearchIndexed, core.SearchIndexed{Paths: stored})
	}
	ix.emitStatus()
	return nil
}

// StoreSpeech implements Writer.
func (ix *Index) StoreSpeech(ctx context.Context, res SpeechResult) error {
	w := SpeechWrite{Path: filepath.Clean(res.Path), Size: res.Size, ModMs: res.ModMs}
	switch {
	case res.Failed != "":
		w.State, w.Reason = SpeechFailed, res.Failed
	case res.Skipped != "":
		w.State, w.Reason = SpeechSkipped, res.Skipped
	case res.NoSpeech:
		w.State = SpeechNoSpeech
	default:
		w.State = SpeechDone
		for _, c := range res.Chunks {
			if c.Source == core.TextSourceSpeech || c.Source == core.TextSourceSubs {
				w.Chunks = append(w.Chunks, c)
			}
		}
	}
	ok, err := ix.cfg.Store.StoreSpeech(ctx, w)
	if err != nil {
		return err
	}
	if ok && ix.cfg.Emitter != nil {
		ix.cfg.Emitter.Emit(core.EventSearchIndexed, core.SearchIndexed{Paths: []string{w.Path}})
	}
	ix.emitStatus()
	return nil
}

// Current implements Writer.
func (ix *Index) Current(ctx context.Context, path string) ([]VectorAt, bool) {
	path = filepath.Clean(path)
	m := ix.Model()
	it, ok, err := ix.cfg.Store.GetItem(ctx, path)
	if err != nil || !ok || it.State != StateDone || it.Model != m.ID || m.ID == "" {
		return nil, false
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Size() != it.Size || fi.ModTime().UnixMilli() != it.ModMs {
		return nil, false
	}
	rows, err := ix.cfg.Store.ItemVectors(ctx, it.ID)
	if err != nil || len(rows) == 0 {
		return nil, false
	}
	out := make([]VectorAt, 0, len(rows))
	for _, r := range rows {
		if len(r.Blob) == 2*m.Dim {
			out = append(out, VectorAt{Pos: r.Pos, Vec: DecodeVec(r.Blob)})
		}
	}
	return out, len(out) > 0
}

// TextVector implements Writer: a query text's vector from the cache or the
// engine.
func (ix *Index) TextVector(ctx context.Context, text string) ([]float32, error) {
	text = strings.TrimSpace(text)
	if v, ok := ix.cachedTextVec(ctx, text); ok {
		return Normalize(v), nil
	}
	got, err := ix.embedTexts(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	if err := ix.cfg.Store.PutTextVector(ctx, ix.Model().ID, text, EncodeVec(got[0]), false); err != nil {
		return nil, err
	}
	return got[0], nil
}

// TextMatch implements Writer.
func (ix *Index) TextMatch(query string, texts []core.MediaText) string {
	return MatchTexts(query, texts)
}

// TranscriptsFor implements Writer.
func (ix *Index) TranscriptsFor(ctx context.Context, path string) ([]string, error) {
	if ix.cfg.TranscriptsFor == nil {
		return nil, nil
	}
	return ix.cfg.TranscriptsFor(ctx, path)
}

// SpeechMaxMin implements Writer.
func (ix *Index) SpeechMaxMin() int { return ix.Settings().SpeechMaxMin }

// Warm implements core.MediaIndex: loads the text model in the engine ahead
// of a search (at most once a minute).
func (ix *Index) Warm() {
	ix.mu.Lock()
	now := ix.clock()
	if ix.closed || now.Sub(ix.lastWarm) < time.Minute || ix.cfg.Caller == nil || !ix.conceptReadyLocked() {
		ix.mu.Unlock()
		return
	}
	ix.lastWarm = now
	ix.mu.Unlock()
	ix.wg.Add(1)
	go func() {
		defer ix.wg.Done()
		ctx, cancel := context.WithTimeout(ix.bg(), 2*time.Minute)
		defer cancel()
		_, _ = ix.embedTexts(ctx, []string{""})
	}()
}

// conceptReady reports whether concept (picture) search can run: the model
// and engine are there.
func (ix *Index) conceptReady() bool {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	return ix.conceptReadyLocked()
}

func (ix *Index) conceptReadyLocked() bool {
	if ix.cfg.Caller == nil || ix.cfg.Model == nil || ix.cfg.Model().ID == "" {
		return false
	}
	return ix.cfg.Installed != nil && ix.cfg.Installed()
}

// ---- text and labels of one file ------------------------------------------

func (ix *Index) itemFor(ctx context.Context, path string) (Item, error) {
	it, ok, err := ix.cfg.Store.GetItem(ctx, filepath.Clean(path))
	if err != nil {
		return it, err
	}
	if !ok {
		return it, core.Errorf(core.CodeNotFound, "That file isn't in the search index")
	}
	return it, nil
}

// Labels implements core.MediaIndex.
func (ix *Index) Labels(ctx context.Context, path string) ([]core.MediaLabel, error) {
	it, ok, err := ix.cfg.Store.GetItem(ctx, filepath.Clean(path))
	if err != nil || !ok {
		return []core.MediaLabel{}, err
	}
	rows, err := ix.cfg.Store.ItemLabels(ctx, it.ID)
	if err != nil {
		return nil, err
	}
	out := make([]core.MediaLabel, 0, len(rows))
	for _, r := range rows {
		if r.Source == core.LabelHidden {
			continue
		}
		d, _, _ := ix.displayFor(r.Label)
		out = append(out, core.MediaLabel{Label: r.Label, Display: d, Source: r.Source, Score: r.Score, Pos: r.Pos})
	}
	return out, nil
}

// SetUserLabel implements core.MediaIndex: on adds the user's label (or
// restores a hidden one); off hides an auto label for good, or deletes a
// user label.
func (ix *Index) SetUserLabel(ctx context.Context, path, label string, on bool) error {
	label, err := ix.normalizeUserLabel(label)
	if err != nil {
		return err
	}
	it, err := ix.itemFor(ctx, path)
	if err != nil {
		return err
	}
	if on {
		if err := ix.cfg.Store.SetLabel(ctx, it.ID, LabelRow{Label: label, Source: core.LabelUser, Score: 1, Pos: -1}); err != nil {
			return err
		}
		ix.emitStatus()
		return nil
	}
	rows, err := ix.cfg.Store.ItemLabels(ctx, it.ID)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.Label != label {
			continue
		}
		switch r.Source {
		case core.LabelUser:
			return ix.cfg.Store.DeleteLabel(ctx, it.ID, label)
		case core.LabelAuto:
			r.Source = core.LabelHidden
			return ix.cfg.Store.SetLabel(ctx, it.ID, r)
		}
	}
	return nil
}

// Texts implements core.MediaIndex.
func (ix *Index) Texts(ctx context.Context, path string) ([]core.MediaText, error) {
	it, ok, err := ix.cfg.Store.GetItem(ctx, filepath.Clean(path))
	if err != nil || !ok {
		return []core.MediaText{}, err
	}
	return ix.cfg.Store.ItemTexts(ctx, it.ID)
}

// PutText implements core.MediaTextSink: it replaces the file's chunks of that
// source. A library file the index hasn't seen yet gets its row (pending).
func (ix *Index) PutText(ctx context.Context, path, source string, chunks []core.MediaText) error {
	path = filepath.Clean(path)
	it, ok, err := ix.cfg.Store.GetItem(ctx, path)
	if err != nil {
		return err
	}
	if !ok {
		lib := ""
		if ix.cfg.LibraryDir != nil {
			lib = ix.cfg.LibraryDir()
		}
		kind, known := KindOf(path)
		if lib == "" || !known || !core.IsWithin(path, lib) {
			return nil
		}
		fi, err := os.Lstat(path)
		if err != nil || !fi.Mode().IsRegular() {
			return nil
		}
		it = buildItem(path, kind, core.SearchSourceLibrary, "", fi.Size(), fi.ModTime().UnixMilli(), ix.Settings().Speech)
		id, _, err := ix.cfg.Store.EnsureItem(ctx, it)
		if err != nil {
			return err
		}
		it.ID = id
		ix.signal()
	}
	out := make([]core.MediaText, 0, len(chunks))
	for _, c := range chunks {
		c.Source = source
		out = append(out, c)
	}
	if err := ix.cfg.Store.ReplaceText(ctx, it.ID, []string{source}, out); err != nil {
		return err
	}
	ix.emitIndexed(path)
	return nil
}

func (ix *Index) emitIndexed(paths ...string) {
	if ix.cfg.Emitter != nil {
		ix.cfg.Emitter.Emit(core.EventSearchIndexed, core.SearchIndexed{Paths: paths})
	}
}

// Hints implements core.MediaHints: the file's labels (display text,
// strongest first) and an excerpt of its text.
func (ix *Index) Hints(ctx context.Context, path string, maxChars int) ([]string, string, bool) {
	it, ok, err := ix.cfg.Store.GetItem(ctx, filepath.Clean(path))
	if err != nil || !ok || it.State != StateDone {
		return nil, "", false
	}
	var labels []string
	if rows, err := ix.cfg.Store.ItemLabels(ctx, it.ID); err == nil {
		for _, r := range rows {
			if r.Source != core.LabelHidden {
				d, _, _ := ix.displayFor(r.Label)
				labels = append(labels, d)
			}
		}
	}
	var text string
	if maxChars > 0 {
		if texts, err := ix.cfg.Store.ItemTexts(ctx, it.ID); err == nil {
			var b strings.Builder
			for _, t := range texts {
				if t.Source == core.TextSourceCaption {
					continue
				}
				for _, r := range strings.TrimSpace(t.Text) + " " {
					if b.Len() >= maxChars { // bytes ≥ runes: a safe, slightly short bound
						break
					}
					b.WriteRune(r)
				}
				if b.Len() >= maxChars {
					break
				}
			}
			text = strings.TrimSpace(b.String())
			if r := []rune(text); len(r) > maxChars {
				text = string(r[:maxChars])
			}
		}
	}
	return labels, text, true
}
