package focus

import "testing"

func TestDryRunSandboxedBoot(t *testing.T) {
	for _, tt := range []struct {
		flag      string
		sandboxed bool
		want      bool
	}{
		{"", false, false},
		{"", true, true}, // TOOLBOX_WORKSPACE or TOOLBOX_SUPPORT_DIR
		{"0", true, false},
		{"1", false, true},
	} {
		t.Setenv("TOOLBOX_FOCUS_DRYRUN", tt.flag)
		if got := DryRun(tt.sandboxed); got != tt.want {
			t.Errorf("DryRun(flag %q, sandboxed %v) = %v, want %v", tt.flag, tt.sandboxed, got, tt.want)
		}
	}
	t.Setenv("TOOLBOX_FOCUS_DRYRUN", "")
	t.Setenv("TOOLBOX_SUPPORT_DIR", "")
	t.Setenv("TOOLBOX_WORKSPACE", `C:\ws`)
	if !DryRunFromEnv() {
		t.Error("TOOLBOX_WORKSPACE must count as sandboxed")
	}
}

func TestDryRun(t *testing.T) {
	for _, tt := range []struct {
		flag, dir string
		want      bool
	}{
		{"", "", false},
		{"1", "", true},
		{"", `C:\repo\.dev\support`, true},
		{"0", `C:\repo\.dev\support`, false},
		{"true", "", true},
	} {
		if got := dryRun(tt.flag, tt.dir); got != tt.want {
			t.Errorf("dryRun(%q, %q) = %v, want %v", tt.flag, tt.dir, got, tt.want)
		}
	}
}
