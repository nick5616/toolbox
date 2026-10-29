package media

import (
	"math"
	"os"
	"strings"
	"testing"

	"toolbox/core"
)

// feed applies lines and returns the last reported update and how many there were.
func feed(t *ProgressTracker, lines ...string) (pct float64, msg string, n int) {
	for _, l := range lines {
		if p, m, ok := t.Apply(l); ok {
			pct, msg = p, m
			n++
		}
	}
	return
}

func TestProgressTranscript(t *testing.T) {
	data, err := os.ReadFile("testdata/progress.txt")
	if err != nil {
		t.Fatal(err)
	}
	tr := &ProgressTracker{Duration: 3}
	pct, msg, n := feed(tr, strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")...)
	if n != 1 || pct != 1 || msg == "" {
		t.Errorf("pct=%v msg=%q n=%d", pct, msg, n)
	}
	if tr.outTime != 3 || tr.speed != 1180 {
		t.Errorf("outTime=%v speed=%v", tr.outTime, tr.speed)
	}
}

func TestProgressMidRun(t *testing.T) {
	tr := &ProgressTracker{Duration: 100}
	pct, msg, _ := feed(tr, "out_time_us=50000000", "speed=2.4x", "progress=continue")
	if math.Abs(pct-0.5) > 1e-9 {
		t.Errorf("pct = %v", pct)
	}
	if msg != "Converting · 2.4× · ETA 0:21" {
		t.Errorf("msg = %q", msg)
	}
}

func TestProgressClamp(t *testing.T) {
	tr := &ProgressTracker{Duration: 10}
	pct, _, _ := feed(tr, "out_time_us=12000000", "speed=1x", "progress=continue")
	if pct != 0.99 {
		t.Errorf("pct = %v", pct)
	}
}

func TestProgressUnknownDuration(t *testing.T) {
	tr := &ProgressTracker{}
	pct, msg, _ := feed(tr, "out_time_us=5000000", "speed=1x", "progress=continue")
	if pct != core.IndeterminateProgress || msg != "Converting…" {
		t.Errorf("pct=%v msg=%q", pct, msg)
	}
}

func TestProgressSpeedNA(t *testing.T) {
	tr := &ProgressTracker{Duration: 10}
	pct, msg, _ := feed(tr, "out_time_us=5000000", "speed=N/A", "progress=continue")
	if pct != 0.5 || msg != "Converting…" {
		t.Errorf("pct=%v msg=%q", pct, msg)
	}
}

func TestProgressIgnoresNoise(t *testing.T) {
	tr := &ProgressTracker{Duration: 10}
	if _, _, n := feed(tr, "garbage", "out_time_us=N/A", "bitrate=1kbits/s"); n != 0 {
		t.Error("unexpected change")
	}
}

func TestFormatETA(t *testing.T) {
	for in, want := range map[float64]string{-3: "0:00", 31: "0:31", 61.4: "1:01", 3725: "1:02:05"} {
		if got := formatETA(in); got != want {
			t.Errorf("formatETA(%v) = %q, want %q", in, got, want)
		}
	}
}
