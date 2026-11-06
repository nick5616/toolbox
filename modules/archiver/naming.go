package archiver

import (
	"html"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

var titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

// maxTitleScan is how much of the saved page is searched for <title>.
const maxTitleScan = 512 * 1024

// pageTitle returns the <title> of the HTML file, or "".
func pageTitle(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, maxTitleScan))
	return titleFromHTML(string(b))
}

func titleFromHTML(s string) string {
	m := titleRe.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return strings.Join(strings.Fields(html.UnescapeString(m[1])), " ")
}

var reservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true, "com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true, "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

const maxNameRunes = 80

// sanitizeName makes s safe as a file or folder name on Windows and macOS.
func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x20 || r == 0x7f || unicode.Is(unicode.Cf, r):
			b.WriteRune(' ')
		case strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	if rs := []rune(out); len(rs) > maxNameRunes {
		out = strings.TrimSpace(string(rs[:maxNameRunes]))
	}
	out = strings.Trim(out, " .")
	if reservedNames[strings.ToLower(out)] {
		out += "_"
	}
	return out
}

// hostDir is the folder name for a URL's host.
func hostDir(rawURL string) string {
	host := ""
	if u, err := url.Parse(strings.TrimSpace(rawURL)); err == nil {
		host = strings.ToLower(u.Hostname())
	}
	host = sanitizeName(host)
	if host == "" {
		host = "page"
	}
	return host
}

// baseName is "<title or host> <yyyy-mm-dd>" (no extension).
func baseName(title, host string, t time.Time) string {
	name := sanitizeName(title)
	if name == "" {
		name = host
	}
	return name + " " + t.Format("2006-01-02")
}

// placeFile copies src into dir as "<stem><ext>", adding " 2", " 3" … when
// the name is taken. It never overwrites; it returns the final path.
func placeFile(src, dir, stem, ext string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	for n := 1; n < 10000; n++ {
		name := stem + ext
		if n > 1 {
			name = stem + " " + strconv.Itoa(n) + ext
		}
		dst := filepath.Join(dir, name)
		out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if _, err := in.Seek(0, io.SeekStart); err != nil {
			out.Close()
			return "", err
		}
		_, cerr := io.Copy(out, in)
		if clerr := out.Close(); cerr == nil {
			cerr = clerr
		}
		if cerr != nil {
			os.Remove(dst)
			return "", cerr
		}
		return dst, nil
	}
	return "", os.ErrExist
}
