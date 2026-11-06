package brushimport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// TestGenerateMyPaintLibrary converts a curated set of brushes from the
// mypaint-brushes repository (CC0, per its Licenses.dep5) into Paint+ presets
// for frontend/src/paint/brushes/library/open/mypaint/. It only runs when
// TOOLBOX_MYPAINT_SRC points at a checkout:
//
//	git clone --depth 1 https://github.com/mypaint/mypaint-brushes .dev/open/mypaint-brushes
//	TOOLBOX_MYPAINT_SRC=$PWD/.dev/open/mypaint-brushes \
//	TOOLBOX_MYPAINT_OUT=$PWD/frontend/src/paint/brushes/library/open/mypaint \
//	go test -run TestGenerateMyPaintLibrary ./modules/paint/brushimport/
func TestGenerateMyPaintLibrary(t *testing.T) {
	src, out := os.Getenv("TOOLBOX_MYPAINT_SRC"), os.Getenv("TOOLBOX_MYPAINT_OUT")
	if src == "" || out == "" {
		t.Skip("set TOOLBOX_MYPAINT_SRC and TOOLBOX_MYPAINT_OUT to regenerate the bundled MyPaint brushes")
	}
	// Authors per Licenses.dep5; every brushes/* entry is CC0-1.0.
	authors := map[string]string{
		"classic":      "Martin Renold and the MyPaint Development Team",
		"experimental": "Martin Renold and the MyPaint Development Team",
		"deevad":       "David Revoy",
		"ramon":        "Ramón Miranda",
		"tanda":        `Marcelo "Tanda" Cerviño`,
		"kaerhon_v1":   "Guillaume Loussarévian",
		"Dieterle":     "Brien Dieterle",
	}
	type pick struct{ dir, file, name string }
	sets := []struct {
		name  string
		picks []pick
	}{
		{"MyPaint Classic", []pick{
			{"classic", "pencil", "Pencil"}, {"classic", "charcoal", "Charcoal"}, {"classic", "pen", "Pen"},
			{"classic", "calligraphy", "Calligraphy"}, {"classic", "marker_fat", "Fat marker"}, {"classic", "dry_brush", "Dry brush"},
			{"classic", "impressionism", "Impressionism"}, {"classic", "bulk", "Bulk"}, {"classic", "long_grass", "Long grass"},
			{"classic", "textured_ink", "Textured ink"}, {"classic", "knife", "Knife"}, {"classic", "smudge", "Smudge"},
			{"experimental", "leaves", "Leaves"}, {"experimental", "fur", "Fur"}, {"experimental", "bubble", "Bubble"}, {"experimental", "glow", "Glow"},
		}},
		{"MyPaint David Revoy", []pick{
			{"deevad", "2B_pencil", "2B pencil"}, {"deevad", "ballpen", "Ballpoint"}, {"deevad", "chalk", "Chalk"},
			{"deevad", "liner", "Liner"}, {"deevad", "airbrush", "Airbrush"}, {"deevad", "spray", "Spray"},
			{"deevad", "rigger_brush", "Rigger brush"}, {"deevad", "watercolor_expressive", "Expressive watercolour"},
			{"deevad", "basic_digital_brush", "Basic digital brush"}, {"deevad", "soft-dip-pen", "Soft dip pen"},
			{"deevad", "rough", "Rough"}, {"deevad", "kneaded_eraser", "Kneaded eraser"},
		}},
		{"MyPaint Ramon Miranda", []pick{
			{"ramon", "Pastel_1", "Pastel"}, {"ramon", "Clouds", "Clouds"}, {"ramon", "Glow_Airbrush", "Glow airbrush"},
			{"ramon", "Sketch_1", "Sketch"}, {"ramon", "wet_round", "Wet round"}, {"ramon", "Grain", "Grain"},
		}},
		{"MyPaint Tanda", []pick{
			{"tanda", "oil-01-paint", "Oil"}, {"tanda", "acrylic-04-paint", "Acrylic"}, {"tanda", "charcoal-01", "Charcoal"},
			{"tanda", "watercolor-02-paint", "Watercolour"}, {"tanda", "splatter-02", "Splatter"},
		}},
		{"MyPaint More", []pick{
			{"kaerhon_v1", "ink-slowline_s", "Slow line ink"}, {"kaerhon_v1", "inkster_l", "Inkster"},
			{"Dieterle", "Splash", "Splash"}, {"Dieterle", "Flight_Feathers", "Flight feathers"},
		}},
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	old, _ := filepath.Glob(filepath.Join(out, "*.json"))
	for _, f := range old {
		os.Remove(f)
	}
	count := 0
	for _, s := range sets {
		for _, pk := range s.picks {
			data, err := os.ReadFile(filepath.Join(src, "brushes", pk.dir, pk.file+".myb"))
			if err != nil {
				t.Fatal(err)
			}
			p, _, err := ParseMyb(pk.name, data)
			if err != nil {
				t.Fatalf("%s/%s: %v", pk.dir, pk.file, err)
			}
			p.Set = s.name
			// MyPaint sizes are tiny until the user scales them (a charcoal is 2 px); a bundled brush starts usable.
			floor := 6.0
			switch pk.name {
			case "Liner", "Ballpoint", "Rigger brush", "Pen", "Slow line ink", "Inkster", "Textured ink":
				floor = 3
			}
			if p.Size < floor {
				p.Size = floor
				p.Fidelity = append(p.Fidelity, fmt.Sprintf("The default size was raised to %g px (the original brush is smaller).", floor))
			}
			p.ID = Slug(s.name + " " + pk.name)
			p.Credit = authors[pk.dir] + " (MyPaint brushes)"
			p.License = "CC0-1.0"
			var buf bytes.Buffer
			enc := json.NewEncoder(&buf)
			enc.SetEscapeHTML(false)
			if err := enc.Encode(p); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(out, p.ID+".json"), buf.Bytes(), 0o644); err != nil {
				t.Fatal(err)
			}
			count++
		}
	}
	t.Logf("wrote %d brushes to %s", count, out)
}
