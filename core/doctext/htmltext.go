package doctext

import (
	"strings"

	"golang.org/x/net/html"
)

// blockTags break the text flow; everything else is inline.
var blockTags = map[string]bool{
	"p": true, "div": true, "br": true, "li": true, "ul": true, "ol": true, "tr": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
	"section": true, "article": true, "header": true, "footer": true, "table": true,
	"blockquote": true, "pre": true, "hr": true, "dt": true, "dd": true, "figure": true,
	"figcaption": true, "nav": true, "aside": true, "main": true, "body": true, "title": true,
}

var skipTags = map[string]bool{
	"script": true, "style": true, "template": true, "noscript": true, "svg": true, "head": true,
}

// htmlText returns the visible text of an HTML document (no script, style,
// templates or comments), at most about limit bytes. Block elements start
// new lines.
func htmlText(src string, limit int) string {
	z := html.NewTokenizer(strings.NewReader(src))
	var b strings.Builder
	skip := 0 // depth inside script/style/…
	newline := func() {
		if s := b.String(); s != "" && !strings.HasSuffix(s, "\n") {
			b.WriteByte('\n')
		}
	}
	for b.Len() < limit {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			name, _ := z.TagName()
			n := string(name)
			if skipTags[n] && tt == html.StartTagToken {
				skip++
			}
			if blockTags[n] {
				newline()
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			n := string(name)
			if skipTags[n] && skip > 0 {
				skip--
			}
			if blockTags[n] {
				newline()
			}
		case html.TextToken:
			if skip > 0 {
				continue
			}
			t := strings.Join(strings.Fields(string(z.Text())), " ")
			if t == "" {
				continue
			}
			if s := b.String(); s != "" && !strings.HasSuffix(s, "\n") {
				b.WriteByte(' ')
			}
			b.WriteString(t)
		}
	}
	return b.String()
}
