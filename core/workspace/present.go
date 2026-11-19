package workspace

import (
	"os"
	"runtime"
	"strings"
	"unicode"
)

// NewPresenter builds the Presenter for a workspace (Present on hides the
// root and the home folder). Home comes from the OS.
func NewPresenter(info Info) Presenter {
	home, _ := os.UserHomeDir()
	return Presenter{On: info.Present, Root: info.Root, Name: info.Name, Home: home}
}

// fold is true when path comparison ignores case (Windows-style paths).
func (pr Presenter) fold(p string) bool {
	return runtime.GOOS == "windows" || isWinLike(p)
}

func isWinLike(p string) bool {
	return len(p) >= 2 && p[1] == ':' || strings.HasPrefix(p, `\\`)
}

func trimSeps(s string) string { return strings.TrimRight(s, `\/`) }

// Path returns p as the UI should show it: inside the root → "<Name>/…",
// inside home → "~/…", else unchanged. Output uses "/" separators.
func (pr Presenter) Path(p string) string {
	if !pr.On || p == "" {
		return p
	}
	if rest, ok := pr.under(p, pr.Root); ok {
		return join(pr.Name, rest)
	}
	if rest, ok := pr.under(p, pr.Home); ok {
		return join("~", rest)
	}
	return p
}

func join(prefix, rest string) string {
	if rest == "" {
		return prefix
	}
	return prefix + "/" + rest
}

// under reports whether p is base or inside it, and the "/"-separated rest.
func (pr Presenter) under(p, base string) (string, bool) {
	base = trimSeps(base)
	if base == "" {
		return "", false
	}
	pp := strings.ReplaceAll(p, `\`, "/")
	bb := strings.ReplaceAll(base, `\`, "/")
	if pr.fold(base) {
		if len(pp) < len(bb) || !strings.EqualFold(pp[:len(bb)], bb) {
			return "", false
		}
	} else if !strings.HasPrefix(pp, bb) {
		return "", false
	}
	rest := pp[len(bb):]
	if rest != "" && rest[0] != '/' {
		return "", false
	}
	return strings.Trim(rest, "/"), true
}

// Text rewrites every occurrence of the root and home in s (either slash
// style, JSON-escaped backslashes too); the path that follows an occurrence
// gets "/" separators.
func (pr Presenter) Text(s string) string {
	if !pr.On || s == "" {
		return s
	}
	s = pr.replaceAll(s, pr.Root, pr.Name)
	return pr.replaceAll(s, pr.Home, "~")
}

func (pr Presenter) replaceAll(s, base, repl string) string {
	base = trimSeps(base)
	if base == "" {
		return s
	}
	fwd := strings.ReplaceAll(base, `\`, "/")
	variants := []string{base, fwd, strings.ReplaceAll(base, `\`, `\\`)}
	fold := pr.fold(base)
	for _, v := range variants {
		s = replaceBounded(s, v, repl, fold)
	}
	return s
}

func isNameChar(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-'
}

func isPathTail(r rune) bool {
	return !unicode.IsSpace(r) && !strings.ContainsRune(`"'<>|)]},;`, r)
}

func replaceBounded(s, needle, repl string, fold bool) string {
	if needle == "" {
		return s
	}
	hay := s
	nd := needle
	if fold {
		lh := strings.ToLower(s)
		if len(lh) == len(s) { // ASCII-safe folding keeps byte offsets
			hay, nd = lh, strings.ToLower(needle)
		}
	}
	var b strings.Builder
	i := 0
	for i < len(s) {
		j := strings.Index(hay[i:], nd)
		if j < 0 {
			break
		}
		j += i
		end := j + len(nd)
		if end < len(s) {
			if r := []rune(s[end:])[0]; isNameChar(r) {
				b.WriteString(s[i:end])
				i = end
				continue
			}
		}
		b.WriteString(s[i:j])
		b.WriteString(repl)
		i = end
		// the rest of the path: "\" becomes "/"
		for i < len(s) {
			r := []rune(s[i:])[0]
			if !isPathTail(r) {
				break
			}
			if r == '\\' {
				if strings.HasPrefix(s[i:], `\\`) {
					b.WriteByte('/')
					i += 2
					continue
				}
				b.WriteByte('/')
			} else {
				b.WriteRune(r)
			}
			i += len(string(r))
		}
	}
	b.WriteString(s[i:])
	return b.String()
}
