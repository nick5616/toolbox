package desktop

import (
	"strings"
	"testing"
)

func TestParseLaunch(t *testing.T) {
	tests := []struct {
		name string
		args []string
		rest string
		pid  int
		hint *WindowHint
	}{
		{"none", []string{"a.png", "--workspace", "w"}, "a.png|--workspace|w", 0, nil},
		{"both", []string{"--after-pid=4242", "x", "--window=-1910,20,1400,900"}, "x", 4242, &WindowHint{X: -1910, Y: 20, Width: 1400, Height: 900}},
		{"maximised", []string{"--window=max"}, "", 0, &WindowHint{Maximised: true}},
		{"bad values are dropped", []string{"--after-pid=abc", "--window=1,2,3", "y"}, "y", 0, nil},
		{"absurd size is dropped", []string{"--window=0,0,50,50"}, "", 0, nil},
		{"negative pid", []string{"--after-pid=-3"}, "", 0, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rest, pid, hint := ParseLaunch(tt.args)
			if strings.Join(rest, "|") != tt.rest || pid != tt.pid {
				t.Fatalf("rest %v pid %d", rest, pid)
			}
			if (hint == nil) != (tt.hint == nil) || (hint != nil && *hint != *tt.hint) {
				t.Fatalf("hint %+v, want %+v", hint, tt.hint)
			}
		})
	}
}

func TestWindowHintRoundTrip(t *testing.T) {
	for _, h := range []WindowHint{{X: 10, Y: -5, Width: 1500, Height: 950}, {Maximised: true}} {
		_, _, got := ParseLaunch([]string{h.Arg()})
		if got == nil || *got != h {
			t.Fatalf("%+v → %q → %+v", h, h.Arg(), got)
		}
	}
}

func TestLaunchArgsDropsPreviousRelaunchArgs(t *testing.T) {
	got := LaunchArgs([]string{"--workspace", "old", "--after-pid=9", "--window=1,2,1300,800", "f.png"}, []string{"--workspace", "new"})
	if s := strings.Join(got, "|"); s != "f.png|--workspace|new" {
		t.Fatalf("got %s", s)
	}
}

func TestDefaultWindowSize(t *testing.T) {
	tests := []struct{ workW, workH, w, h int }{
		{0, 0, 1200, 780},       // screen unknown
		{2560, 1400, 1200, 780}, // room: wide enough for the named sidebar
		{1100, 700, 1100, 700},  // small screen: fits the work area
		{900, 500, 960, 600},    // never below the minimum window
	}
	for _, tt := range tests {
		if w, h := DefaultWindowSize(tt.workW, tt.workH); w != tt.w || h != tt.h {
			t.Errorf("work %dx%d → %dx%d, want %dx%d", tt.workW, tt.workH, w, h, tt.w, tt.h)
		}
	}
}
