package lyricvideo

import (
	"testing"

	"toolbox/core"
)

func TestValidateLines(t *testing.T) {
	ok := []LyricLine{{StartMs: 0, EndMs: 10}, {StartMs: 10, EndMs: 20}}
	tests := []struct {
		name  string
		lines []LyricLine
		bad   bool
	}{
		{"ok", ok, false},
		{"empty", nil, true},
		{"too many", make([]LyricLine, 2001), true},
		{"end before start", []LyricLine{{StartMs: 10, EndMs: 5}}, true},
		{"negative", []LyricLine{{StartMs: -1, EndMs: 5}}, true},
		{"out of order", []LyricLine{{StartMs: 10, EndMs: 12}, {StartMs: 5, EndMs: 6}}, true},
		{"overlapping ends are tolerated", []LyricLine{{StartMs: 0, EndMs: 50}, {StartMs: 10, EndMs: 60}}, false},
	}
	for _, tc := range tests {
		err := validateLines(tc.lines)
		if (err != nil) != tc.bad || (err != nil && !core.IsCode(err, core.CodeValidation)) {
			t.Errorf("%s: err = %v", tc.name, err)
		}
	}
}
