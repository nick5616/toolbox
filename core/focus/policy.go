package focus

import (
	"os"
	"regexp"
	"runtime"
	"strings"

	"toolbox/core"
)

// Policy (SPEC.md §1.3, §1.7): a pure allow/block decision plus rule
// matching. Nothing here touches the OS except os.Getenv for %VARS%.

// Verdict is the decision for one process.
type Verdict struct {
	Allow  bool
	Confer bool   // descendants inherit the allowance
	Reason string // "toolbox" | "windows" | "windows-extra" | "rule:<id>" | "child:<pid>" | "unknown" | "blocked" | "other-session"
}

// Ancestry looks up processes seen this session, including exited ones.
type Ancestry interface {
	Lookup(pid uint32) (ProcInfo, Verdict, bool)
}

// SessionPolicy is everything Decide needs about the session.
type SessionPolicy struct {
	Self        ProcInfo
	Session     uint32
	SystemRoot  string
	Rules       []AllowRule // Always + profile + extra
	Launched    []AllowRule
	ToolboxPIDs map[uint32]int64 // Toolbox and descendants seen so far → Created
}

// pathStyle says how paths are written and compared on this OS. Tests switch
// it to cover both flavours.
type pathStyle struct {
	windows bool
	mac     bool
}

var style = pathStyle{windows: runtime.GOOS == "windows", mac: runtime.GOOS == "darwin"}

// macSystemPrefixes is rule 3 on the Mac (SPEC.md §1.7).
var macSystemPrefixes = []string{
	"/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/private/var", "/Library/Application Support/Apple",
}

var envRe = regexp.MustCompile(`%([^%\\/]+)%`)

// expandVars expands %NAME% (and a leading ~ on the Mac). Unknown variables
// stay as they are, so they simply never match.
func expandVars(s string) string {
	if strings.Contains(s, "%") {
		s = envRe.ReplaceAllStringFunc(s, func(m string) string {
			if v := os.Getenv(m[1 : len(m)-1]); v != "" {
				return v
			}
			return m
		})
	}
	if style.mac && (s == "~" || strings.HasPrefix(s, "~/")) {
		if h, err := os.UserHomeDir(); err == nil {
			s = h + s[1:]
		}
	}
	return s
}

// segments splits a path into comparable segments: separators unified,
// `\\?\` removed, empty segments dropped, case folded.
func segments(p string) []string {
	if style.windows {
		switch {
		case strings.HasPrefix(p, `\\?\UNC\`):
			p = `\\` + p[len(`\\?\UNC\`):]
		case strings.HasPrefix(p, `\\?\`):
			p = p[len(`\\?\`):]
		}
		p = strings.ReplaceAll(p, "/", `\`)
	}
	sep := "/"
	if style.windows {
		sep = `\`
	}
	out := []string{}
	for _, s := range strings.Split(p, sep) {
		if s == "" || s == "." {
			continue
		}
		out = append(out, strings.ToLower(s))
	}
	return out
}

func matchSeg(rule, seg string) bool {
	i := strings.IndexByte(rule, '*')
	if i < 0 {
		return rule == seg
	}
	pre, suf := rule[:i], rule[i+1:]
	return len(seg) >= len(pre)+len(suf) && strings.HasPrefix(seg, pre) && strings.HasSuffix(seg, suf)
}

// underFolder reports whether path lies inside the folder tree (strictly:
// an image can't be the folder itself).
func underFolder(folder, path []string) bool {
	if len(folder) == 0 || len(path) <= len(folder) {
		return false
	}
	for i, f := range folder {
		if !matchSeg(f, path[i]) {
			return false
		}
	}
	return true
}

func sameExe(exe, path []string) bool {
	if len(exe) == 0 || len(exe) != len(path) {
		return false
	}
	for i, f := range exe {
		if !matchSeg(f, path[i]) {
			return false
		}
	}
	return true
}

// ruleMatches reports whether the image path is covered by the rule.
func ruleMatches(r AllowRule, path []string) bool {
	if len(path) == 0 {
		return false
	}
	rs := segments(expandVars(r.Path))
	switch r.Kind {
	case RuleFolder:
		return underFolder(rs, path)
	case RuleExe:
		return sameExe(rs, path)
	}
	return false
}

func isSystemPath(path []string, systemRoot string) bool {
	if style.mac {
		for _, p := range macSystemPrefixes {
			if underFolder(segments(p), path) {
				return true
			}
		}
		return false
	}
	if systemRoot == "" {
		return false
	}
	return underFolder(segments(systemRoot), path)
}

// descendsFromToolbox reports whether p is Toolbox or one of its seen descendants.
func descendsFromToolbox(p ProcInfo, s *SessionPolicy, seen Ancestry) bool {
	if p.PID != 0 && p.PID == s.Self.PID && (s.Self.Created == 0 || p.Created == s.Self.Created) {
		return true
	}
	if c, ok := s.ToolboxPIDs[p.PID]; ok && c == p.Created {
		return true
	}
	if pc, ok := s.ToolboxPIDs[p.ParentPID]; ok && pc <= p.Created {
		// The parent PID may have been reused by another program: trust it only
		// while the process seen under that PID is the Toolbox one.
		if seen == nil {
			return true
		}
		if info, _, found := seen.Lookup(p.ParentPID); !found || info.Created == pc {
			return true
		}
	}
	if p.ParentPID == s.Self.PID && p.ParentPID != 0 && s.Self.Created <= p.Created {
		return true
	}
	return false
}

// Decide is the pure allow/block decision (rules in SPEC order, first match wins).
func Decide(p ProcInfo, s *SessionPolicy, seen Ancestry) Verdict {
	// 1. Other sessions are ignored.
	if p.Session != s.Session {
		return Verdict{Allow: true, Reason: "other-session"}
	}
	// 2. Toolbox and its descendants, and apps it launched.
	if descendsFromToolbox(p, s, seen) {
		return Verdict{Allow: true, Confer: true, Reason: "toolbox"}
	}
	path := segments(p.Path)
	if p.Path == "" {
		path = nil
	}
	for _, r := range s.Launched {
		if ruleMatches(r, path) {
			return Verdict{Allow: true, Confer: true, Reason: "toolbox"}
		}
	}
	// 3. The OS's own folders; they don't confer.
	if len(path) > 0 && isSystemPath(path, s.SystemRoot) {
		return Verdict{Allow: true, Reason: "windows"}
	}
	// 3b. Windows extras; they don't confer.
	for _, x := range WindowsExtras() {
		if underFolder(segments(expandVars(x)), path) {
			return Verdict{Allow: true, Reason: "windows-extra"}
		}
	}
	// 4. Allow rules.
	for _, r := range s.Rules {
		if ruleMatches(r, path) {
			return Verdict{Allow: true, Confer: r.Children, Reason: "rule:" + r.ID}
		}
	}
	// 5. Child of an allowed app.
	if seen != nil {
		childCreated, parent := p.Created, p.ParentPID
		for depth := 0; depth < 64 && parent != 0; depth++ {
			info, v, ok := seen.Lookup(parent)
			if !ok || info.Created > childCreated { // unseen, or the PID was reused
				break
			}
			if !v.Allow {
				break
			}
			if v.Confer {
				return Verdict{Allow: true, Confer: true, Reason: "child:" + uitoa(info.PID)}
			}
			childCreated, parent = info.Created, info.ParentPID
		}
	}
	// 6. Unknown path: fail open.
	if p.Path == "" {
		return Verdict{Allow: true, Reason: "unknown"}
	}
	// 7. Blocked.
	return Verdict{Reason: "blocked"}
}

func uitoa(n uint32) string {
	if n == 0 {
		return "0"
	}
	var b [10]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// tooBroadMessage is shown when a folder rule would cover too many programs.
const tooBroadMessage = "That folder holds too many programs. Pick the app's own folder."

// CheckRule validates a rule: kind, absolute path, at most one "*" in one
// segment, label length, and refuses folders that hold too many programs.
func CheckRule(r AllowRule) error {
	bad := func(field, msg string) error {
		return core.ValidationError(msg, map[string]string{field: msg})
	}
	label := strings.TrimSpace(r.Label)
	if label == "" || len([]rune(label)) > MaxRuleLabel {
		return bad("label", "Give the app a name of 1 to 60 characters")
	}
	if r.Kind != RuleFolder && r.Kind != RuleExe {
		return bad("kind", "A rule is either a folder or a program")
	}
	p := strings.TrimSpace(r.Path)
	if p == "" || !isAbsolute(p) {
		return bad("path", "Use the full path of the program or folder")
	}
	if n := strings.Count(p, "*"); n > 1 {
		return bad("path", "A path can have one * in one folder or file name")
	}
	if style.windows && strings.ContainsAny(p, "?\"<>|") {
		return bad("path", "That path has characters Windows doesn't allow")
	}
	if r.Kind == RuleFolder && (BroadFolder(p) || wildcardTooBroad(p)) {
		return bad("path", tooBroadMessage)
	}
	return nil
}

// minWildcardLiteral is how many fixed characters a wildcard segment needs
// when it sits directly inside a broad folder (`WindowsApps\Microsoft.WindowsTerminal_*`
// is fine; `Program Files\Di*` isn't).
const minWildcardLiteral = 8

// wildcardTooBroad reports whether a folder rule with a "*" would cover too
// many programs: the wildcard segment is just "*" (everything under its
// parent), or its parent folder is broad and the segment has fewer than
// minWildcardLiteral fixed characters.
func wildcardTooBroad(p string) bool {
	i := strings.IndexByte(p, '*')
	if i < 0 {
		return false
	}
	start := strings.LastIndexAny(p[:i], `\/`) + 1
	end := len(p)
	if j := strings.IndexAny(p[i:], `\/`); j >= 0 {
		end = i + j
	}
	seg, parent := p[start:end], p[:start]
	if seg == "*" {
		return true
	}
	return len(seg)-1 < minWildcardLiteral && BroadFolder(parent)
}

func isAbsolute(p string) bool {
	if strings.HasPrefix(p, "%") {
		return true
	}
	if style.windows {
		if strings.HasPrefix(p, `\\`) {
			return true
		}
		return len(p) >= 3 && p[1] == ':' && (p[2] == '\\' || p[2] == '/') &&
			((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z'))
	}
	return strings.HasPrefix(p, "/") || strings.HasPrefix(p, "~/")
}

// WindowsExtras is the frozen list of allowed, non-conferring folders outside
// the system folder for this OS (SPEC.md §1.3 rule 3b, §1.7).
func WindowsExtras() []string {
	if !style.windows {
		return []string{}
	}
	return []string{
		`%ProgramFiles%\Windows Defender`,
		`%ProgramFiles%\Common Files\microsoft shared\ink`,
		`%ProgramFiles%\WindowsApps\MicrosoftWindows.*`,
		`%ProgramFiles(x86)%\Microsoft\EdgeWebView`,
	}
}

var broadWindows = []string{
	`%SystemRoot%`, `%windir%`, `%SystemDrive%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramW6432%`,
	`%ProgramData%`, `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`, `%LOCALAPPDATA%\Programs`,
	`%ProgramFiles%\WindowsApps`, `%SystemDrive%\Users`,
	`%USERPROFILE%\Desktop`, `%USERPROFILE%\Downloads`, `%USERPROFILE%\Documents`,
	`%USERPROFILE%\AppData`, `%USERPROFILE%\AppData\Local`, `%USERPROFILE%\AppData\Roaming`,
}

var broadMac = []string{
	"/", "/Applications", "/System", "/System/Applications", "/Library", "/Users", "/Volumes", "/usr", "/usr/local",
	"/bin", "/sbin", "/opt", "/private", "/private/var",
	"~", "~/Applications", "~/Library", "~/Desktop", "~/Downloads", "~/Documents",
}

func joinSegs(s []string) string { return strings.Join(s, "/") }

// BroadFolder reports whether a folder rule at path would be refused as too
// broad (SPEC.md §1.3: drive roots, %SystemRoot%, %ProgramFiles%, …; on macOS
// §1.7). %VARS% are expanded first. modules/focus uses it to fall back to an
// exe rule when guessing an install root.
func BroadFolder(path string) bool {
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	cands := map[string]bool{joinSegs(segments(path)): true, joinSegs(segments(expandVars(path))): true}
	// A drive root ("C:\", "C:") or a bare root.
	for c := range cands {
		if style.windows && len(c) == 2 && c[1] == ':' {
			return true
		}
		if !style.windows && c == "" {
			return true
		}
	}
	list := broadMac
	if style.windows {
		list = broadWindows
	}
	for _, b := range list {
		for _, v := range []string{b, expandVars(b)} {
			if k := joinSegs(segments(v)); k != "" && cands[k] {
				return true
			}
		}
	}
	return false
}
