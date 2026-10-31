package core

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

type varVectors struct {
	Vars  map[string]string `json:"vars"`
	Cases []struct {
		Tpl     string   `json:"tpl"`
		Out     string   `json:"out"`
		Missing []string `json:"missing"`
		Used    []string `json:"used"`
	} `json:"cases"`
}

func TestExpandVarsVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/vars.json")
	if err != nil {
		t.Fatal(err)
	}
	var v varVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		out, missing := ExpandVars(c.Tpl, v.Vars)
		if out != c.Out {
			t.Errorf("ExpandVars(%q) = %q, want %q", c.Tpl, out, c.Out)
		}
		if len(missing) == 0 {
			missing = []string{}
		}
		if !slices.Equal(missing, c.Missing) {
			t.Errorf("ExpandVars(%q) missing = %v, want %v", c.Tpl, missing, c.Missing)
		}
		if used := TemplateVars(c.Tpl); !slices.Equal(used, c.Used) {
			t.Errorf("TemplateVars(%q) = %v, want %v", c.Tpl, used, c.Used)
		}
	}
}

func TestExpandVarsLaterMapsWin(t *testing.T) {
	out, _ := ExpandVars("{name}-{bpm}", map[string]string{"name": "item", "bpm": "1"}, map[string]string{"name": "file"})
	if out != "file-1" {
		t.Fatalf("got %q", out)
	}
}

func TestFileVars(t *testing.T) {
	got := FileVars(RunFile{Path: "/x/Song - Bass.flac", RoleLabel: "Bass"})
	if got["name"] != "Song - Bass" || got["ext"] != "flac" || got["role"] != "Bass" {
		t.Fatalf("got %v", got)
	}
	if g := FileVars(RunFile{Path: "/x/a.b.txt", Name: "shown.md"}); g["name"] != "shown" || g["ext"] != "md" {
		t.Fatalf("Name wins: %v", g)
	}
}

func TestCapVar(t *testing.T) {
	if v, cut := CapVar("short"); cut || v != "short" {
		t.Fatal("short value changed")
	}
	long := strings.Repeat("é", MaxVarBytes) // 2 bytes each
	v, cut := CapVar(long)
	if !cut || len(v) > MaxVarBytes || !strings.HasSuffix(v, "é") {
		t.Fatalf("cut=%v len=%d", cut, len(v))
	}
}
