package archiver

import (
	"strconv"
)

func withDefaults(o Options) Options {
	if o.TimeoutSec == 0 {
		o.TimeoutSec = DefaultTimeoutSec
	}
	return o
}

// monolithArgs builds monolith's argv. source is a URL, or (with rendered)
// the saved DOM file relative to the process's working directory, in which
// case baseURL resolves relative links and -I isolates the document.
func monolithArgs(source, out, baseURL string, rendered bool, o Options) []string {
	args := []string{source, "-o", out, "-t", strconv.Itoa(o.TimeoutSec), "-M"}
	if o.NoJS {
		args = append(args, "-j")
	}
	if o.NoImages {
		args = append(args, "-i")
	}
	if rendered {
		args = append(args, "-b", baseURL, "-I")
	}
	return args
}

// browserBase are the flags every headless run gets. There is deliberately no
// remote-debugging flag anywhere: the browser must not open a port.
func browserBase(profileDir string) []string {
	return []string{
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--user-data-dir=" + profileDir,
	}
}

// domArgs dumps the rendered DOM of url to stdout.
func domArgs(profileDir, url string) []string {
	return append(browserBase(profileDir), "--dump-dom", url)
}

// pdfArgs prints url to pdfPath.
func pdfArgs(profileDir, pdfPath, url string) []string {
	return append(browserBase(profileDir), "--no-pdf-header-footer", "--print-to-pdf="+pdfPath, url)
}
