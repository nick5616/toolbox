package proc

import (
	"slices"
	"testing"
)

func TestMacOpenArgs(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   LaunchSpec
		want []string
	}{
		{"plain", LaunchSpec{Path: "/Applications/X.app"}, []string{"-a", "/Applications/X.app"}},
		{"minimized", LaunchSpec{Path: "/Applications/X.app", Minimized: true}, []string{"-a", "/Applications/X.app", "-g"}},
		{"args", LaunchSpec{Path: "/A/X.app", Args: []string{"a b", "-c"}}, []string{"-a", "/A/X.app", "--args", "a b", "-c"}},
		{"both", LaunchSpec{Path: "/A/X.app", Minimized: true, Args: []string{"f"}}, []string{"-a", "/A/X.app", "-g", "--args", "f"}},
	} {
		if got := macOpenArgs(tc.in); !slices.Equal(got, tc.want) {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}
