package focus

import "testing"

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
