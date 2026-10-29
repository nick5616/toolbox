package converter

import "testing"

func TestParseDuration(t *testing.T) {
	for in, want := range map[string]float64{"3.000000\n": 3, "": 0, "N/A": 0, "-1": 0, "12.5": 12.5} {
		if got := parseDuration(in); got != want {
			t.Errorf("parseDuration(%q) = %v, want %v", in, got, want)
		}
	}
}
