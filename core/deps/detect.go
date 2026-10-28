package deps

import (
	"context"
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
	if s.binDir != "" {
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
	st.State = core.DepOK
	st.Version = v
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
