package focus

import "os"

// DryRun reports whether the engine must run in dry run (CLAUDE.md safety
// rule): TOOLBOX_FOCUS_DRYRUN=1, or a sandboxed boot (TOOLBOX_SUPPORT_DIR or
// TOOLBOX_WORKSPACE, i.e. workspace.Boot.Sandboxed) unless
// TOOLBOX_FOCUS_DRYRUN=0.
func DryRun(sandboxed bool) bool {
	return dryRunFlag(os.Getenv("TOOLBOX_FOCUS_DRYRUN"), sandboxed)
}

// DryRunFromEnv is DryRun for code that has no boot: a sandbox support dir or
// workspace in the environment counts as sandboxed.
func DryRunFromEnv() bool {
	return DryRun(os.Getenv("TOOLBOX_SUPPORT_DIR") != "" || os.Getenv("TOOLBOX_WORKSPACE") != "")
}

func dryRun(flag, supportDir string) bool { return dryRunFlag(flag, supportDir != "") }

func dryRunFlag(flag string, sandboxed bool) bool {
	switch flag {
	case "1", "true", "yes":
		return true
	case "0", "false", "no":
		return false
	}
	return sandboxed
}
