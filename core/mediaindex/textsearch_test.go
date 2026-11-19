package mediaindex

import (
	"strings"
	"testing"

	"toolbox/core"
)

func TestParseTermsAndMatchExpr(t *testing.T) {
	cases := []struct{ in, want string }{
		{"apple", `"apple"*`},
		{"apple pie", `"apple"* AND "pie"*`},
		{`"red apple" pie`, `"red apple" AND "pie"*`},
		{"AND OR NOT", `"and"* AND "or"* AND "not"*`},
		{"NEAR(a b)", `"near a" AND "b"*`},
		{`a"b`, `"a"* AND "b"`},
		{`"unclosed phrase`, `"unclosed phrase"`},
		{`"`, ``},
		{"!!! ???", ``},
		{"c++ -foo foo*", `"c"* AND "foo"* AND "foo"*`},
		{"x:y", `"x y"`},
		{"^start (group)", `"start"* AND "group"*`},
		{"Café CRÈME", `"cafe"* AND "creme"*`},
		{"日本語 テスト", `"日本語"* AND "テスト"*`},
		{"4471", `"4471"*`},
		{"  spaced   out  ", `"spaced"* AND "out"*`},
		{"", ``},
	}
	for _, c := range cases {
		if got := MatchExpr(ParseTerms(c.in)); got != c.want {
			t.Errorf("%q: got %q want %q", c.in, got, c.want)
		}
	}
	long := strings.Repeat("wa wb wc wd ", 10)
	if n := len(ParseTerms(long)); n != maxTerms {
		t.Errorf("terms capped at %d, got %d", maxTerms, n)
	}
}

func TestMatchTexts(t *testing.T) {
	ch := func(s ...string) []core.MediaText {
		var out []core.MediaText
		for _, x := range s {
			out = append(out, core.MediaText{Source: "ocr", Text: x})
		}
		return out
	}
	cases := []struct {
		q     string
		texts []core.MediaText
		want  string
	}{
		{"total 4471", ch("Invoice total 4471 due 30 Nov"), "strong"},
		{"tot", ch("the total"), "strong"}, // prefix
		{"total due", ch("total amount", "due soon"), "good"},
		{"total due", ch("total amount"), ""},
		{`"due soon"`, ch("it is due soon"), "strong"},
		{`"soon due"`, ch("it is due soon"), ""},
		{"CAFE", ch("un café noir"), "strong"},
		{"quarterly budget", ch("the quarterly budget review"), "strong"},
		{"", ch("x"), ""},
		{"x", nil, ""},
	}
	for _, c := range cases {
		if got := MatchTexts(c.q, c.texts); got != c.want {
			t.Errorf("%q: got %q want %q", c.q, got, c.want)
		}
	}
}

func TestTextScore(t *testing.T) {
	if s := TextScore(true, 1); s < 0.449 || s > 0.451 {
		t.Errorf("strong best %g", s)
	}
	if TextScore(false, 1) >= TextScore(true, 0) {
		t.Error("the best Good must not beat the worst Strong")
	}
	if normBM25(-2, -4) != 0.5 || normBM25(-1, 0) != 1 {
		t.Error("bm25 normalisation")
	}
}
