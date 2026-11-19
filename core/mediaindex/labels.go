package mediaindex

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"toolbox/core"
)

// Labels: the vocabulary, label scoring, the text gate and strengths
// (SPEC.md §3.4). The calibration constants live here and nowhere else.
const (
	// Calibrated in Wave 2 on COCO val photos + library screenshots and scans
	// (docs/DECISIONS.md, Phase 20). SigLIP 2's sigmoid probabilities are
	// small for open-vocabulary prompts: right answers sit at 1e-3..0.6, wrong
	// ones mostly below 3e-4.
	//
	// LabelThreshold is the default p at which a label is kept, and
	// LabelRelative drops labels weaker than that share of the item's best one.
	LabelThreshold = 0.001
	LabelRelative  = 0.02
	// Concept strengths (probabilities).
	StrongP = 0.01
	GoodP   = 0.001
	MaybeP  = 0.0003
	// TextGateP is the gate prompts' p at which OCR runs.
	TextGateP = 0.0003
	// MaxLabels is how many labels an item keeps (plus their parents).
	MaxLabels = 8
	// MaxUserLabel is the longest user label.
	MaxUserLabel = 40
	// SimilarMinCos is the lowest image-to-image cosine Find similar shows.
	SimilarMinCos = 0.35
)

// GatePrompts are the text-gate prompts (SPEC.md §3.4).
var GatePrompts = []string{
	"a screenshot", "a document", "a page of text", "a receipt", "a sign with writing", "a poster",
	"a presentation slide", "handwriting", "a chart", "a menu", "a label with text", "a whiteboard",
}

// StrengthForP maps a concept probability to a strength ("" below Maybe).
func StrengthForP(p float64) string {
	switch {
	case p >= StrongP:
		return core.StrengthStrong
	case p >= GoodP:
		return core.StrengthGood
	case p >= MaybeP:
		return core.StrengthMaybe
	}
	return ""
}

// VocabEntry is one vocabulary row.
type VocabEntry struct {
	ID, Category, Display string
	Prompts               []string // "{}" already replaced by Display
	Parent                string
	Threshold             float64 // 0 = LabelThreshold
}

// Categories are the vocabulary's category ids, in the Things view's order.
var Categories = []string{"people", "animals", "food", "nature", "things", "vehicles", "documents", "art"}

// ParseVocabulary reads the TSV: id, category, display, prompts ("|"
// separated, "{}" = display), parent, threshold; "#" lines are comments.
func ParseVocabulary(tsv []byte) ([]VocabEntry, error) {
	var out []VocabEntry
	seen := map[string]bool{}
	for n, line := range strings.Split(string(tsv), "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		f := strings.Split(line, "\t")
		for len(f) < 6 {
			f = append(f, "")
		}
		e := VocabEntry{ID: strings.TrimSpace(f[0]), Category: strings.TrimSpace(f[1]), Display: strings.TrimSpace(f[2]), Parent: strings.TrimSpace(f[4])}
		if e.ID == "" || e.Display == "" {
			return nil, fmt.Errorf("vocabulary line %d: id and display are required", n+1)
		}
		if seen[e.ID] {
			return nil, fmt.Errorf("vocabulary line %d: duplicate id %q", n+1, e.ID)
		}
		seen[e.ID] = true
		for _, p := range strings.Split(f[3], "|") {
			if p = strings.TrimSpace(p); p != "" {
				e.Prompts = append(e.Prompts, strings.ReplaceAll(p, "{}", e.Display))
			}
		}
		if len(e.Prompts) == 0 {
			e.Prompts = []string{"a photo of " + e.Display}
		}
		if t := strings.TrimSpace(f[5]); t != "" {
			v, err := strconv.ParseFloat(t, 64)
			if err != nil || v <= 0 || v >= 1 {
				return nil, fmt.Errorf("vocabulary line %d: bad threshold %q", n+1, t)
			}
			e.Threshold = v
		}
		out = append(out, e)
	}
	return out, nil
}

// vocab is the parsed vocabulary with lookups.
type vocab struct {
	entries []VocabEntry
	byID    map[string]int
	byName  map[string]int // lowercase display → entry
	hash    string
}

func newVocab(tsv []byte) (*vocab, error) {
	entries, err := ParseVocabulary(tsv)
	if err != nil {
		return nil, err
	}
	v := &vocab{entries: entries, byID: map[string]int{}, byName: map[string]int{}}
	for i, e := range entries {
		v.byID[e.ID] = i
		v.byName[strings.ToLower(e.Display)] = i
	}
	sum := sha256.Sum256(tsv)
	v.hash = hex.EncodeToString(sum[:8])
	return v, nil
}

// labelSet is the vocabulary with its label vectors for one model.
type labelSet struct {
	model Model
	voc   *vocab
	vecs  [][]float32 // per entry: mean of its prompt vectors, normalised
	gate  [][]float32
}

// BuildLabelSet makes a label set from a vocabulary and a way to get a
// prompt's (unit) vector. Prompts without a vector are skipped; a label
// without any is dropped from scoring. Exported for the calibration harness.
func BuildLabelSet(m Model, entries []VocabEntry, lookup func(text string) ([]float32, bool)) *LabelSet {
	voc := &vocab{entries: entries, byID: map[string]int{}, byName: map[string]int{}}
	for i, e := range entries {
		voc.byID[e.ID] = i
		voc.byName[strings.ToLower(e.Display)] = i
	}
	return &LabelSet{buildLabelSet(m, voc, lookup)}
}

// LabelSet is the exported handle on a label set.
type LabelSet struct{ ls *labelSet }

// Score returns the labels (with parents) for one item's vectors.
func (s *LabelSet) Score(vecs []VectorAt) []LabelRow { return s.ls.score(vecs) }

// GateP is the highest text-gate probability for one picture vector.
func (s *LabelSet) GateP(vec []float32) float64 { return s.ls.gateP(vec) }

func buildLabelSet(m Model, voc *vocab, lookup func(string) ([]float32, bool)) *labelSet {
	ls := &labelSet{model: m, voc: voc, vecs: make([][]float32, len(voc.entries))}
	mean := func(prompts []string) []float32 {
		var sum []float32
		for _, p := range prompts {
			v, ok := lookup(p)
			if !ok || len(v) != m.Dim {
				continue
			}
			if sum == nil {
				sum = make([]float32, m.Dim)
			}
			for i, x := range v {
				sum[i] += x
			}
		}
		if sum == nil {
			return nil
		}
		return Normalize(sum)
	}
	for i, e := range voc.entries {
		ls.vecs[i] = mean(e.Prompts)
	}
	for _, g := range GatePrompts {
		if v := mean([]string{g}); v != nil {
			ls.gate = append(ls.gate, v)
		}
	}
	return ls
}

func (ls *labelSet) threshold(e VocabEntry) float64 {
	if e.Threshold > 0 {
		return e.Threshold
	}
	return LabelThreshold
}

// score computes an item's auto labels: every label with p ≥ its threshold,
// the best MaxLabels of them, plus each one's parent chain (a parent takes
// its best child's score). Videos and PDFs take the max over their vectors
// and remember the position.
func (ls *labelSet) score(vecs []VectorAt) []LabelRow {
	type cand struct {
		idx int
		p   float64
		pos int64
	}
	var cands []cand
	for i, e := range ls.voc.entries {
		lv := ls.vecs[i]
		if lv == nil {
			continue
		}
		best, pos := -1.0, int64(-1)
		for _, v := range vecs {
			if p := ProbFromCos(ls.model, float64(Dot(v.Vec, lv))); p > best {
				best, pos = p, v.Pos
			}
		}
		if best >= ls.threshold(e) {
			cands = append(cands, cand{i, best, pos})
		}
	}
	sort.Slice(cands, func(i, j int) bool {
		if cands[i].p != cands[j].p {
			return cands[i].p > cands[j].p
		}
		return cands[i].idx < cands[j].idx
	})
	if len(cands) > 0 {
		floor := cands[0].p * LabelRelative
		keep := cands[:0]
		for _, c := range cands {
			if c.p >= floor {
				keep = append(keep, c)
			}
		}
		cands = keep
	}
	if len(cands) > MaxLabels {
		cands = cands[:MaxLabels]
	}
	rows := map[string]LabelRow{}
	order := []string{}
	put := func(id string, p float64, pos int64) {
		if old, ok := rows[id]; ok {
			if p > old.Score {
				rows[id] = LabelRow{Label: id, Source: core.LabelAuto, Score: p, Pos: pos}
			}
			return
		}
		rows[id] = LabelRow{Label: id, Source: core.LabelAuto, Score: p, Pos: pos}
		order = append(order, id)
	}
	for _, c := range cands {
		e := ls.voc.entries[c.idx]
		put(e.ID, c.p, c.pos)
		parent, hops := e.Parent, 0
		for parent != "" && hops < 8 {
			pi, ok := ls.voc.byID[parent]
			if !ok {
				break
			}
			put(parent, c.p, c.pos)
			parent = ls.voc.entries[pi].Parent
			hops++
		}
	}
	out := make([]LabelRow, 0, len(order))
	for _, id := range order {
		out = append(out, rows[id])
	}
	return out
}

func (ls *labelSet) gateP(vec []float32) float64 {
	best := 0.0
	for _, g := range ls.gate {
		if p := ProbFromCos(ls.model, float64(Dot(vec, g))); p > best {
			best = p
		}
	}
	return best
}

// labelCache holds the loaded label set (guarded by mu; loading serialised).
type labelCache struct {
	mu  sync.Mutex // serialises loading
	ptr atomic.Pointer[labelSet]
}

func (c *labelCache) get() *labelSet { return c.ptr.Load() }

func (c *labelCache) put(ls *labelSet) { c.ptr.Store(ls) }

// vocabulary parses (once) the configured vocabulary.
func (ix *Index) vocabulary() (*vocab, error) {
	ix.vocOnce.Do(func() { ix.voc, ix.vocErr = newVocab(ix.cfg.Vocabulary) })
	return ix.voc, ix.vocErr
}

// VocabHash identifies the vocabulary, model and scoring constants: labels
// are recomputed from stored vectors when it changes.
func (ix *Index) vocabHash() string {
	v, err := ix.vocabulary()
	if err != nil {
		return ""
	}
	m := ix.Model()
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%g|%g|%d|%g|%g|%g", v.hash, m.ID, m.Scale, m.Bias, MaxLabels, LabelThreshold, LabelRelative, TextGateP)))
	return hex.EncodeToString(sum[:8])
}

const vocabHashKey = "search.vocab"

// embedResult is search.embed_text's answer.
type embedResult struct {
	Dim     int      `json:"dim"`
	Vectors []string `json:"vectors"` // base64 fp16
}

// embedTexts asks the engine for the vectors of texts (unit length).
func (ix *Index) embedTexts(ctx context.Context, texts []string) ([][]float32, error) {
	m := ix.Model()
	if ix.cfg.Caller == nil || m.ID == "" {
		return nil, core.Errorf(core.CodeDependencyMissing, "Smart search isn't installed")
	}
	raw, err := ix.cfg.Caller.Call(ctx, "search.embed_text", map[string]any{"modelDir": m.Dir, "texts": texts}, nil)
	if err != nil {
		return nil, err
	}
	var res embedResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("decode search.embed_text: %w", err)
	}
	if len(res.Vectors) != len(texts) {
		return nil, fmt.Errorf("search.embed_text returned %d vectors for %d texts", len(res.Vectors), len(texts))
	}
	out := make([][]float32, len(texts))
	for i, s := range res.Vectors {
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return nil, fmt.Errorf("decode vector %d: %w", i, err)
		}
		if len(b) != 2*m.Dim {
			return nil, fmt.Errorf("vector %d has %d values, model needs %d", i, len(b)/2, m.Dim)
		}
		out[i] = Normalize(DecodeVec(b))
	}
	return out, nil
}

// textVec returns the cached vector of one text, or ok=false.
func (ix *Index) cachedTextVec(ctx context.Context, text string) ([]float32, bool) {
	m := ix.Model()
	blob, ok, err := ix.cfg.Store.GetTextVector(ctx, m.ID, text)
	if err != nil || !ok || len(blob) != 2*m.Dim {
		return nil, false
	}
	return DecodeVec(blob), true
}

// ensureLabels loads (computing missing prompt vectors through the engine)
// the label set for the current model. It is cheap once loaded.
func (ix *Index) ensureLabels(ctx context.Context) (*labelSet, error) {
	m := ix.Model()
	if m.ID == "" {
		return nil, core.Errorf(core.CodeDependencyMissing, "Smart search isn't installed")
	}
	if ls := ix.labels.get(); ls != nil && ls.model.ID == m.ID {
		return ls, nil
	}
	ix.labels.mu.Lock()
	defer ix.labels.mu.Unlock()
	if ls := ix.labels.get(); ls != nil && ls.model.ID == m.ID {
		return ls, nil
	}
	voc, err := ix.vocabulary()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var all []string
	add := func(p string) {
		if !seen[p] {
			seen[p] = true
			all = append(all, p)
		}
	}
	for _, e := range voc.entries {
		for _, p := range e.Prompts {
			add(p)
		}
	}
	for _, g := range GatePrompts {
		add(g)
	}
	vecs := make(map[string][]float32, len(all))
	var missing []string
	for _, p := range all {
		if v, ok := ix.cachedTextVec(ctx, p); ok {
			vecs[p] = Normalize(v)
		} else {
			missing = append(missing, p)
		}
	}
	const batch = 64
	for len(missing) > 0 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n := min(batch, len(missing))
		got, err := ix.embedTexts(ctx, missing[:n])
		if err != nil {
			return nil, err
		}
		for i, p := range missing[:n] {
			vecs[p] = got[i]
			if err := ix.cfg.Store.PutTextVector(ctx, m.ID, p, EncodeVec(got[i]), true); err != nil {
				return nil, err
			}
		}
		missing = missing[n:]
	}
	ls := buildLabelSet(m, voc, func(t string) ([]float32, bool) { v, ok := vecs[t]; return v, ok })
	ix.labels.put(ls)
	return ls, nil
}

// NeedsOCR implements Writer: the text gate on one picture vector. When the
// label vectors aren't loaded (engine missing) it answers true, so a picture
// is never skipped for lack of a gate.
func (ix *Index) NeedsOCR(vec []float32) bool {
	ls := ix.labels.get()
	if ls == nil || len(ls.gate) == 0 {
		return true
	}
	return ls.gateP(vec) >= TextGateP
}

// Prob implements Writer.
func (ix *Index) Prob(text, vec []float32) float64 {
	return ProbFromCos(ix.Model(), float64(Dot(text, vec)))
}

// autoLabels scores vectors into label rows; nil when no label set is loaded.
func (ix *Index) autoLabels(vecs []VectorAt) []LabelRow {
	ls := ix.labels.get()
	if ls == nil || len(vecs) == 0 {
		return nil
	}
	return ls.score(vecs)
}

// recomputeLabels redoes every done item's auto labels from its stored
// vectors when the vocabulary hash changed (no re-embedding).
func (ix *Index) recomputeLabels(ctx context.Context) error {
	want := ix.vocabHash()
	if want == "" {
		return nil
	}
	if have, ok, _ := ix.cfg.Store.GetSetting(ctx, vocabHashKey); ok && have == want {
		return nil
	}
	ls, err := ix.ensureLabels(ctx)
	if err != nil {
		return err
	}
	m := ix.Model()
	var after int64
	for {
		ids, err := ix.cfg.Store.DoneItemIDs(ctx, m.ID, after, 200)
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			break
		}
		for _, id := range ids {
			rows, err := ix.cfg.Store.ItemVectors(ctx, id)
			if err != nil {
				return err
			}
			var vs []VectorAt
			for _, r := range rows {
				if len(r.Blob) == 2*m.Dim {
					vs = append(vs, VectorAt{Pos: r.Pos, Vec: DecodeVec(r.Blob)})
				}
			}
			if err := ix.cfg.Store.ReplaceAutoLabels(ctx, id, ls.score(vs)); err != nil {
				return err
			}
			after = id
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	return ix.cfg.Store.SetSetting(ctx, vocabHashKey, want)
}

// normalizeUserLabel trims and lowercases a user's label; a label that
// spells a vocabulary label's display text maps to its id.
func (ix *Index) normalizeUserLabel(s string) (string, error) {
	s = strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(s))), " ")
	if s == "" {
		return "", core.Errorf(core.CodeValidation, "Type a label")
	}
	if len([]rune(s)) > MaxUserLabel {
		return "", core.Errorf(core.CodeValidation, "Labels can be up to %d characters", MaxUserLabel)
	}
	if v, err := ix.vocabulary(); err == nil {
		if i, ok := v.byName[s]; ok {
			return v.entries[i].ID, nil
		}
	}
	return s, nil
}

// displayFor is a label's shown text and category ("" category for user labels).
func (ix *Index) displayFor(label string) (display, category string, inVocab bool) {
	if v, err := ix.vocabulary(); err == nil {
		if i, ok := v.byID[label]; ok {
			return v.entries[i].Display, v.entries[i].Category, true
		}
	}
	return label, "", false
}

// ConceptScore maps a concept probability onto the 0..1 scale that label and
// text hits use, so the three rank together: SigLIP's p spans decades
// (MaybeP 3e-4 → ≈ 0, GoodP → 0.14, StrongP → 0.43, 0.1 → 0.71, 1 → 1).
func ConceptScore(p float64) float64 {
	if p <= 0 {
		return 0
	}
	s := (math.Log10(p) + 3.5) / 3.5
	return math.Max(0, math.Min(1, s))
}
