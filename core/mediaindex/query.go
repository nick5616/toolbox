package mediaindex

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"toolbox/core"
)

// Query and ranking (SPEC.md §3.6): label hits, text hits, concept hits and
// name-only hits merged into one list.

const (
	defaultLimit = 200
	maxLimit     = 500
	// SimilarStrong and SimilarGood are the cosines at which Find similar
	// calls a neighbour Strong or Good (below that, Maybe).
	SimilarStrong = 0.80
	SimilarGood   = 0.60
	maxChips      = 8
	nameLimit     = 500
)

// cand is everything known about one item for a query.
type cand struct {
	item Item

	label      bool
	labelScore float64
	labelPos   int64

	text *textHit

	concept        bool
	conceptP       float64
	conceptPos     int64
	conceptMoments []int64

	name bool
}

type winner int

const (
	winNone winner = iota
	winLabel
	winText
	winConcept
	winName
)

// resolve folds the signals into a hit (without Output, which comes later).
func (c *cand) resolve() (hit core.SearchHit, group int) {
	score, win := 0.0, winNone
	if c.label {
		score, win = c.labelScore, winLabel
	}
	if c.text != nil && c.text.score > score {
		score, win = c.text.score, winText
	}
	if c.concept && c.conceptP > score {
		score, win = c.conceptP, winConcept
	}
	hit = core.SearchHit{
		Path: c.item.Path, Source: c.item.Source, ProjectID: c.item.SourceRef, Pos: -1,
		Via: []string{}, Moments: []int64{},
	}
	if c.item.Source == core.SearchSourceProject {
		hit.Kind = core.KindImage
	} else {
		hit.Kind = core.KindForPath(c.item.Path)
	}
	if win == winNone { // a name-only hit
		hit.Strength, hit.Via = core.StrengthName, []string{"name"}
		return hit, 2
	}
	hit.Score = score
	if c.label {
		hit.Via = append(hit.Via, "label")
	}
	if c.text != nil {
		hit.Via = append(hit.Via, c.text.sources...)
	}
	if c.concept {
		hit.Via = append(hit.Via, "concept")
	}
	switch win {
	case winLabel:
		hit.Strength, hit.Pos = core.StrengthLabel, c.labelPos
		group = 0
	case winText:
		hit.Strength, hit.Pos, hit.Snippet = core.StrengthGood, c.text.pos, c.text.snippet
		if c.text.strong {
			hit.Strength = core.StrengthStrong
		}
		hit.Moments = append(hit.Moments, c.text.moments...)
		group = 1
	case winConcept:
		hit.Strength, hit.Pos = StrengthForP(c.conceptP), c.conceptPos
		hit.Moments = append(hit.Moments, c.conceptMoments...)
		group = 1
	}
	if len(hit.Moments) > maxMoments {
		hit.Moments = hit.Moments[:maxMoments]
	}
	return hit, group
}

// Query implements core.MediaIndex.
func (ix *Index) Query(ctx context.Context, q core.SearchQuery) (core.SearchPage, error) {
	page := core.SearchPage{Hits: []core.SearchHit{}, Labels: []core.LabelCount{}}
	limit := q.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	limit = min(limit, maxLimit)
	if q.Similar != "" {
		return ix.similarQuery(ctx, q, limit)
	}
	text := strings.TrimSpace(q.Text)
	var wanted []string
	for _, l := range q.Labels {
		if n, err := ix.normalizeUserLabel(l); err == nil && !contains(wanted, n) {
			wanted = append(wanted, n)
		}
	}
	if text == "" && len(wanted) == 0 {
		return page, nil
	}
	store := ix.cfg.Store
	var stats []LabelStat
	if text != "" {
		stats, _ = store.LabelStats(ctx)
		page.Labels = ix.chipRow(text, stats)
	}

	// Labels that every hit must carry.
	var restrict map[int64]float64
	if len(wanted) > 0 {
		var err error
		if restrict, err = store.ItemsWithLabels(ctx, wanted); err != nil {
			return page, err
		}
		if len(restrict) == 0 {
			return page, nil
		}
	}
	allowed := func(id int64) bool {
		if restrict == nil {
			return true
		}
		_, ok := restrict[id]
		return ok
	}
	cands := map[int64]*cand{}
	get := func(id int64) *cand {
		c := cands[id]
		if c == nil {
			c = &cand{}
			c.item.ID = id
			cands[id] = c
		}
		return c
	}

	if text == "" {
		// Chip filter only: the items carrying every label.
		pos := map[int64]int64{}
		if rows, err := store.LabelRows(ctx, wanted[0]); err == nil {
			for _, r := range rows {
				pos[r.ItemID] = r.Pos
			}
		}
		for id, score := range restrict {
			c := get(id)
			c.label, c.labelScore = true, score
			c.labelPos = -1
			if p, ok := pos[id]; ok {
				c.labelPos = p
			}
		}
	} else {
		lt := strings.ToLower(text)
		// 1. exact label / user-label hits (score 1)
		for _, lbl := range ix.exactLabels(lt, stats) {
			rows, err := store.LabelRows(ctx, lbl)
			if err != nil {
				continue
			}
			for _, r := range rows {
				if allowed(r.ItemID) {
					c := get(r.ItemID)
					c.label, c.labelScore, c.labelPos = true, 1, r.Pos
				}
			}
		}
		// 2. text hits
		th, err := ix.textSearch(ctx, text)
		if err != nil {
			return page, err
		}
		for id, h := range th {
			if allowed(id) {
				get(id).text = h
			}
		}
		// 3. concept hits
		if len([]rune(text)) >= 2 && ix.conceptReady() {
			ix.conceptHits(ctx, text, &page, allowed, get)
		}
	}

	// Resolve items.
	ids := make([]int64, 0, len(cands))
	for id := range cands {
		ids = append(ids, id)
	}
	items, err := store.ItemsByIDs(ctx, ids)
	if err != nil {
		return page, err
	}
	for id, c := range cands {
		it, ok := items[id]
		if !ok {
			delete(cands, id)
			continue
		}
		c.item = it
	}
	// 4. name-only hits
	if text != "" && !strings.ContainsAny(text, `"`) {
		frag := strings.ToLower(text)
		if rows, err := store.NameMatches(ctx, frag, nameLimit); err == nil {
			for _, it := range rows {
				if !strings.Contains(strings.ToLower(filepath.Base(it.Path)), frag) || !allowed(it.ID) {
					continue
				}
				if _, have := cands[it.ID]; !have {
					c := &cand{item: it, name: true}
					cands[it.ID] = c
				}
			}
		}
	}

	page.Hits = ix.rank(ctx, cands, q.Filter, limit)
	return page, nil
}

// exactLabels lists the label ids the typed text names exactly.
func (ix *Index) exactLabels(lt string, stats []LabelStat) []string {
	var out []string
	add := func(l string) {
		if !contains(out, l) {
			out = append(out, l)
		}
	}
	if v, err := ix.vocabulary(); err == nil {
		if i, ok := v.byID[lt]; ok {
			add(v.entries[i].ID)
		}
		if i, ok := v.byID[strings.ReplaceAll(lt, " ", "-")]; ok {
			add(v.entries[i].ID)
		}
		if i, ok := v.byName[lt]; ok {
			add(v.entries[i].ID)
		}
	}
	norm := strings.Join(strings.Fields(lt), " ")
	for _, s := range stats {
		if s.Label == norm {
			add(s.Label)
		}
	}
	return out
}

// conceptHits scores the text vector against the matrix. A text vector that
// isn't cached yet is computed in the background (page.Warming).
func (ix *Index) conceptHits(ctx context.Context, text string, page *core.SearchPage, allowed func(int64) bool, get func(int64) *cand) {
	vec, ok := ix.cachedTextVec(ctx, text)
	if !ok {
		page.Warming = true
		ix.warmText(text)
		return
	}
	m := ix.Model()
	rows, err := ix.scoreVectors(ctx, [][]float32{Normalize(vec)}, float32(MinCos(m, MaybeP)), 0)
	if err != nil {
		return
	}
	page.Concept = true
	for _, is := range foldByItem(rows, maxMoments) {
		if !allowed(is.item) {
			continue
		}
		p := ProbFromCos(m, float64(is.cos))
		if p < MaybeP {
			continue
		}
		c := get(is.item)
		c.concept, c.conceptP, c.conceptPos, c.conceptMoments = true, p, is.pos, is.moments
	}
}

// warmText embeds a query text in the background and announces it.
func (ix *Index) warmText(text string) {
	ix.mu.Lock()
	if ix.warming[text] || ix.closed {
		ix.mu.Unlock()
		return
	}
	ix.warming[text] = true
	ix.mu.Unlock()
	ix.wg.Add(1)
	go func() {
		defer ix.wg.Done()
		ctx, cancel := context.WithTimeout(ix.bg(), 3*time.Minute)
		defer cancel()
		_, err := ix.TextVector(ctx, text)
		ix.mu.Lock()
		delete(ix.warming, text)
		ix.mu.Unlock()
		if err == nil && ix.cfg.Emitter != nil {
			ix.cfg.Emitter.Emit(core.EventSearchReady, core.SearchReady{Text: text})
		}
	}()
}

// chipRow lists labels whose display starts with the text (≤ 8, most used first).
func (ix *Index) chipRow(text string, stats []LabelStat) []core.LabelCount {
	lt := strings.ToLower(strings.TrimSpace(text))
	byLabel := make(map[string]LabelStat, len(stats))
	for _, s := range stats {
		byLabel[s.Label] = s
	}
	var out []core.LabelCount
	seen := map[string]bool{}
	if v, err := ix.vocabulary(); err == nil {
		for _, e := range v.entries {
			s, ok := byLabel[e.ID]
			if !ok || s.Count == 0 || !strings.HasPrefix(strings.ToLower(e.Display), lt) {
				continue
			}
			seen[e.ID] = true
			out = append(out, core.LabelCount{Label: e.ID, Display: e.Display, Category: e.Category, Count: s.Count, Cover: s.Cover})
		}
	}
	for _, s := range stats {
		if seen[s.Label] || !strings.HasPrefix(s.Label, lt) {
			continue
		}
		if _, _, inVocab := ix.displayFor(s.Label); inVocab {
			continue
		}
		out = append(out, core.LabelCount{Label: s.Label, Display: s.Label, Count: s.Count, User: true, Cover: s.Cover})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Display < out[j].Display
	})
	if len(out) > maxChips {
		out = out[:maxChips]
	}
	if out == nil {
		out = []core.LabelCount{}
	}
	return out
}

// ---- filters, ordering and output -------------------------------------------

// rank orders candidates (label hits, scored hits, name-only hits), applies
// the filters and fills Output for the ones returned.
func (ix *Index) rank(ctx context.Context, cands map[int64]*cand, f core.LibraryQuery, limit int) []core.SearchHit {
	type ranked struct {
		hit   core.SearchHit
		group int
		mod   int64
	}
	all := make([]ranked, 0, len(cands))
	for _, c := range cands {
		if !ix.passesCheap(c.item, f) {
			continue
		}
		h, g := c.resolve()
		all = append(all, ranked{h, g, c.item.ModMs})
	}
	sort.Slice(all, func(i, j int) bool {
		a, b := all[i], all[j]
		switch {
		case a.group != b.group:
			return a.group < b.group
		case a.hit.Score != b.hit.Score:
			return a.hit.Score > b.hit.Score
		case a.mod != b.mod:
			return a.mod > b.mod
		}
		return a.hit.Path < b.hit.Path
	})
	needOutputs := f.ModuleID != "" || f.Since != 0 || f.Until != 0
	outs := map[string]*core.Output{}
	if needOutputs {
		outs = ix.outputsFor(ctx, rankedPaths(len(all), func(i int) core.SearchHit { return all[i].hit }))
	}
	hits := make([]core.SearchHit, 0, min(limit, len(all)))
	for _, r := range all {
		if needOutputs && !passesOutput(r.hit, r.mod, outs[r.hit.Path], f) {
			continue
		}
		hits = append(hits, r.hit)
		if len(hits) >= limit {
			break
		}
	}
	if !needOutputs {
		outs = ix.outputsFor(ctx, rankedPaths(len(hits), func(i int) core.SearchHit { return hits[i] }))
	}
	for i := range hits {
		if o := outs[hits[i].Path]; o != nil && hits[i].Source == core.SearchSourceLibrary {
			hits[i].Output = o
			hits[i].Kind = o.Kind
		}
	}
	return hits
}

func rankedPaths(n int, at func(int) core.SearchHit) []string {
	var paths []string
	for i := 0; i < n; i++ {
		if h := at(i); h.Source == core.SearchSourceLibrary {
			paths = append(paths, h.Path)
		}
	}
	return paths
}

// outputsFor resolves library paths to their registered outputs.
func (ix *Index) outputsFor(ctx context.Context, paths []string) map[string]*core.Output {
	out := map[string]*core.Output{}
	if ix.cfg.Outputs == nil || len(paths) == 0 {
		return out
	}
	for len(paths) > 0 {
		n := min(400, len(paths))
		if m, err := ix.cfg.Outputs(ctx, paths[:n]); err == nil {
			for p, o := range m {
				if o != nil {
					out[p] = o
				}
			}
		}
		paths = paths[n:]
	}
	return out
}

// passesCheap applies the filters that need only the row: kinds, extensions
// and the folder (direct children, library-relative).
func (ix *Index) passesCheap(it Item, f core.LibraryQuery) bool {
	if len(f.Kinds) > 0 {
		kind := core.KindImage
		if it.Source != core.SearchSourceProject {
			kind = core.KindForPath(it.Path)
		}
		found := false
		for _, k := range f.Kinds {
			if k == kind {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if len(f.Exts) > 0 {
		ext := strings.ToLower(filepath.Ext(it.Path))
		found := false
		for _, e := range f.Exts {
			e = strings.ToLower(e)
			if !strings.HasPrefix(e, ".") {
				e = "." + e
			}
			if e == ext {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if f.Folder != "" || f.ModuleID != "" {
		if it.Source == core.SearchSourceProject {
			return false
		}
	}
	if f.Folder != "" {
		lib := ""
		if ix.cfg.LibraryDir != nil {
			lib = ix.cfg.LibraryDir()
		}
		rel, err := filepath.Rel(lib, filepath.Dir(it.Path))
		if err != nil {
			return false
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			rel = ""
		}
		want := strings.Trim(filepath.ToSlash(f.Folder), "/")
		if !sameKey(rel, want) {
			return false
		}
	}
	return true
}

// passesOutput applies the module and date filters (they need the output).
func passesOutput(h core.SearchHit, modMs int64, o *core.Output, f core.LibraryQuery) bool {
	if f.ModuleID != "" && (o == nil || o.ModuleID != f.ModuleID) {
		return false
	}
	ts := modMs
	if o != nil && o.CreatedAt > 0 {
		ts = o.CreatedAt
	}
	if f.Since != 0 && ts < f.Since {
		return false
	}
	if f.Until != 0 && ts > f.Until {
		return false
	}
	return true
}

// ---- find similar ----------------------------------------------------------

// similarQuery ranks files by how their pictures look like one file's (or
// one frame's / page's).
func (ix *Index) similarQuery(ctx context.Context, q core.SearchQuery, limit int) (core.SearchPage, error) {
	page := core.SearchPage{Hits: []core.SearchHit{}, Labels: []core.LabelCount{}}
	it, ok, err := ix.cfg.Store.GetItem(ctx, filepath.Clean(q.Similar))
	if err != nil || !ok || !ix.conceptReady() {
		return page, err
	}
	m := ix.Model()
	rows, err := ix.cfg.Store.ItemVectors(ctx, it.ID)
	if err != nil {
		return page, err
	}
	var all, picked [][]float32
	for _, r := range rows {
		if len(r.Blob) != 2*m.Dim || it.Model != m.ID {
			continue
		}
		v := Normalize(DecodeVec(r.Blob))
		all = append(all, v)
		if q.SimilarPos >= 0 && r.Pos == q.SimilarPos {
			picked = append(picked, v)
		}
	}
	queries := picked
	if len(queries) == 0 {
		queries = all
	}
	if len(queries) > 16 { // a long video: its frames spread evenly
		step := float64(len(queries)) / 16
		var sel [][]float32
		for i := 0; i < 16; i++ {
			sel = append(sel, queries[int(float64(i)*step)])
		}
		queries = sel
	}
	if len(queries) == 0 {
		return page, nil
	}
	scored, err := ix.scoreVectors(ctx, queries, SimilarMinCos, it.ID)
	if err != nil {
		return page, err
	}
	page.Concept = true
	folded := foldByItem(scored, maxMoments)
	if len(folded) > 4*limit+100 {
		folded = folded[:4*limit+100]
	}
	ids := make([]int64, len(folded))
	for i, f := range folded {
		ids[i] = f.item
	}
	items, err := ix.cfg.Store.ItemsByIDs(ctx, ids)
	if err != nil {
		return page, err
	}
	cands := map[int64]*cand{}
	for _, f := range folded {
		row, ok := items[f.item]
		if !ok {
			continue
		}
		cands[f.item] = &cand{item: row, concept: true, conceptP: float64(clampCos(f.cos)), conceptPos: f.pos, conceptMoments: f.moments}
	}
	hits := ix.rank(ctx, cands, q.Filter, limit)
	for i := range hits {
		switch c := hits[i].Score; {
		case c >= SimilarStrong:
			hits[i].Strength = core.StrengthStrong
		case c >= SimilarGood:
			hits[i].Strength = core.StrengthGood
		default:
			hits[i].Strength = core.StrengthMaybe
		}
	}
	page.Hits = hits
	return page, nil
}

func clampCos(c float32) float32 {
	if c < 0 {
		return 0
	}
	if c > 1 {
		return 1
	}
	return c
}

// ---- Things ----------------------------------------------------------------

// Things implements core.MediaIndex: the labels with at least three files
// (and every user label), grouped by the Things view.
func (ix *Index) Things(ctx context.Context) ([]core.LabelCount, error) {
	stats, err := ix.cfg.Store.LabelStats(ctx)
	if err != nil {
		return nil, err
	}
	order := map[string]int{}
	for i, c := range Categories {
		order[c] = i
	}
	out := []core.LabelCount{}
	for _, s := range stats {
		d, cat, inVocab := ix.displayFor(s.Label)
		if (inVocab && s.Count < 3) || s.Count < 1 {
			continue
		}
		out = append(out, core.LabelCount{Label: s.Label, Display: d, Category: cat, Count: s.Count, User: !inVocab, Cover: s.Cover})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.User != b.User {
			return a.User
		}
		if oa, ob := order[a.Category], order[b.Category]; oa != ob {
			return oa < ob
		}
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.Display < b.Display
	})
	return out, nil
}
