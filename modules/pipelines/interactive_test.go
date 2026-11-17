package pipelines

import "testing"

func TestIsInteractive(t *testing.T) {
	m := &Module{}
	for _, tc := range []struct {
		opts string
		want bool
	}{
		{`{"action":"rename"}`, true},
		{`{"action":"table"}`, true},
		{`{"action":"run"}`, true},
		{`{"action":"open"}`, true},
		{`{"action":"chat"}`, false},
		{`{"action":"zip"}`, false},
		{`{"action":"copy"}`, false},
		{`not json`, false},
	} {
		if got := m.IsInteractive([]byte(tc.opts)); got != tc.want {
			t.Errorf("%s: got %v", tc.opts, got)
		}
	}
}
