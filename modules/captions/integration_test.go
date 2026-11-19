//go:build integration

package captions

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core/deps"
)

// TestRealExifTool writes into a copy with the real ExifTool (skips when it
// isn't on PATH) and reads the tags back.
func TestRealExifTool(t *testing.T) {
	tool, err := exec.LookPath("exiftool")
	if err != nil {
		t.Skip("exiftool not installed")
	}
	e := newEnv(t)
	e.tools[deps.ExifTool] = tool
	e.vision.replies = []string{good("dog")}
	in := photos(t, t.TempDir(), "ä é.jpg")
	o := DefaultOptions()
	o.Preset = PresetEverything
	rec, err := mustRun(t, e, in, o)
	if err != nil {
		t.Fatal(err)
	}
	dir := rec.batchDir(t)
	wrec := &recorder{}
	if err := e.m.Run(context.Background(), e.job(nil, writeOptions(dir, DefaultOptions().Write), wrec)); err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(dir, WithCaptionsDir, "ä é.jpg")
	out, err := exec.Command(tool, "-j", "-charset", "filename=utf8", "-XMP-iptcCore:AltTextAccessibility", "-XMP-dc:Title", "-IPTC:Keywords", copyPath).Output()
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(out, &rows); err != nil || len(rows) != 1 {
		t.Fatalf("%s %v", out, err)
	}
	if !strings.Contains(string(out), "A dog on a table") || !strings.Contains(string(out), "The dog") {
		t.Errorf("tags: %s", out)
	}
	if _, err := os.Stat(in[0]); err != nil {
		t.Error(err)
	}
}
