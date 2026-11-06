package deps

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

const versionTimeout = 5 * time.Second

func lookPath(file string) (string, error) { return exec.LookPath(file) }

func defaultKnownDirs(goos string) []string {
	home, _ := os.UserHomeDir()
	join := func(base string, parts ...string) string {
		if base == "" {
			return ""
		}
		return filepath.Join(append([]string{base}, parts...)...)
	}
	var dirs []string
	switch goos {
	case "darwin":
		dirs = []string{"/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", join(home, ".deno", "bin")}
	case "windows":
		profile := os.Getenv("USERPROFILE")
		if profile == "" {
			profile = home
		}
		dirs = []string{
			join(os.Getenv("LOCALAPPDATA"), "Microsoft", "WinGet", "Links"),
			join(profile, "scoop", "shims"),
			join(profile, ".deno", "bin"),
			join(os.Getenv("ProgramFiles"), "nodejs"),
		}
	default:
		dirs = []string{"/usr/local/bin", join(home, ".deno", "bin")}
	}
	out := dirs[:0]
	for _, d := range dirs {
		if d != "" {
			out = append(out, d)
		}
	}
	return out
}

func (s *Service) exeName(binary string) string {
	if s.goos == "windows" {
		return binary + ".exe"
	}
	return binary
}

func isFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

// find applies the resolution order.
func (s *Service) find(sp Spec) (string, core.DepSource) {
	name := s.exeName(sp.Binary)
	if sp.VersionFile != "" {
		// Pinned archive installs only count in their own folder: the
		// binary needs the models and DLLs installed beside it.
		if s.binDir != "" && sp.ArchiveDir != "" {
			if p := filepath.Join(s.binDir, sp.ArchiveDir, name); isFile(p) {
				return p, core.SourceManaged
			}
		}
		// AllowSystem tools (FFmpeg, Deno) fall back to a system copy.
		if !sp.AllowSystem {
			return "", core.SourceNone
		}
	}
	if s.binDir != "" && sp.VersionFile == "" {
		if sp.ArchiveDir != "" {
			if p := filepath.Join(s.binDir, sp.ArchiveDir, name); isFile(p) {
				return p, core.SourceManaged
			}
		}
		if p := filepath.Join(s.binDir, name); isFile(p) {
			return p, core.SourceManaged
		}
	}
	if s.lookPath != nil {
		if p, err := s.lookPath(name); err == nil && p != "" {
			if abs, err := filepath.Abs(p); err == nil {
				p = abs
			}
			return p, core.SourcePath
		}
	}
	if s.knownDirs != nil {
		for _, d := range s.knownDirs() {
			if p := filepath.Join(d, name); isFile(p) {
				return p, core.SourceKnownDir
			}
		}
	}
	return "", core.SourceNone
}

func (s *Service) hint(sp Spec) string { return sp.InstallHint[s.goos] }

func (s *Service) missing(sp Spec) core.DepStatus {
	return core.DepStatus{
		ID: sp.ID, Name: sp.Name, Purpose: sp.Purpose,
		State: core.DepMissing, Source: core.SourceNone, Managed: sp.Managed,
		RequiredBy: []string{}, RecommendedBy: []string{},
		InstallHint: s.hint(sp),
	}
}

// detectOne checks a single dependency (no registry-derived fields).
func (s *Service) detectOne(ctx context.Context, sp Spec) core.DepStatus {
	st := s.missing(sp)
	st.CheckedAt = time.Now().UnixMilli()
	path, src := s.find(sp)
	if path == "" {
		return st
	}
	st.Path, st.Source = path, src
	if sp.VersionFile != "" && src == core.SourceManaged {
		// The binary only has to exist; the version is the VERSION file.
		b, err := os.ReadFile(filepath.Join(s.binDir, sp.ArchiveDir, sp.VersionFile))
		v := strings.TrimSpace(string(b))
		if err != nil || v == "" {
			st.State = core.DepOutdated
			return st
		}
		st.Version = v
		st.State = core.DepOK
		if sp.PinnedVersion != "" && v != sp.PinnedVersion {
			st.State = core.DepOutdated
		}
		return st
	}
	out, err := proc.Output(ctx, versionTimeout, path, sp.VersionArgs...)
	if err != nil {
		st.State = core.DepError
		st.Error = err.Error()
		return st
	}
	v := parseVersion(sp, out)
	if v == "" {
		st.State = core.DepError
		st.Error = "Couldn't read the version from: " + firstLine(out)
		return st
	}
	if sp.MinVersion != "" && versionLess(v, sp.MinVersion) {
		// Too old to use: report it as missing so the managed copy gets
		// installed (or the hint shown).
		st.State = core.DepMissing
		st.Path, st.Source = "", core.SourceNone
		st.Error = fmt.Sprintf("%s %s is too old (%s or newer is needed)", sp.Name, v, sp.MinVersion)
		return st
	}
	st.State = core.DepOK
	st.Version = v
	// A system copy of an AllowSystem tool is never "outdated": the pin only
	// applies to the app's own install.
	if sp.PinnedVersion != "" && v != sp.PinnedVersion && !sp.AllowSystem {
		st.State = core.DepOutdated
	}
	return st
}

func parseVersion(sp Spec, out string) string {
	if sp.VersionRegex == nil {
		return firstLine(out)
	}
	m := sp.VersionRegex.FindStringSubmatch(out)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// versionLess reports whether dotted numeric version a is older than b.
// Non-numeric suffixes ("1-rc1") are ignored; missing parts count as 0.
func versionLess(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func versionParts(v string) []int {
	var out []int
	for _, f := range strings.Split(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".") {
		n := 0
		for _, c := range f {
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
		}
		out = append(out, n)
	}
	return out
}
