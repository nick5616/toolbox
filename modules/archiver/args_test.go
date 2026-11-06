package archiver

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMonolithArgs(t *testing.T) {
	o := DefaultOptions()
	got := monolithArgs("https://e.com/a", "/t/page.html", "https://e.com/a", false, o)
	want := []string{"https://e.com/a", "-o", "/t/page.html", "-t", "60", "-M"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("default = %v, want %v", got, want)
	}

	o.NoJS, o.NoImages, o.TimeoutSec = true, true, 30
	got = monolithArgs("https://e.com/a", "/t/page.html", "https://e.com/a", false, o)
	want = []string{"https://e.com/a", "-o", "/t/page.html", "-t", "30", "-M", "-j", "-i"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("flags = %v, want %v", got, want)
	}

	got = monolithArgs("dom.html", "/t/page.html", "https://e.com/a", true, DefaultOptions())
	want = []string{"dom.html", "-o", "/t/page.html", "-t", "60", "-M", "-b", "https://e.com/a", "-I"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("rendered = %v, want %v", got, want)
	}
}

func TestBrowserArgs(t *testing.T) {
	dom := domArgs("/t/profile", "https://e.com/")
	pdf := pdfArgs("/t/profile", "/t/page.pdf", "https://e.com/")
	for _, args := range [][]string{dom, pdf} {
		for _, must := range []string{"--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--user-data-dir=/t/profile"} {
			if !contains(args, must) {
				t.Errorf("%v lacks %s", args, must)
			}
		}
		if args[len(args)-1] != "https://e.com/" {
			t.Errorf("url must be last: %v", args)
		}
		for _, a := range args {
			if strings.Contains(strings.ToLower(a), "remote-debugging") {
				t.Errorf("remote debugging flag: %s", a)
			}
		}
	}
	if !contains(dom, "--dump-dom") || contains(dom, "--no-pdf-header-footer") {
		t.Errorf("dom args wrong: %v", dom)
	}
	if !contains(pdf, "--print-to-pdf=/t/page.pdf") || contains(pdf, "--dump-dom") {
		t.Errorf("pdf args wrong: %v", pdf)
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func TestFindBrowser(t *testing.T) {
	existing := map[string]bool{}
	env := map[string]string{
		"ProgramFiles":      `C:\Program Files`,
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"LOCALAPPDATA":      `C:\Users\u\AppData\Local`,
		"HOME":              "/Users/u",
	}
	f := browserFinder{
		getenv: func(k string) string { return env[k] },
		exists: func(p string) bool { return existing[p] },
	}

	f.goos = "windows"
	if p, _ := f.find(); p != "" {
		t.Errorf("nothing installed, found %q", p)
	}
	edge := filepath.Join(`C:\Program Files (x86)`, "Microsoft", "Edge", "Application", "msedge.exe")
	chrome := filepath.Join(`C:\Users\u\AppData\Local`, "Google", "Chrome", "Application", "chrome.exe")
	existing[chrome] = true
	if p, n := f.find(); p != chrome || n != nameChrome {
		t.Errorf("local chrome: %q %q", p, n)
	}
	existing[edge] = true
	if p, n := f.find(); p != edge || n != nameEdge {
		t.Errorf("edge preferred: %q %q", p, n)
	}

	f.goos = "darwin"
	existing = map[string]bool{"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge": true}
	if p, n := f.find(); n != nameEdge || p == "" {
		t.Errorf("mac edge: %q %q", p, n)
	}
	existing["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] = true
	if _, n := f.find(); n != nameChrome {
		t.Errorf("mac chrome preferred, got %q", n)
	}
	f.goos = "linux"
	existing = map[string]bool{}
	if p, _ := f.find(); p != "" {
		t.Errorf("linux none: %q", p)
	}
}

func TestTitleNaming(t *testing.T) {
	titles := []struct{ html, want string }{
		{"<html><head><TITLE>  Hello\n  World </TITLE>", "Hello World"},
		{"<title>Tom &amp; Jerry</title>", "Tom & Jerry"},
		{"<title lang=en>x</title>", "x"},
		{"<html>no title</html>", ""},
	}
	for _, tc := range titles {
		if got := titleFromHTML(tc.html); got != tc.want {
			t.Errorf("titleFromHTML(%q) = %q, want %q", tc.html, got, tc.want)
		}
	}

	day := time.Date(2026, 11, 4, 9, 0, 0, 0, time.UTC)
	names := []struct{ title, host, want string }{
		{"Hello World", "example.com", "Hello World 2026-11-04"},
		{"", "example.com", "example.com 2026-11-04"},
		{`a/b\c:d*e?"f<g>h|i`, "example.com", "a b c d e f g h i 2026-11-04"},
		{"...", "example.com", "example.com 2026-11-04"},
		{"CON", "example.com", "CON_ 2026-11-04"},
		{strings.Repeat("x", 200), "h", strings.Repeat("x", 80) + " 2026-11-04"},
	}
	for _, tc := range names {
		if got := baseName(tc.title, tc.host, day); got != tc.want {
			t.Errorf("baseName(%q) = %q, want %q", tc.title, got, tc.want)
		}
	}

	if got := hostDir("https://WWW.Example.com:8443/x"); got != "www.example.com" {
		t.Errorf("hostDir = %q", got)
	}
	if got := hostDir("http://[::1]:80/"); got == "" || strings.ContainsAny(got, `:/\`) {
		t.Errorf("hostDir ipv6 = %q", got)
	}
}

func TestPlaceFileNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.html")
	writeFile(t, src, "new")
	out := filepath.Join(dir, "out")
	a, err := placeFile(src, out, "Page 2026-11-04", ".html")
	if err != nil {
		t.Fatal(err)
	}
	b, err := placeFile(src, out, "Page 2026-11-04", ".html")
	if err != nil {
		t.Fatal(err)
	}
	if a == b || filepath.Base(b) != "Page 2026-11-04 2.html" {
		t.Errorf("a=%s b=%s", a, b)
	}
}
