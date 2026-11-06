package brushimport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func preset(t *testing.T, b Brush) Preset {
	t.Helper()
	var p Preset
	if err := json.Unmarshal(b.JSON, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func hasNote(notes []string, sub string) bool {
	for _, n := range notes {
		if strings.Contains(n, sub) {
			return true
		}
	}
	return false
}

func TestProcreateBrushset(t *testing.T) {
	shape := grayPNG(t, 8, 8, func(x, y int) uint8 { return uint8(x * 30) })
	grain := grayPNG(t, 16, 16, func(x, y int) uint8 { return uint8((x + y) * 8) })
	zipData := zipBytes(t, map[string][]byte{
		"brushset.plist": brushsetPlist(t, "My Inks", []string{"B-2", "A-1"}),
		"A-1/Brush.archive": procreateBrush("Dry Ink", map[string]any{
			"plotSpacing": 0.2, "plotJitter": 0.3, "taperStartLength": 0.1, "dynamicsPressureSize": 0.7,
			"dynamicsMix": 0.5, "textureScale": 2.5, "textureMovement": 1.0, "someFutureKey": 12.0,
		}),
		"A-1/Shape.png": shape,
		"A-1/Grain.png": grain,
		"B-2/Brush.archive": procreateBrush("Soft Pen", map[string]any{
			"plotSpacing": uint64(1), "dynamicsPressureOpacity": 0.4, "shapeCount": uint64(3),
		}),
	})
	res, err := Import(zipData, "inks.brushset", ".brushset")
	if err != nil {
		t.Fatal(err)
	}
	if res.Set.Name != "My Inks" || res.Set.Source != SourceProcreate {
		t.Fatalf("set = %q %q", res.Set.Name, res.Set.Source)
	}
	// brushset.plist order: B-2 first
	if len(res.Set.Brushes) != 2 || res.Set.Brushes[0].Name != "Soft Pen" || res.Set.Brushes[1].Name != "Dry Ink" {
		t.Fatalf("brushes = %+v", res.Set.Brushes)
	}
	soft := preset(t, res.Set.Brushes[0])
	if soft.Spacing != 1 || soft.Count != 3 || len(soft.Dynamics) != 1 || soft.Dynamics[0].Target != "opacity" || soft.Dynamics[0].Amount != 0.4 {
		t.Errorf("soft pen = %+v", soft)
	}
	ink := preset(t, res.Set.Brushes[1])
	if ink.Spacing != 0.2 || ink.Scatter != 0.3 || ink.Taper.Start != 0.1 || ink.Wet.Mix != 0.5 || ink.Rendering != "intense" {
		t.Errorf("dry ink = %+v", ink)
	}
	if ink.Grain.Scale != 2.5 || ink.Grain.Mode != "texturised" || !strings.HasPrefix(ink.Grain.Texture, "set:@/grains/") {
		t.Errorf("dry ink grain = %+v", ink.Grain)
	}
	if !strings.HasPrefix(ink.Tip.Shape, "set:@/tips/") {
		t.Errorf("tip = %q", ink.Tip.Shape)
	}
	if len(ink.Dynamics) != 1 || ink.Dynamics[0].Input != "pressure" || ink.Dynamics[0].Target != "size" {
		t.Errorf("dynamics = %+v", ink.Dynamics)
	}
	if len(res.Set.Files) != 2 {
		t.Errorf("files = %d, want a tip and a grain", len(res.Set.Files))
	}
	for name, data := range res.Set.Files {
		if _, _, err := ValidatePNG(data); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if !hasNote(res.Fidelity, "undocumented") || !hasNote(res.Fidelity, "somefuturekey") {
		t.Errorf("fidelity = %v", res.Fidelity)
	}
	if !hasNote(ink.Fidelity, "somefuturekey") {
		t.Errorf("brush fidelity = %v", ink.Fidelity)
	}
	var raw map[string]any
	if err := json.Unmarshal(res.Set.Raw[ink.ID], &raw); err != nil || raw["somefuturekey"] != 12.0 {
		t.Errorf("raw = %s (%v)", res.Set.Raw[ink.ID], err)
	}
	// Binding gives the real set ID.
	if err := res.Set.Bind("my-inks"); err != nil {
		t.Fatal(err)
	}
	bound := preset(t, res.Set.Brushes[1])
	if bound.Set != "my-inks" || !strings.HasPrefix(bound.Tip.Shape, "set:my-inks/tips/") || strings.Contains(string(res.Set.Brushes[1].JSON), "@") {
		t.Errorf("bound = %+v", bound)
	}
}

func TestProcreateSingleBrushAtRootAndNestedObjects(t *testing.T) {
	// A .brush has its files at the root; the archive's NSDictionary/NSArray objects must resolve.
	a := newArchive()
	dictClass := a.add(map[string]any{"$classname": "NSMutableDictionary", "$classes": []any{"NSMutableDictionary"}})
	k := a.add("spacing")
	dict := a.add(map[string]any{"$class": dictClass, "NS.keys": []any{k}, "NS.objects": []any{0.5}})
	data := a.brush(map[string]any{"name": "Nested", "plotSpacing": 0.33, "extra": dict})
	res, err := Import(zipBytes(t, map[string][]byte{"Brush.archive": data}), "Nested.brush", ".brush")
	if err != nil {
		t.Fatal(err)
	}
	if res.Set.Name != "Nested" || len(res.Set.Brushes) != 1 {
		t.Fatalf("set = %+v", res.Set)
	}
	if p := preset(t, res.Set.Brushes[0]); p.Spacing != 0.33 || p.Name != "Nested" {
		t.Errorf("preset = %+v", p)
	}
}

func TestProcreateBadInputs(t *testing.T) {
	cases := map[string][]byte{
		"not a zip":         []byte("hello"),
		"no archive":        zipBytes(t, map[string][]byte{"x.txt": []byte("a")}),
		"archive not plist": zipBytes(t, map[string][]byte{"B/Brush.archive": []byte("junk")}),
	}
	for name, data := range cases {
		if _, err := Import(data, "x.brushset", ".brushset"); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestMyPaint(t *testing.T) {
	src := `{"version":3,"settings":{
	  "radius_logarithmic":{"base_value":1.0,"inputs":{"pressure":[[0,-0.7],[1,0.7]]}},
	  "opaque":{"base_value":0,"inputs":{"pressure":[[0,0],[1,1]]}},
	  "hardness":{"base_value":0.35,"inputs":{}},
	  "dabs_per_actual_radius":{"base_value":4,"inputs":{}},
	  "smudge":{"base_value":0.6,"inputs":{}},
	  "smudge_length":{"base_value":0.4,"inputs":{}},
	  "elliptical_dab_ratio":{"base_value":2,"inputs":{}},
	  "elliptical_dab_angle":{"base_value":30,"inputs":{}},
	  "offset_by_random":{"base_value":0.4,"inputs":{}},
	  "slow_tracking":{"base_value":5,"inputs":{}},
	  "tracking_noise":{"base_value":0.3,"inputs":{}},
	  "color_h":{"base_value":0.5,"inputs":{}},
	  "radius_by_random":{"base_value":0,"inputs":{"random":[[0,0],[1,1]]}}
	}}`
	p, notes, err := ParseMyb("Smeary", []byte(src))
	if err != nil {
		t.Fatal(err)
	}
	if p.Size < 10.9 || p.Size > 11 { // 2*e^(1+0.7): the radius is base + the pressure curve's largest value
		t.Errorf("size = %v", p.Size)
	}
	if p.Tip.Hardness != 0.35 || p.Spacing != 0.125 || p.Wet.Mix != 0.6 || p.Wet.Pull != 0.4 {
		t.Errorf("preset = %+v", p)
	}
	if p.Tip.Roundness != 0.5 || p.Tip.Angle != 30 || p.Smoothing.Streamline != 0.5 || p.Scatter != 0.348 {
		t.Errorf("shape = %+v scatter %v", p.Tip, p.Scatter)
	}
	if p.Opacity != 1 {
		t.Errorf("opacity = %v (a brush driven by pressure should start at 1)", p.Opacity)
	}
	var size, op *Dynamics
	for i := range p.Dynamics {
		switch p.Dynamics[i].Target {
		case "size":
			size = &p.Dynamics[i]
		case "opacity":
			op = &p.Dynamics[i]
		}
	}
	if size == nil || size.Input != "pressure" || size.Amount != 1 || size.Curve[0] != [2]float64{0, 0.247} || size.Curve[len(size.Curve)-1] != [2]float64{1, 1} { // exp(-1.4) of the full size at zero pressure
		t.Errorf("size dynamics = %+v", size)
	}
	if op == nil || op.Input != "pressure" {
		t.Errorf("opacity dynamics = %+v", op)
	}
	if !hasNote(notes, "tracking_noise") || hasNote(notes, "color_h") || !hasNote(notes, "radius_by_random") {
		t.Errorf("notes = %v", notes)
	}
	if _, _, err := ParseMyb("x", []byte("{}")); err == nil {
		t.Error("a file without settings should fail")
	}
	// As a file import: one brush in a set named after the file.
	res, err := Import([]byte(src), "my_smeary.myb", ".myb")
	if err != nil || res.Set.Name != "My smeary" || len(res.Set.Brushes) != 1 || res.Set.Source != SourceMyPaint {
		t.Errorf("import = %+v, %v", res, err)
	}
}

func TestMyPaintEraser(t *testing.T) {
	p, _, err := ParseMyb("e", []byte(`{"settings":{"eraser":{"base_value":1,"inputs":{}}}}`))
	if err != nil || p.Blend != "erase" {
		t.Errorf("%+v %v", p, err)
	}
}

func TestABR(t *testing.T) {
	cross := func(x, y int) uint8 {
		if x == 1 || y == 1 {
			return 255
		}
		return 0
	}
	file := abrFile([][]byte{sampRecord(4, 4, cross, false), sampRecord(4, 4, cross, true)}, [2]string{"desc", "xxxxxxxx"}, [2]string{"patt", "yy"})
	res, err := Import(file, "pencils.abr", ".abr")
	if err != nil {
		t.Fatal(err)
	}
	if res.Set.Name != "pencils" || res.Set.Source != SourceABR || len(res.Set.Brushes) != 2 || len(res.Set.Files) != 2 {
		t.Fatalf("set = %+v", res.Set)
	}
	for file, data := range res.Set.Files {
		w, h, a := decodeMask(t, data)
		if w != 4 || h != 4 || a[1*4+0] != 255 || a[0] != 0 {
			t.Errorf("%s: %dx%d alpha %v", file, w, h, a)
		}
	}
	p := preset(t, res.Set.Brushes[0])
	if p.Name != "Tip 1" || !strings.HasPrefix(p.Tip.Shape, "set:@/tips/") || p.Spacing != 0.25 || len(p.Dynamics) != 1 {
		t.Errorf("preset = %+v", p)
	}
	if !hasNote(res.Fidelity, "desc, patt") || !hasNote(res.Fidelity, "default dynamics") {
		t.Errorf("fidelity = %v", res.Fidelity)
	}
}

func TestABRRejects(t *testing.T) {
	old := []byte{0, 1, 0, 2, 0, 0, 0, 0}
	if _, err := Import(old, "old.abr", ".abr"); err == nil || !strings.Contains(err.Error(), "version 1") {
		t.Errorf("v1 error = %v", err)
	}
	if _, err := Import(abrFile(nil, [2]string{"desc", "x"}), "empty.abr", ".abr"); err == nil {
		t.Error("a file without sampled tips should fail")
	}
	huge := sampRecord(4, 4, func(x, y int) uint8 { return 1 }, false)
	// bounds right = 5000 (> limit)
	huge[1+36+10+12], huge[1+36+10+13] = 0x13, 0x88
	if _, err := Import(abrFile([][]byte{huge}), "huge.abr", ".abr"); err == nil {
		t.Error("an oversized tip should fail")
	}
}

func TestKritaBundle(t *testing.T) {
	// 2x2 gray tip: dark = paint, so 0 -> 255 coverage.
	gbr := gbrBytes(2, 2, 1, "Rough Dab", 40, func(i int) []byte { return []byte{[]byte{0, 255, 128, 255}[i]} })
	pat := patBytes(2, 2, "Linen", func(i int) byte { return byte(i * 80) })
	tipPNG := grayPNG(t, 4, 4, func(x, y int) uint8 { return 0 })
	bundle := zipBytes(t, map[string][]byte{
		"mimetype":             []byte("application/x-krita-resourcebundle"),
		"meta.xml":             []byte("<x/>"),
		"brushes/rough.gbr":    gbr,
		"brushes/solid.png":    tipPNG,
		"patterns/linen.pat":   pat,
		"paintoppresets/a.kpp": []byte("x"),
		"paintoppresets/b.kpp": []byte("x"),
		"gradients/g.ggr":      []byte("x"),
	})
	res, err := Import(bundle, "Basics.bundle", ".bundle")
	if err != nil {
		t.Fatal(err)
	}
	if res.Set.Name != "Basics" || res.Set.Source != SourceKrita || len(res.Set.Brushes) != 3 {
		t.Fatalf("set = %+v", res.Set)
	}
	byName := map[string]Preset{}
	for _, b := range res.Set.Brushes {
		p := preset(t, b)
		byName[p.Name] = p
	}
	rough, ok := byName["Rough Dab"]
	if !ok || rough.Spacing != 0.4 {
		t.Fatalf("rough = %+v (%v)", rough, ok)
	}
	file := strings.TrimPrefix(rough.Tip.Shape, "set:@/")
	_, _, a := decodeMask(t, res.Set.Files[file])
	if a[0] != 255 || a[1] != 0 || a[2] != 127 {
		t.Errorf("tip coverage = %v, want inverted [255 0 127 0]", a)
	}
	grain, ok := byName["Linen (grain)"]
	if !ok || !strings.HasPrefix(grain.Grain.Texture, "set:@/grains/") || grain.Grain.Mode != "texturised" {
		t.Errorf("grain brush = %+v", grain)
	}
	if !hasNote(res.Fidelity, "2 Krita brush presets") || !hasNote(res.Fidelity, "1 other files") {
		t.Errorf("fidelity = %v", res.Fidelity)
	}
	if _, err := Import(zipBytes(t, map[string][]byte{"meta.xml": []byte("x")}), "e.bundle", ".bundle"); err == nil {
		t.Error("an empty bundle should fail")
	}
}

func TestZipSlipRefused(t *testing.T) {
	for _, name := range []string{"../evil.png", "a/../../evil", "/abs/evil", "C:/evil", `..\evil`, `a\..\..\evil`} {
		data := zipBytes(t, map[string][]byte{name: []byte("x")})
		if _, err := ReadZip(data); err == nil {
			t.Errorf("%q should be refused", name)
		}
		if _, err := Import(data, "x.bundle", ".bundle"); err == nil {
			t.Errorf("%q: import should fail", name)
		}
	}
	if _, err := SafeName("tips/ok.png"); err != nil {
		t.Error(err)
	}
}

func TestZipCaps(t *testing.T) {
	big := bytes.Repeat([]byte{0}, MaxZipTotal/2+1)
	data := zipBytes(t, map[string][]byte{"a": big, "b": big})
	if _, err := ReadZip(data); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Errorf("total cap: %v", err)
	}
	many := map[string][]byte{}
	for i := 0; i < MaxZipEntries+1; i++ {
		many[fmt.Sprintf("f%d", i)] = nil
	}
	if _, err := ReadZip(zipBytes(t, many)); err == nil {
		t.Error("entry cap")
	}
}

func TestImageLimits(t *testing.T) {
	wide := grayPNG(t, MaxImageSide+1, 1, func(x, y int) uint8 { return 0 })
	if _, err := TipFromPNG(wide, false, nil); err == nil {
		t.Error("a 4097 px tip should be refused")
	}
	if _, _, err := ValidatePNG(wide); err == nil {
		t.Error("ValidatePNG should refuse it")
	}
	if _, _, err := ValidatePNG([]byte("GIF89a")); err == nil {
		t.Error("not a PNG")
	}
	// Large but legal tips are scaled down to the tip limit.
	var n notes
	big := grayPNG(t, 2048, 2048, func(x, y int) uint8 { return 200 })
	out, err := TipFromPNG(big, false, &n)
	if err != nil {
		t.Fatal(err)
	}
	if w, h, _ := decodeMask(t, out); w != 1024 || h != 1024 || len(n.list) != 1 {
		t.Errorf("scaled to %dx%d, notes %v", w, h, n.list)
	}
}

func TestTipPolarity(t *testing.T) {
	// Opaque: luminance is the shape (inverted when dark = paint).
	g := grayPNG(t, 2, 1, func(x, y int) uint8 { return []uint8{255, 0}[x] })
	plain, _ := TipFromPNG(g, false, nil)
	inv, _ := TipFromPNG(g, true, nil)
	if _, _, a := decodeMask(t, plain); a[0] != 255 || a[1] != 0 {
		t.Errorf("plain = %v", a)
	}
	if _, _, a := decodeMask(t, inv); a[0] != 0 || a[1] != 255 {
		t.Errorf("inverted = %v", a)
	}
	// Transparent: alpha is the shape, whatever the colour or invert flag.
	ap := alphaPNG(t, 2, 1, func(x, y int) uint8 { return []uint8{0, 200}[x] })
	out, _ := TipFromPNG(ap, true, nil)
	if _, _, a := decodeMask(t, out); a[0] != 0 || a[1] != 200 {
		t.Errorf("alpha = %v", a)
	}
}

func TestUnsupportedExtension(t *testing.T) {
	if _, err := Import([]byte("x"), "a.txt", ".txt"); err == nil {
		t.Error("expected an error")
	}
}

func TestSlug(t *testing.T) {
	for in, want := range map[string]string{"Soft Round!": "soft-round", "": "brush", "../x": "x", "Été": "t", strings.Repeat("a", 80): strings.Repeat("a", 48)} {
		if got := Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
		if !SlugRe.MatchString(Slug(in)) {
			t.Errorf("Slug(%q) isn't a valid ID", in)
		}
	}
}

// MyPaint's opaque_linearize: the dab alpha is lowered so the overlapping dabs add up
// to the brush's opacity; the preset carries it as flow, never as the stroke cap.
func TestMyPaintOpacityIsFlow(t *testing.T) {
	src := `{"settings":{
	  "radius_logarithmic":{"base_value":2,"inputs":{}},
	  "opaque":{"base_value":0.5,"inputs":{}},
	  "opaque_multiply":{"base_value":0,"inputs":{"pressure":[[0,0],[1,1]]}},
	  "opaque_linearize":{"base_value":0.9,"inputs":{}},
	  "dabs_per_actual_radius":{"base_value":4,"inputs":{}}}}`
	p, _, err := ParseMyb("flowy", []byte(src))
	if err != nil {
		t.Fatal(err)
	}
	if p.Opacity != 1 {
		t.Errorf("opacity = %v, the stroke cap stays 1", p.Opacity)
	}
	// 8 dabs per diameter, linearised: 1 + 0.9*7 = 7.3 overlapping dabs: 1-(1-0.5)^(1/7.3).
	if p.Flow < 0.09 || p.Flow > 0.1 {
		t.Errorf("flow = %v", p.Flow)
	}
	var size, op *Dynamics
	for i := range p.Dynamics {
		switch p.Dynamics[i].Target {
		case "size":
			size = &p.Dynamics[i]
		case "opacity":
			op = &p.Dynamics[i]
		}
	}
	if size == nil || size.Amount != 0 || p.MinSize != 0 || p.Size != 14.778 {
		t.Errorf("a brush without size inputs must not let pressure scale it: %+v min %v size %v", size, p.MinSize, p.Size)
	}
	if op == nil || op.Curve[0][1] != 0 {
		t.Errorf("opacity dynamics = %+v", op)
	}
}

func TestMyPaintSpacingAddsBothSettings(t *testing.T) {
	p, _, err := ParseMyb("s", []byte(`{"settings":{"dabs_per_actual_radius":{"base_value":2,"inputs":{}},"dabs_per_basic_radius":{"base_value":4.63,"inputs":{}}}}`))
	if err != nil || p.Spacing != 0.075 {
		t.Errorf("%v %v", p.Spacing, err)
	}
}
