package editstudio

import (
	"slices"
	"testing"
)

func TestProjectFlags(t *testing.T) {
	cases := []struct {
		data string
		want []string
	}{
		{`{"song":null,"analysisKey":""}`, nil},
		{`{"song":{"path":"a.mp3"},"analysisKey":""}`, []string{FlagMusic}},
		{`{"song":{"path":"a.mp3"},"analysisKey":"k"}`, []string{FlagMusic, FlagMusicEdit}},
		{`not json`, nil},
	}
	for _, c := range cases {
		if got := projectFlags(c.data); !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.data, got, c.want)
		}
	}
}

func TestVideoModuleDescriptor(t *testing.T) {
	m := New(Config{})
	v := NewVideoModule(m).Descriptor()
	e := m.Descriptor()
	if v.ID != VideoModuleID || e.Base != VideoModuleID || v.Base != "" {
		t.Fatalf("video %q base %q; edit base %q", v.ID, v.Base, e.Base)
	}
}
