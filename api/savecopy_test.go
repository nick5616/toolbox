package api

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyToNew(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.png")
	if err := os.WriteFile(src, []byte("photo"), 0o644); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		dst     string
		before  string // existing content at dst, "" = none
		wantErr bool
	}{
		{name: "new file", dst: filepath.Join(dir, "b.png")},
		{name: "replaces an existing file", dst: filepath.Join(dir, "c.png"), before: "old"},
		{name: "refuses the source itself", dst: src, wantErr: true},
		{name: "missing folder", dst: filepath.Join(dir, "nope", "d.png"), wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.before != "" {
				if err := os.WriteFile(tt.dst, []byte(tt.before), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			err := copyToNew(src, tt.dst)
			if (err != nil) != tt.wantErr {
				t.Fatalf("copyToNew err = %v, wantErr %v", err, tt.wantErr)
			}
			if got, _ := os.ReadFile(src); string(got) != "photo" {
				t.Fatalf("source changed: %q", got)
			}
			if tt.wantErr {
				return
			}
			if got, _ := os.ReadFile(tt.dst); string(got) != "photo" {
				t.Fatalf("copy = %q, want photo", got)
			}
			left, _ := filepath.Glob(filepath.Join(dir, ".toolbox-copy-*"))
			if len(left) > 0 {
				t.Fatalf("temp files left: %v", left)
			}
		})
	}
}

func TestCleanSaveName(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Transcript.txt", "Transcript.txt"},
		{`..\..\evil.txt`, "evil.txt"},
		{"dir/sub/notes.md", "notes.md"},
		{`a:b?c*.txt`, "a_b_c_.txt"},
		{"", "Untitled.txt"},
		{"  . ", "Untitled.txt"},
		{"line\nbreak.txt", "line_break.txt"},
	}
	for _, tt := range tests {
		if got := cleanSaveName(tt.in); got != tt.want {
			t.Errorf("cleanSaveName(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
