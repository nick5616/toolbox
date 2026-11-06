package focus

import "os"

// DryRunFromEnv reports whether the engine must run in dry run (CLAUDE.md
// safety rule, SPEC.md §0): TOOLBOX_FOCUS_DRYRUN=1, or a sandboxed support
// dir (TOOLBOX_SUPPORT_DIR set) unless TOOLBOX_FOCUS_DRYRUN=0.
func DryRunFromEnv() bool {
	return dryRun(os.Getenv("TOOLBOX_FOCUS_DRYRUN"), os.Getenv("TOOLBOX_SUPPORT_DIR"))
}

func dryRun(flag, supportDir string) bool {
	switch flag {
	case "1", "true", "yes":
		return true
	case "0", "false", "no":
		return false
	}
	return supportDir != ""
}
