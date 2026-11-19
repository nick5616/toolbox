package mediaindex

import (
	"context"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"toolbox/core"
)

// Text search: building a safe FTS5 MATCH from what the user typed, scoring
// chunks, and the same rules in memory for search-filter (SPEC.md §3.6).

const (
	// SnippetOpen / SnippetClose surround matched words in a snippet.
	SnippetOpen, SnippetClose = "\u0002", "\u0003"

	// Text scores: Strong = 0.35 + 0.1·n, Good = 0.15 + 0.1·n, n = normalised bm25 (0..1).
	TextStrongBase = 0.35
	TextGoodBase   = 0.15
	TextBM25Weight = 0.1

	maxTerms      = 8
	maxMoments    = 5
	ftsRowLimit   = 3000
	maxQueryRunes = 300
)

// Term is one search term: a word (matched as a prefix) or a phrase
// (consecutive words, exact).
type Term struct {
	Words  []string
	Phrase bool
}

// foldText lowercases and strips diacritics, like FTS5's
// "unicode61 remove_diacritics 2".
func foldText(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(s) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

func isTokenRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }

// Tokens splits text into folded tokens (letters and digits of any script).
func Tokens(s string) []string {
	return strings.FieldsFunc(foldText(s), func(r rune) bool { return !isTokenRune(r) })
}

// ParseTerms turns what the user typed into terms: words become prefix
// terms, "quoted phrases" stay phrases, punctuation is dropped, and FTS
// operators typed by the user are just words.
func ParseTerms(text string) []Term {
	r := []rune(text)
	if len(r) > maxQueryRunes {
		r = r[:maxQueryRunes]
	}
	var terms []Term
	add := func(words []string, phrase bool) {
		if len(words) == 0 || len(terms) >= maxTerms {
			return
		}
		terms = append(terms, Term{Words: words, Phrase: phrase || len(words) > 1})
	}
	for i := 0; i < len(r); {
		switch {
		case unicode.IsSpace(r[i]):
			i++
		case r[i] == '"':
			j := i + 1
			for j < len(r) && r[j] != '"' {
				j++
			}
			add(Tokens(string(r[i+1:j])), true)
			i = j + 1
		default:
			j := i
			for j < len(r) && !unicode.IsSpace(r[j]) && r[j] != '"' {
				j++
			}
			add(Tokens(string(r[i:j])), false)
			i = j
		}
	}
	return terms
}

// MatchExpr builds an FTS5 MATCH expression for the terms (ANDed). Every
// token is double-quoted, so nothing the user typed is an operator.
func MatchExpr(terms []Term) string {
	parts := make([]string, 0, len(terms))
	for _, t := range terms {
		q := `"` + strings.Join(t.Words, " ") + `"`
		if !t.Phrase {
			q += "*"
		}
		parts = append(parts, q)
	}
	return strings.Join(parts, " AND ")
}

// TextScore is a text hit's score.
func TextScore(strong bool, norm float64) float64 {
	base := TextGoodBase
	if strong {
		base = TextStrongBase
	}
	return base + TextBM25Weight*clamp01(norm)
}

func clamp01(x float64) float64 {
	switch {
	case x < 0:
		return 0
	case x > 1:
		return 1
	}
	return x
}

// termMatches reports whether the term matches the chunk's tokens.
func termMatches(t Term, toks []string) bool {
	if !t.Phrase {
		for _, tok := range toks {
			if strings.HasPrefix(tok, t.Words[0]) {
				return true
			}
		}
		return false
	}
	for i := 0; i+len(t.Words) <= len(toks); i++ {
		ok := true
		for k, w := range t.Words {
			if toks[i+k] != w {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// MatchTexts applies the Query text rules to chunks in memory: Strong when
// one chunk holds every term, Good when the terms are spread over several
// chunks, "" when some term is missing everywhere.
func MatchTexts(query string, texts []core.MediaText) string {
	terms := ParseTerms(query)
	if len(terms) == 0 || len(texts) == 0 {
		return ""
	}
	covered := make([]bool, len(terms))
	for _, tx := range texts {
		toks := Tokens(tx.Text)
		all := true
		for i, t := range terms {
			if termMatches(t, toks) {
				covered[i] = true
			} else {
				all = false
			}
		}
		if all {
			return core.StrengthStrong
		}
	}
	for _, c := range covered {
		if !c {
			return ""
		}
	}
	return core.StrengthGood
}

// textHit is one item's best text match.
type textHit struct {
	item    int64
	score   float64
	strong  bool
	source  string
	pos     int64
	snippet string
	moments []int64
	sources []string // every text source that matched, best first
}

// bestPerItem keeps each item's best (first) row and collects the other
// positions and sources. rows must be ordered best first.
func bestPerItem(rows []TextRow) map[int64]*textRowGroup {
	groups := map[int64]*textRowGroup{}
	for _, r := range rows {
		g := groups[r.ItemID]
		if g == nil {
			g = &textRowGroup{best: r}
			groups[r.ItemID] = g
		}
		if !contains(g.sources, r.Source) {
			g.sources = append(g.sources, r.Source)
		}
		if r.Pos != g.best.Pos && len(g.moments) < maxMoments && !containsPos(g.moments, r.Pos) {
			g.moments = append(g.moments, r.Pos)
		}
	}
	return groups
}

type textRowGroup struct {
	best    TextRow
	moments []int64
	sources []string
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func containsPos(xs []int64, p int64) bool {
	for _, x := range xs {
		if x == p {
			return true
		}
	}
	return false
}

// normBM25 maps a bm25 rank (lower is better, negative) to 0..1 against the
// best rank of the result set.
func normBM25(rank, bestRank float64) float64 {
	raw, top := -rank, -bestRank
	if top <= 0 {
		return 1
	}
	return clamp01(raw / top)
}

// textSearch finds items whose text matches the query. A failed FTS query
// (it never should for escaped input) is no match.
func (ix *Index) textSearch(ctx context.Context, text string) (map[int64]*textHit, error) {
	terms := ParseTerms(text)
	out := map[int64]*textHit{}
	if len(terms) == 0 {
		return out, nil
	}
	rows, err := ix.cfg.Store.SearchText(ctx, MatchExpr(terms), ftsRowLimit)
	if err != nil {
		return out, nil
	}
	if len(rows) > 0 {
		bestRank := rows[0].Rank
		for id, g := range bestPerItem(rows) {
			out[id] = &textHit{
				item: id, strong: true, source: g.best.Source, pos: g.best.Pos, snippet: g.best.Snippet,
				score: TextScore(true, normBM25(g.best.Rank, bestRank)), moments: g.moments, sources: g.sources,
			}
		}
	}
	if len(terms) < 2 {
		return out, nil
	}
	// Terms spread across several chunks of one item: Good.
	var sets []map[int64]*textRowGroup
	var ranks []float64
	for _, t := range terms {
		rs, err := ix.cfg.Store.SearchText(ctx, MatchExpr([]Term{t}), ftsRowLimit)
		if err != nil || len(rs) == 0 {
			return out, nil
		}
		sets = append(sets, bestPerItem(rs))
		ranks = append(ranks, rs[0].Rank)
	}
	for id, g0 := range sets[0] {
		if _, strong := out[id]; strong {
			continue
		}
		sum, bestG := 0.0, g0
		ok := true
		var sources []string
		for i, set := range sets {
			g := set[id]
			if g == nil {
				ok = false
				break
			}
			sum += normBM25(g.best.Rank, ranks[i])
			if g.best.Rank < bestG.best.Rank {
				bestG = g
			}
			for _, s := range g.sources {
				if !contains(sources, s) {
					sources = append(sources, s)
				}
			}
		}
		if !ok {
			continue
		}
		out[id] = &textHit{
			item: id, source: bestG.best.Source, pos: bestG.best.Pos, snippet: bestG.best.Snippet,
			score: TextScore(false, sum/float64(len(sets))), moments: bestG.moments, sources: sources,
		}
	}
	return out, nil
}

// sortedHits orders text hits best first (for tests and stable output).
func sortedHits(m map[int64]*textHit) []*textHit {
	out := make([]*textHit, 0, len(m))
	for _, h := range m {
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].score != out[j].score {
			return out[i].score > out[j].score
		}
		return out[i].item < out[j].item
	})
	return out
}
