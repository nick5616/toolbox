package viz

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// Analyzer runs and caches song analyses (SPEC.md §5).
type Analyzer struct {
	cacheDir  string // <support>/cache/visualizer
	modelsDir string // <models>
	sc        sidecar.Caller
	textgen   core.TextGenerator // may be nil
	// MoodModel returns the mood reader's model and tokenizer paths, or ok=false
	// when it isn't installed (set by modules/visualizer, which owns the pins).
	MoodModel func() (model, tokenizer string, ok bool)
	// LibraryOutput registers a saved stem as a Library output of job (SaveStems).
	// Nil means job.Output.
	LibraryOutput func(job *core.JobContext, path string) error
}

// NewAnalyzer builds an Analyzer; textgen may be nil.
func NewAnalyzer(cacheDir, modelsDir string, sc sidecar.Caller, textgen core.TextGenerator) *Analyzer {
	return &Analyzer{cacheDir: cacheDir, modelsDir: modelsDir, sc: sc, textgen: textgen}
}

// CacheDir is the analysis cache folder.
func (a *Analyzer) CacheDir() string { return a.cacheDir }

// FileKey identifies an input by path, size and modification time.
func FileKey(path string) (string, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", filepath.Base(path), err)
	}
	h := sha1.Sum([]byte(fmt.Sprintf("%s|%d|%d", path, fi.Size(), fi.ModTime().UnixNano())))
	return hex.EncodeToString(h[:10]), nil
}

// TextKey identifies the words options of an analysis ("none" without words).
func TextKey(o AnalyzeOptions) string {
	if o.Words == "" || o.Words == WordsNone {
		return "none"
	}
	b, _ := json.Marshal(struct {
		W WordsSource
		L string
		T string
		P string
		X any
	}{o.Words, o.Language, o.LyricsText, o.LyricsPath, o.Lines})
	h := sha1.Sum(b)
	return hex.EncodeToString(h[:6])
}

// MoodCode is the m<0|1|2> part of a key.
func MoodCode(o AnalyzeOptions) string {
	switch {
	case o.Words == "" || o.Words == WordsNone || (!o.Mood && !o.DeepRead):
		return "m0"
	case o.DeepRead:
		return "m2"
	default:
		return "m1"
	}
}

// AnalysisKey is the full key of an analysis of fileKey with o.
func AnalysisKey(fileKey string, o AnalyzeOptions) string {
	s := "s0"
	if o.Stems {
		s = "s1"
	}
	return fileKey + "-" + s + "-" + TextKey(o) + "-" + MoodCode(o)
}

func (a *Analyzer) refPath(key string) string {
	fileKey, _, _ := strings.Cut(key, "-")
	return filepath.Join(a.cacheDir, fileKey, key+".ref.json")
}

// WriteRef stores ref so Lookup and AnalysisFor find it.
func (a *Analyzer) WriteRef(ref AnalysisRef) error {
	p := a.refPath(ref.Key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("creating the analysis folder: %w", err)
	}
	b, err := json.MarshalIndent(ref, "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}

// Lookup returns the analysis stored under key, if its files still exist.
func (a *Analyzer) Lookup(key string) (AnalysisRef, bool) {
	if key == "" || strings.ContainsAny(key, `/\.`) {
		return AnalysisRef{}, false
	}
	b, err := os.ReadFile(a.refPath(key))
	if err != nil {
		return AnalysisRef{}, false
	}
	var ref AnalysisRef
	if json.Unmarshal(b, &ref) != nil || ref.Key != key {
		return AnalysisRef{}, false
	}
	for _, p := range []string{ref.AudioJSON, ref.FeaturesPath, ref.TextJSON} {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err != nil {
			return AnalysisRef{}, false
		}
	}
	now := nowFunc()
	_ = os.Chtimes(filepath.Dir(a.refPath(key)), now, now) // keeps the folder young for the prune
	return ref, true
}

// AnalysisFor returns the most recent analysis of path with the given stems
// setting (any words), preferring one with words.
func (a *Analyzer) AnalysisFor(path string, stems bool) (AnalysisRef, bool) {
	fk, err := FileKey(path)
	if err != nil {
		return AnalysisRef{}, false
	}
	s := "-s0-"
	if stems {
		s = "-s1-"
	}
	matches, _ := filepath.Glob(filepath.Join(a.cacheDir, fk, fk+s+"*.ref.json"))
	type cand struct {
		ref   AnalysisRef
		words bool
		mod   int64
	}
	var cs []cand
	for _, m := range matches {
		key := strings.TrimSuffix(filepath.Base(m), ".ref.json")
		ref, ok := a.Lookup(key)
		if !ok {
			continue
		}
		fi, _ := os.Stat(m)
		cs = append(cs, cand{ref, ref.TextJSON != "", fi.ModTime().UnixNano()})
	}
	if len(cs) == 0 {
		return AnalysisRef{}, false
	}
	sort.Slice(cs, func(i, j int) bool {
		if cs[i].words != cs[j].words {
			return cs[i].words
		}
		return cs[i].mod > cs[j].mod
	})
	return cs[0].ref, true
}

// Analyze runs (or reuses) the analysis of input (SPEC.md §5.1).
func (a *Analyzer) Analyze(ctx context.Context, job *core.JobContext, input string, o AnalyzeOptions) (AnalysisRef, error) {
	return a.analyze(ctx, job, input, o)
}

// Prune deletes analyses untouched for 30 days, then the oldest until the
// cache is under 3 GB (called at start).
func (a *Analyzer) Prune() { a.prune() }
