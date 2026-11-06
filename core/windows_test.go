package core

import (
	"strings"
	"testing"
)

func TestNormalizePopOut(t *testing.T) {
	cases := []struct {
		name string
		in   PopOutRequest
		ok   bool
		w, h int
	}{
		{"tool", PopOutRequest{Key: "tool:edit-studio", Query: "window=tool&view=edit-studio"}, true, 1180, 760},
		{"part instance", PopOutRequest{Key: "part:edit-studio.preview@p1", Query: "window=part&part=edit-studio.preview", Width: 100, Height: 9000}, true, 480, 4096},
		{"bad key", PopOutRequest{Key: "edit-studio", Query: "window=tool&view=x"}, false, 0, 0},
		{"bad query", PopOutRequest{Key: "tool:x", Query: "window=popup&view=x"}, false, 0, 0},
		{"query with key", PopOutRequest{Key: "tool:x", Query: "window=tool&key=tool:y"}, false, 0, 0},
		{"query injection", PopOutRequest{Key: "tool:x", Query: "window=tool&view=<script>"}, false, 0, 0},
		{"big handoff", PopOutRequest{Key: "tool:x", Query: "window=tool&view=x", Handoff: strings.Repeat("a", MaxHandoffBytes+1)}, false, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := NormalizePopOut(c.in)
			if (err == nil) != c.ok {
				t.Fatalf("err = %v, want ok=%v", err, c.ok)
			}
			if c.ok && (got.Width != c.w || got.Height != c.h || got.Title != "Toolbox") {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func TestValidateRelay(t *testing.T) {
	cases := []struct {
		r  WindowRelay
		ok bool
	}{
		{WindowRelay{Channel: "bridge:edit-studio", From: "main"}, true},
		{WindowRelay{Channel: "bridge:edit-studio", From: "part:edit-studio.preview", To: "main"}, true},
		{WindowRelay{Channel: "", From: "main"}, false},
		{WindowRelay{Channel: "x", From: "nobody"}, false},
		{WindowRelay{Channel: "x", From: "main", To: "?"}, false},
		{WindowRelay{Channel: "x", From: "main", Payload: strings.Repeat("a", MaxRelayBytes+1)}, false},
	}
	for i, c := range cases {
		if err := ValidateRelay(c.r); (err == nil) != c.ok {
			t.Errorf("%d: err = %v, want ok=%v", i, err, c.ok)
		}
	}
}
