package focus

import "toolbox/core"

// Policy (SPEC.md §1.3). Wave 0 stub; WP-F1 implements it.

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

// Decide is the pure allow/block decision (rules in SPEC order, first match wins).
func Decide(p ProcInfo, s *SessionPolicy, seen Ancestry) Verdict {
	return Verdict{Allow: true, Reason: "unknown"}
}

// CheckRule validates a rule: kind, absolute path, at most one "*" in one
// segment, label length, and refuses folders that hold too many programs.
func CheckRule(r AllowRule) error { return core.NotImplemented("Focus rules") }

// WindowsExtras is the frozen list of allowed, non-conferring folders outside
// the system folder for this OS (SPEC.md §1.3 rule 3b, §1.7).
func WindowsExtras() []string { return []string{} }

// BroadFolder reports whether a folder rule at path would be refused as too
// broad (SPEC.md §1.3: drive roots, %SystemRoot%, %ProgramFiles%, …; on macOS
// §1.7). %VARS% are expanded first. modules/focus uses it to fall back to an
// exe rule when guessing an install root. Wave 0 stub; WP-F1 implements it.
func BroadFolder(path string) bool { return false }
