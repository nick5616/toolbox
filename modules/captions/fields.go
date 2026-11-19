package captions

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Field repairs (SPEC.md §4.2): the model's words are clamped and tidied in
// Go. Everything here is pure.

var (
	hashtagWord = regexp.MustCompile(`(^|\s)#[\p{L}\p{M}\p{N}_]+`)
	altOpener   = regexp.MustCompile(`(?i)^(?:an?\s+|the\s+)?(?:image|picture|photo|photograph)\s+(?:of|showing|that\s+shows)\s+`)
	spaces      = regexp.MustCompile(`[ \t\f\v]+`)
)

// spamHashtags are generic tags that say nothing about the picture
// (compared lowercase, without the #).
var spamHashtags = map[string]bool{
	"love": true, "instagood": true, "photooftheday": true, "follow": true, "followme": true,
	"like4like": true, "likeforlike": true, "l4l": true, "f4f": true, "follow4follow": true,
	"followforfollow": true, "picoftheday": true, "instadaily": true, "instagram": true,
	"insta": true, "instalike": true, "likes": true, "like": true, "tagsforlikes": true,
	"bestoftheday": true, "photography": true, "photo": true, "fashion": true, "beautiful": true,
	"happy": true, "cute": true, "me": true, "selfie": true, "followback": true, "viral": true,
	"explore": true, "explorepage": true, "fyp": true, "foryou": true, "foryoupage": true,
	"trending": true, "repost": true, "spam": true, "smile": true, "art": true,
}

// identityKeywordTokens are removed from keywords when they appear as a word
// of the keyword; identityKeywords only when they are the whole keyword
// (ambiguous words such as "black cat" or "indian food" stay).
var identityKeywordTokens = map[string]bool{
	"caucasian": true, "hispanic": true, "latino": true, "latina": true, "latinx": true,
	"ethnicity": true, "ethnic": true, "race": true, "racial": true,
	"muslim": true, "jewish": true, "christian": true, "hindu": true, "buddhist": true,
	"sikh": true, "atheist": true, "religion": true,
	"gay": true, "lesbian": true, "transgender": true, "disabled": true, "disability": true,
	"elderly": true, "teenager": true, "teen": true,
}

var identityKeywords = map[string]bool{
	"asian": true, "african": true, "black": true, "white": true, "indian": true, "arab": true,
	"man": true, "woman": true, "men": true, "women": true, "boy": true, "girl": true,
	"male": true, "female": true, "young": true, "old": true, "lady": true, "guy": true,
	"old man": true, "old woman": true, "young man": true, "young woman": true,
	"black man": true, "black woman": true, "white man": true, "white woman": true,
}

var reservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true, "com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true, "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

func isEmoji(r rune) bool {
	switch {
	case r >= 0x1F000 && r <= 0x1FAFF:
		return true
	case r >= 0x2600 && r <= 0x27BF:
		return true
	case r >= 0x2B00 && r <= 0x2BFF:
		return true
	case r >= 0x2300 && r <= 0x23FF:
		return true
	case r == 0xFE0F, r == 0x200D, r == 0x20E3, r == 0x203C, r == 0x2049, r == 0x2122, r == 0x2139:
		return true
	}
	return false
}

// stripEmoji removes emoji (and their joiners and variation selectors) and
// closes the gaps they leave.
func stripEmoji(s string) string {
	changed := false
	out := strings.Map(func(r rune) rune {
		if isEmoji(r) {
			changed = true
			return -1
		}
		return r
	}, s)
	if !changed {
		return s
	}
	return tidyLines(out)
}

// tidyLines collapses runs of spaces and trims every line.
func tidyLines(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSpace(spaces.ReplaceAllString(l, " "))
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func stripHashtags(s string) string {
	return hashtagWord.ReplaceAllString(s, "$1")
}

// capRunes cuts s to at most max runes, at a sentence end or a word
// boundary when one is close, and trims trailing punctuation that hangs.
func capRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	cut := string([]rune(s)[:max])
	if i := strings.LastIndexAny(cut, ".!?"); i > len(cut)/2 {
		return strings.TrimSpace(cut[:i+1])
	}
	if i := strings.LastIndexFunc(cut, unicode.IsSpace); i > len(cut)/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(strings.TrimSpace(cut), ",;:-–—(")
}

func upperFirst(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	if r == utf8.RuneError {
		return s
	}
	return string(unicode.ToUpper(r)) + s[n:]
}

// RepairAlt: one line, no hashtags or emoji, no "image of" opener, ≤ 250.
func RepairAlt(s string) string {
	s = oneLine(stripEmoji(stripHashtags(s)))
	s = strings.Trim(s, "\"“”")
	if loc := altOpener.FindStringIndex(s); loc != nil {
		s = upperFirst(s[loc[1]:])
	}
	return capRunes(s, AltHardCap)
}

// RepairCaption: no hashtags, emoji only when allowed, ≤ 2,200.
func RepairCaption(s string, emoji bool) string {
	s = tidyLines(stripHashtags(s))
	if !emoji {
		s = stripEmoji(s)
	}
	s = strings.Trim(s, "\"“”")
	return capRunes(s, CaptionMax)
}

// RepairDescription: plain text on one paragraph, no markdown stars, no
// hashtags or emoji.
func RepairDescription(s string) string {
	s = strings.NewReplacer("**", "", "__", "", "*", "").Replace(s)
	return oneLine(stripEmoji(stripHashtags(s)))
}

// RepairTitle: one line, ≤ 70, no trailing period.
func RepairTitle(s string) string {
	s = oneLine(stripEmoji(stripHashtags(s)))
	s = strings.Trim(s, "\"“”'")
	s = capRunes(s, TitleMax)
	return strings.TrimRight(s, ". ")
}

// splitTags splits "a, b  c" style text into words for hashtag parsing.
func splitTags(list []string) []string {
	var out []string
	for _, item := range list {
		out = append(out, strings.FieldsFunc(item, func(r rune) bool { return unicode.IsSpace(r) || r == ',' || r == ';' })...)
	}
	return out
}

func isTagRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) || r == '_'
}

// RepairHashtags returns at most n clean tags ("#word"): letters from any
// script, digits and underscores only, de-duplicated (case-insensitively),
// generic spam tags dropped. n ≤ 0 gives none. The result is never nil.
func RepairHashtags(list []string, n int) []string {
	out := []string{}
	if n <= 0 {
		return out
	}
	seen := map[string]bool{}
	for _, w := range splitTags(list) {
		w = strings.TrimLeft(w, "#＃")
		var b strings.Builder
		for _, r := range w {
			if isTagRune(r) {
				b.WriteRune(r)
			}
		}
		tag := b.String()
		if tag == "" || utf8.RuneCountInString(tag) > 40 {
			continue
		}
		allDigits := true
		for _, r := range tag {
			if !unicode.IsDigit(r) {
				allDigits = false
				break
			}
		}
		key := strings.ToLower(tag)
		if allDigits || spamHashtags[key] || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, "#"+tag)
		if len(out) == n {
			break
		}
	}
	return out
}

// RepairKeywords returns 0–25 lowercase, de-duplicated keywords without
// identity terms.
func RepairKeywords(list []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, item := range list {
		for _, k := range strings.Split(strings.ReplaceAll(item, "\n", ","), ",") {
			k = strings.ToLower(oneLine(strings.Trim(stripEmoji(k), " #\"'“”.;:")))
			if k == "" || utf8.RuneCountInString(k) > 40 || seen[k] || identityKeywords[k] {
				continue
			}
			bad := false
			for _, tok := range strings.Fields(k) {
				if identityKeywordTokens[tok] {
					bad = true
					break
				}
			}
			if bad {
				continue
			}
			seen[k] = true
			out = append(out, k)
			if len(out) == 25 {
				return out
			}
		}
	}
	return out
}

// cleanName makes s safe as a file name stem (Windows and macOS rules):
// invalid characters become spaces, no trailing dots or spaces, not a
// reserved device name.
func cleanName(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case strings.ContainsRune(`<>:"/\|?*`, r), unicode.IsControl(r):
			return ' '
		case isEmoji(r):
			return -1
		}
		return r
	}, s)
	s = strings.Trim(oneLine(s), ". ")
	if reservedNames[strings.ToLower(s)] {
		s += "_"
	}
	return s
}

// kebab lowercases s and joins its letters and digits with hyphens.
func kebab(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// ComposeName builds a file name stem (without extension) from the model's
// words: the pattern applied ({date} = yyyy-mm-dd, {n} = 1-based position as
// 01, 02, …), kebab-case when asked, sanitised, ≤ 60 characters in all.
// Empty when there are no usable words.
func ComposeName(name string, pat NamePattern, kebabCase bool, date string, n int) string {
	base := cleanName(name)
	if kebabCase {
		base = kebab(base)
	}
	if base == "" {
		return ""
	}
	sep := " "
	if kebabCase {
		sep = "-"
	}
	prefix := ""
	switch pat {
	case NameDate:
		if date != "" {
			prefix = date + sep
		}
	case NameNumber:
		prefix = fmt.Sprintf("%02d%s", n, sep)
	}
	room := max(NameMax-utf8.RuneCountInString(prefix), 8)
	if utf8.RuneCountInString(base) > room {
		base = strings.Trim(string([]rune(base)[:room]), " -_.")
	}
	return cleanName(prefix + base)
}

// RepairFields applies every repair for the wanted fields and clears none.
// date/n feed the name pattern. Fields the user edited (edited[f]) are left
// as they are.
func RepairFields(f Fields, want []Field, o Options, date string, n int, edited map[Field]bool) Fields {
	has := map[Field]bool{}
	for _, w := range want {
		has[w] = true
	}
	keep := func(k Field) bool { return has[k] && !edited[k] }
	out := f
	if keep(FieldAlt) {
		out.Alt = RepairAlt(f.Alt)
	}
	if keep(FieldDescription) {
		out.Description = RepairDescription(f.Description)
	}
	if keep(FieldCaption) {
		out.Caption = RepairCaption(f.Caption, o.Emoji)
	}
	if keep(FieldHashtags) {
		out.Hashtags = RepairHashtags(f.Hashtags, o.Hashtags)
	}
	if keep(FieldTitle) {
		out.Title = RepairTitle(f.Title)
	}
	if keep(FieldKeywords) {
		out.Keywords = RepairKeywords(f.Keywords)
	}
	if keep(FieldName) {
		out.Name = ComposeName(f.Name, o.NamePattern, o.Kebab, date, n)
	}
	if out.Hashtags == nil {
		out.Hashtags = []string{}
	}
	if out.Keywords == nil {
		out.Keywords = []string{}
	}
	return out
}
