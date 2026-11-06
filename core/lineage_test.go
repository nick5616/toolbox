package core

import (
	"reflect"
	"testing"
)

func TestLineageInputs(t *testing.T) {
	a, b := `C:\x\photo.jpg`, `C:\x\other.png`
	tests := []struct {
		name     string
		out      string
		explicit []string
		in       []string
		want     []string
	}{
		{"explicit wins", "o/photo.png", []string{b}, []string{a}, []string{b}},
		{"explicit empty", "o/photo.png", []string{}, []string{a}, []string{}},
		{"single", "o/anything.png", nil, []string{a}, []string{a}},
		{"none", "o/anything.png", nil, nil, nil},
		{"prefix", "o/Photo_erased.png", nil, []string{a, b}, []string{a}},
		{"prefix case-insens", "o/PHOTO-2.png", nil, []string{b, a}, []string{a}},
		{"no match -> all", "o/zzz.png", nil, []string{a, b}, []string{a, b}},
		{"both match", "o/photo-other.png", nil, []string{a, `C:\y\photo.png`}, []string{a, `C:\y\photo.png`}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := LineageInputs(tc.out, tc.explicit, tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
