package paint

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

func brushModule(t *testing.T) *Module {
	t.Helper()
	return New(Config{SupportDir: t.TempDir()})
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = uint8(i * 7)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func dataURL(b []byte) string { return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b) }

func writeZip(t *testing.T, path string, files map[string][]byte) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for n, d := range files {
		w, _ := zw.Create(n)
		w.Write(d)
	}
	zw.Close()
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSaveAndReadBrush(t *testing.T) {
	m := brushModule(t)
	if sets, err := m.brushSets(); err != nil || sets == nil || len(sets) != 0 {
		t.Fatalf("empty sets = %v, %v", sets, err)
	}
	info, err := m.saveBrush("My Brushes", `{"version":1,"name":"Wobbly","size":12}`)
	if err != nil {
		t.Fatal(err)
	}
	if info.ID != "wobbly" || info.Set != "my-brushes" {
		t.Fatalf("info = %+v", info)
	}
	// A second brush with the same name gets its own ID; an explicit ID overwrites.
	info2, err := m.saveBrush("my-brushes", `{"name":"Wobbly"}`)
	if err != nil || info2.ID != "wobbly-2" {
		t.Fatalf("info2 = %+v, %v", info2, err)
	}
	if _, err := m.saveBrush("my-brushes", `{"id":"wobbly","name":"Wobbly v2","size":30}`); err != nil {
		t.Fatal(err)
	}
	got, err := m.brush("my-brushes", "wobbly")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(got), &doc); err != nil || doc["size"] != 30.0 || doc["set"] != "my-brushes" || doc["name"] != "Wobbly v2" {
		t.Errorf("brush = %s (%v)", got, err)
	}
	sets, err := m.brushSets()
	if err != nil || len(sets) != 1 {
		t.Fatalf("sets = %+v, %v", sets, err)
	}
	s := sets[0]
	if s.ID != "my-brushes" || s.Name != "My Brushes" || s.Source != "user" || s.Imported == 0 || len(s.Brushes) != 2 || s.Brushes[0].ID != "wobbly" || s.Brushes[1].ID != "wobbly-2" {
		t.Errorf("set = %+v", s)
	}
	// No temp files are left behind.
	entries, _ := os.ReadDir(filepath.Join(m.brushRoot(), "my-brushes"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tmp") {
			t.Errorf("leftover %s", e.Name())
		}
	}
	if err := m.deleteBrush("my-brushes", "wobbly-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.brush("my-brushes", "wobbly-2"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("deleted brush: %v", err)
	}
	if err := m.deleteBrush("my-brushes", "wobbly-2"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("deleting twice: %v", err)
	}
	if err := m.deleteBrush("my-brushes", ""); err != nil {
		t.Fatal(err)
	}
	if sets, _ := m.brushSets(); len(sets) != 0 {
		t.Errorf("sets after delete = %+v", sets)
	}
}

func TestBrushValidationAndEscape(t *testing.T) {
	m := brushModule(t)
	bad := []string{"..", "../x", "a/b", `a\b`, "A B", "", ".hidden"}
	for _, id := range bad {
		if _, err := m.brush(id, "x"); err == nil {
			t.Errorf("brush(%q) should fail", id)
		}
		if _, err := m.brush("ok", id); err == nil {
			t.Errorf("brush(ok, %q) should fail", id)
		}
		if err := m.deleteBrush(id, ""); err == nil {
			t.Errorf("deleteBrush(%q) should fail", id)
		}
		if _, err := m.brushAsset(id, "tips/a.png"); err == nil {
			t.Errorf("brushAsset(%q) should fail", id)
		}
	}
	if _, err := m.saveBrush("ok", `{"id":"../evil","name":"x"}`); err == nil {
		t.Error("an unsafe brush id should fail")
	}
	if _, err := m.saveBrush("ok", `{"size":1}`); err == nil {
		t.Error("a nameless brush should fail")
	}
	if _, err := m.saveBrush("ok", `not json`); err == nil {
		t.Error("invalid JSON should fail")
	}
	if _, err := m.saveBrush("", `{"name":"x"}`); err == nil {
		t.Error("an empty set should fail")
	}
	for _, f := range []string{"../../x.png", "tips/../../x.png", "tips/a.txt", "/etc/passwd", "tips/A.png", "other/a.png"} {
		if _, err := m.brushAsset("ok", f); err == nil {
			t.Errorf("brushAsset(%q) should fail", f)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(m.brushRoot()), "evil.json")); err == nil {
		t.Error("something escaped the brush folder")
	}
}

func TestSaveBrushAssetAndCollect(t *testing.T) {
	m := brushModule(t)
	tipPNG := pngBytes(t, 16, 16)
	ref, err := m.saveBrushAsset("studio", "tip", dataURL(tipPNG))
	if err != nil || !strings.HasPrefix(ref, "set:studio/tips/") || !strings.HasSuffix(ref, ".png") {
		t.Fatalf("ref = %q, %v", ref, err)
	}
	again, _ := m.saveBrushAsset("studio", "tip", dataURL(tipPNG))
	if again != ref {
		t.Errorf("the same image should get the same name: %q vs %q", again, ref)
	}
	grainRef, err := m.saveBrushAsset("studio", "grain", dataURL(pngBytes(t, 8, 8)))
	if err != nil || !strings.Contains(grainRef, "/grains/") {
		t.Fatalf("grain ref = %q, %v", grainRef, err)
	}
	// both reference forms read back the same PNG
	for _, file := range []string{strings.TrimPrefix(ref, "set:studio/"), ref} {
		got, err := m.brushAsset("studio", file)
		if err != nil || got != dataURL(tipPNG) {
			t.Errorf("brushAsset(%q) = %.30s, %v", file, got, err)
		}
	}
	// refused inputs
	if _, err := m.saveBrushAsset("studio", "mask", dataURL(tipPNG)); err == nil {
		t.Error("bad kind")
	}
	if _, err := m.saveBrushAsset("studio", "tip", "data:image/jpeg;base64,AAAA"); err == nil {
		t.Error("not a PNG data URL")
	}
	if _, err := m.saveBrushAsset("studio", "tip", dataURL([]byte("not a png"))); err == nil {
		t.Error("garbage PNG")
	}
	if _, err := m.saveBrushAsset("studio", "tip", dataURL(pngBytes(t, 4097, 1))); err == nil {
		t.Error("a 4097 px image should be refused")
	}
	// the grain isn't referenced by any brush, the tip is: deleting a brush collects only orphans
	if _, err := m.saveBrush("studio", `{"name":"Uses tip","tip":{"shape":"`+ref+`"}}`); err != nil {
		t.Fatal(err)
	}
	if _, err := m.saveBrush("studio", `{"name":"Plain"}`); err != nil {
		t.Fatal(err)
	}
	if err := m.deleteBrush("studio", "plain"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.brushAsset("studio", ref); err != nil {
		t.Errorf("the referenced tip was collected: %v", err)
	}
	if _, err := m.brushAsset("studio", grainRef); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("the orphan grain should be collected: %v", err)
	}
	if err := m.deleteBrush("studio", "uses-tip"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.brushAsset("studio", ref); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("the tip should be collected with its last brush: %v", err)
	}
}

func TestImportStoreExportRoundTrip(t *testing.T) {
	m := brushModule(t)
	dir := t.TempDir()
	myb := filepath.Join(dir, "charcoal.myb")
	os.WriteFile(myb, []byte(`{"settings":{"radius_logarithmic":{"base_value":2,"inputs":{}},"hardness":{"base_value":0.2,"inputs":{}},"tracking_noise":{"base_value":0.5,"inputs":{}}}}`), 0o644)
	bundle := filepath.Join(dir, "Basics.bundle")
	writeZip(t, bundle, map[string][]byte{"brushes/dab.png": pngBytes(t, 8, 8), "brushes/dab2.png": pngBytes(t, 8, 8)})
	bad := filepath.Join(dir, "x.brushset")
	os.WriteFile(bad, []byte("nope"), 0o644)
	missing := filepath.Join(dir, "gone.abr")

	res, err := m.importBrushes(context.Background(), []string{myb, bundle, bad, missing, myb})
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 5 {
		t.Fatalf("results = %d", len(res))
	}
	if res[0].Error != "" || res[0].Set.ID != "charcoal" || res[0].Set.Source != "mypaint" || len(res[0].Set.Brushes) != 1 || !containsStr(res[0].Fidelity, "tracking_noise") {
		t.Errorf("myb = %+v", res[0])
	}
	if res[1].Error != "" || res[1].Set.ID != "basics" || len(res[1].Set.Brushes) != 2 || res[1].Fidelity == nil {
		t.Errorf("bundle = %+v", res[1])
	}
	if res[2].Error == "" || res[3].Error == "" || res[2].Fidelity == nil {
		t.Errorf("bad files: %+v %+v", res[2], res[3])
	}
	if res[4].Error != "" || res[4].Set.ID != "charcoal-2" {
		t.Errorf("same file twice should get a second set: %+v", res[4])
	}
	// no half-built import folders remain
	entries, _ := os.ReadDir(m.brushRoot())
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Errorf("leftover %s", e.Name())
		}
	}

	// stored brush refers to its own set
	basics := res[1].Set
	raw, err := m.brush("basics", basics.Brushes[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		Set string
		Tip struct{ Shape string }
	}
	if err := json.Unmarshal([]byte(raw), &p); err != nil || p.Set != "basics" || !strings.HasPrefix(p.Tip.Shape, "set:basics/tips/") {
		t.Fatalf("stored brush = %s (%v)", raw, err)
	}
	if _, err := m.brushAsset("basics", p.Tip.Shape); err != nil {
		t.Errorf("tip asset: %v", err)
	}

	// Export, delete, import again: the same brushes and images come back.
	exportPath := filepath.Join(dir, "out", "basics")
	m.cfg.Dialogs.Save = func(name string) (string, error) {
		if name != "basics.paintplus-brushes" {
			t.Errorf("default name = %q", name)
		}
		return exportPath, nil
	}
	got, err := m.exportBrushSet("basics")
	if err != nil || got != exportPath+".paintplus-brushes" {
		t.Fatalf("export = %q, %v", got, err)
	}
	zr, err := zip.OpenReader(got)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	zr.Close()
	if !names["set.json"] || !names[basics.Brushes[0].ID+".json"] || len(names) != 5 { // set.json, 2 brushes, 2 tips
		t.Errorf("export entries = %v", names)
	}
	if err := m.deleteBrush("basics", ""); err != nil {
		t.Fatal(err)
	}
	back, err := m.importBrushes(context.Background(), []string{got})
	if err != nil || back[0].Error != "" {
		t.Fatalf("re-import = %+v, %v", back, err)
	}
	if back[0].Set.ID != "basics" || back[0].Set.Source != "krita" || len(back[0].Set.Brushes) != 2 {
		t.Errorf("re-imported set = %+v", back[0].Set)
	}
	raw2, err := m.brush("basics", basics.Brushes[0].ID)
	if err != nil || raw2 != raw {
		t.Errorf("round-trip changed the brush:\n%s\n%s (%v)", raw, raw2, err)
	}
	if _, err := m.brushAsset("basics", p.Tip.Shape); err != nil {
		t.Errorf("tip asset after re-import: %v", err)
	}

	// Cancelling the dialog exports nothing.
	m.cfg.Dialogs.Save = func(string) (string, error) { return "", nil }
	if got, err := m.exportBrushSet("basics"); got != "" || err != nil {
		t.Errorf("cancelled export = %q, %v", got, err)
	}
	if _, err := m.exportBrushSet("nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("export of a missing set: %v", err)
	}
}

func containsStr(list []string, sub string) bool {
	for _, s := range list {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func TestImportCancelledAndDialogs(t *testing.T) {
	m := brushModule(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if res, err := m.importBrushes(ctx, []string{"a.myb"}); err == nil || len(res) != 0 {
		t.Errorf("cancelled import = %v, %v", res, err)
	}
	if paths, err := m.pickBrushFiles(); err == nil || paths == nil {
		t.Errorf("no dialog: %v, %v", paths, err)
	}
	m.cfg.Dialogs.Open = func() ([]string, error) { return nil, nil }
	if paths, err := m.pickBrushFiles(); err != nil || paths == nil || len(paths) != 0 {
		t.Errorf("cancelled pick = %v, %v", paths, err)
	}
}

func TestStoredSetsSurviveBrokenFolders(t *testing.T) {
	m := brushModule(t)
	if _, err := m.saveBrush("good", `{"name":"One"}`); err != nil {
		t.Fatal(err)
	}
	// A folder with a corrupt set.json still lists (named after its ID); stray files and bad names are ignored.
	os.MkdirAll(filepath.Join(m.brushRoot(), "broken"), 0o755)
	os.WriteFile(filepath.Join(m.brushRoot(), "broken", "set.json"), []byte("{"), 0o644)
	os.MkdirAll(filepath.Join(m.brushRoot(), "Not A Slug"), 0o755)
	os.WriteFile(filepath.Join(m.brushRoot(), "stray.txt"), []byte("x"), 0o644)
	sets, err := m.brushSets()
	if err != nil || len(sets) != 2 || sets[0].ID != "broken" || sets[1].ID != "good" {
		t.Errorf("sets = %+v, %v", sets, err)
	}
}
