package tts

import (
	"bytes"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// MaxTextBytes is the largest text file Text to Speech reads.
const MaxTextBytes = 8 << 20

// Accepts lists the input extensions.
func Accepts() []string {
	return []string{".txt", ".md", ".markdown", ".srt", ".vtt", ".html", ".htm"}
}

// readText returns a file's text as UTF-8 with the markup of subtitles and
// HTML removed. Markdown and plain text pass through (the engine cleans
// Markdown and finds the headings).
func readText(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("reading the text: %w", err)
	}
	if info.Size() > MaxTextBytes {
		return "", core.ValidationError("This text file is too large (limit 8 MB)", map[string]string{"inputs.0": "Too large (limit 8 MB)"})
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading the text: %w", err)
	}
	text := decodeText(raw)
	switch strings.ToLower(filepath.Ext(path)) {
	case ".srt", ".vtt":
		return subtitleText(text), nil
	case ".html", ".htm":
		return htmlText(text), nil
	}
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), nil
}

// decodeText strips a BOM; bytes that aren't UTF-8 are read as Latin-1.
func decodeText(raw []byte) string {
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	if utf8.Valid(raw) {
		return string(raw)
	}
	r := make([]rune, len(raw))
	for i, b := range raw {
		r[i] = rune(b)
	}
	return string(r)
}

var (
	tagRe       = regexp.MustCompile(`(?s)<[^>]*>`)
	assRe       = regexp.MustCompile(`\{\\[^}]*\}`)
	spacesRe    = regexp.MustCompile(`[ \t\x{00a0}]+`)
	blankRunsRe = regexp.MustCompile(`\n{3,}`)
)

// subtitleText joins the cue text of an SRT or WebVTT file, dropping indexes,
// timings, headers, notes and styling.
func subtitleText(src string) string {
	src = strings.ReplaceAll(strings.ReplaceAll(src, "\r\n", "\n"), "\r", "\n")
	var cues []string
	for _, block := range regexp.MustCompile(`\n\s*\n`).Split(src, -1) {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		timing := -1
		for i, ln := range lines {
			if strings.Contains(ln, "-->") {
				timing = i
				break
			}
		}
		if timing < 0 { // WEBVTT header, NOTE, STYLE, REGION or stray text
			continue
		}
		var parts []string
		for _, ln := range lines[timing+1:] {
			ln = assRe.ReplaceAllString(ln, "")
			ln = tagRe.ReplaceAllString(ln, "")
			ln = html.UnescapeString(ln)
			ln = strings.TrimSpace(strings.Trim(strings.TrimSpace(ln), "♪♫"))
			ln = strings.TrimSpace(strings.TrimPrefix(ln, "- "))
			if ln != "" {
				parts = append(parts, ln)
			}
		}
		if len(parts) > 0 {
			cues = append(cues, strings.Join(parts, " "))
		}
	}
	return spacesRe.ReplaceAllString(strings.Join(cues, " "), " ")
}

var (
	htmlDropRe    = regexp.MustCompile(`(?is)<(script|style|head|noscript|svg|template|iframe)\b[^>]*>.*?</(script|style|head|noscript|svg|template|iframe)\s*>`)
	htmlCommentRe = regexp.MustCompile(`(?s)<!--.*?-->`)
	htmlHeadingRe = regexp.MustCompile(`(?is)<h([1-6])\b[^>]*>(.*?)</h[1-6]\s*>`)
	htmlBlockRe   = regexp.MustCompile(`(?i)</?(p|div|section|article|header|footer|main|aside|blockquote|ul|ol|table|pre|figure|figcaption|form|hr)\b[^>]*>`)
	htmlBreakRe   = regexp.MustCompile(`(?i)<br\s*/?>|</?(li|tr|dt|dd)\b[^>]*>`)
	htmlCellRe    = regexp.MustCompile(`(?i)</t[dh]\s*>`)
)

// htmlText turns a web page into text: headings become "# " lines (so the
// engine can split chapters), paragraphs become paragraphs, and scripts,
// styles and tags disappear.
func htmlText(src string) string {
	s := htmlCommentRe.ReplaceAllString(src, "")
	s = htmlDropRe.ReplaceAllString(s, "")
	s = htmlHeadingRe.ReplaceAllStringFunc(s, func(m string) string {
		sm := htmlHeadingRe.FindStringSubmatch(m)
		title := strings.TrimSpace(spacesRe.ReplaceAllString(strings.ReplaceAll(tagRe.ReplaceAllString(sm[2], ""), "\n", " "), " "))
		if title == "" {
			return "\n\n"
		}
		return "\n\n" + strings.Repeat("#", int(sm[1][0]-'0')) + " " + html.UnescapeString(title) + "\n\n"
	})
	s = htmlBlockRe.ReplaceAllString(s, "\n\n")
	s = htmlBreakRe.ReplaceAllString(s, "\n")
	s = htmlCellRe.ReplaceAllString(s, ", ")
	s = tagRe.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	lines := strings.Split(strings.ReplaceAll(s, "\r", ""), "\n")
	for i, ln := range lines {
		lines[i] = strings.TrimSpace(spacesRe.ReplaceAllString(ln, " "))
	}
	return strings.TrimSpace(blankRunsRe.ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
}
