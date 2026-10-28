package pdf

import (
	"fmt"
	"strconv"
	"strings"
)

// pageRange is an inclusive 1-based page span.
type pageRange struct{ From, To int }

func (r pageRange) count() int { return r.To - r.From + 1 }

// label is the "a-b" (or "a") text used in output names.
func (r pageRange) label() string {
	if r.From == r.To {
		return strconv.Itoa(r.From)
	}
	return fmt.Sprintf("%d-%d", r.From, r.To)
}

// fileLabel names a split output: "page 5" or "pages 1-3".
func (r pageRange) fileLabel() string {
	if r.From == r.To {
		return "page " + r.label()
	}
	return "pages " + r.label()
}

// parseRanges parses "1-3, 5, 8-" into ranges, in the order given. "8-" runs
// to the last page. total is the page count; total <= 0 skips the upper-bound
// check (syntax-only validation at submit time) and leaves open ranges at 0.
func parseRanges(s string, total int) ([]pageRange, error) {
	var out []pageRange
	for _, tok := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' }) {
		tok = strings.ReplaceAll(strings.TrimSpace(tok), " ", "")
		if tok == "" {
			continue
		}
		from, to, isRange := strings.Cut(tok, "-")
		a, err := strconv.Atoi(from)
		if err != nil || a < 1 {
			return nil, fmt.Errorf("%q isn't a valid page range", tok)
		}
		b := a
		if isRange {
			if to == "" {
				b = total // open: to the end
			} else if b, err = strconv.Atoi(to); err != nil || b < 1 {
				return nil, fmt.Errorf("%q isn't a valid page range", tok)
			}
		}
		if total > 0 && (a > total || b > total) {
			return nil, fmt.Errorf("%q is outside this document (%d pages)", tok, total)
		}
		if b != 0 && b < a {
			return nil, fmt.Errorf("%q runs backwards", tok)
		}
		out = append(out, pageRange{a, b})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("enter at least one page or range")
	}
	return out, nil
}

// pagesOf expands ranges into the ordered page list.
func pagesOf(rs []pageRange) []int {
	var out []int
	for _, r := range rs {
		for p := r.From; p <= r.To; p++ {
			out = append(out, p)
		}
	}
	return out
}
