package downloader

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

var versionRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// runtimeSupported reports whether a JS runtime's `--version` output meets
// yt-dlp's EJS minimums (deno >= 2.3.0, node >= 22.0.0).
func runtimeSupported(name, versionOutput string) bool {
	m := versionRe.FindStringSubmatch(versionOutput)
	if m == nil {
		return false
	}
	var v [3]int
	for i := range v {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	var need [3]int
	switch name {
	case "deno":
		need = [3]int{2, 3, 0}
	case "node":
		need = [3]int{22, 0, 0}
	default:
		return false
	}
	for i := range v {
		if v[i] != need[i] {
			return v[i] > need[i]
		}
	}
	return true
}

// selectJSRuntime picks "deno:<path>" or "node:<path>" (or "") and logs why.
func selectJSRuntime(ctx context.Context, job *core.JobContext) string {
	check := func(name string) (path, ver string, ok bool) {
		p, err := job.Tool(name)
		if err != nil {
			return "", "", false
		}
		out, err := proc.Output(ctx, 5*time.Second, p, "--version")
		if err != nil {
			return p, "", false
		}
		out = strings.TrimSpace(out)
		return p, out, runtimeSupported(name, out)
	}
	if p, out, ok := check("deno"); ok {
		return "deno:" + p
	} else if p != "" {
		job.Logf("Deno %q is too old for yt-dlp (needs 2.3+); update Deno: %s", out, denoInstallHint())
	}
	if p, out, ok := check("node"); ok {
		job.Logf("Using Node.js as JavaScript runtime")
		return "node:" + p
	} else if p != "" {
		job.Logf("Node.js %s is too old for yt-dlp (needs 22+); install Deno: %s", out, denoInstallHint())
		return ""
	}
	job.Logf("No JavaScript runtime found; some YouTube formats may be unavailable. Install Deno: %s", denoInstallHint())
	return ""
}
