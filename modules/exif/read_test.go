package exif

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
)

func fixture(t *testing.T, name string) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func loadEntries(t *testing.T, name string) []tagEntry {
	t.Helper()
	b, err := os.ReadFile(fixture(t, name))
	if err != nil {
		t.Fatal(err)
	}
	e, err := parseJSON(string(b))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestHumanLabel(t *testing.T) {
	for in, want := range map[string]string{
		"DateTimeOriginal": "Date Time Original",
		"GPSLatitude":      "GPS Latitude",
		"FNumber":          "F Number",
		"ExifImageWidth":   "Exif Image Width",
		"Make":             "Make",
		"ISO":              "ISO",
		"ThumbnailLength":  "Thumbnail Length",
		"Tag2Name":         "Tag2 Name",
	} {
		if got := humanLabel(in); got != want {
			t.Errorf("%s: %q want %q", in, got, want)
		}
	}
}

func TestParseJSONErrors(t *testing.T) {
	for _, in := range []string{"", "{}", "[]", "[1]", "[{"} {
		if _, err := parseJSON(in); err == nil {
			t.Errorf("%q should fail", in)
		}
	}
}

func TestStringify(t *testing.T) {
	e := loadEntries(t, "pretty.json")
	got := map[string]string{}
	for _, x := range e {
		got[x.Group+":"+x.Tag] = stringify(x.Value)
	}
	for k, want := range map[string]string{
		"ExifIFD:MakerNote":         "(binary, 1234 bytes)",
		"ExifIFD:FNumber":           "2.8",
		"XMP-dc:Subject":            "paris, tower",
		"XMP-x:Flag":                "True",
		"XMP-iptcExt:LocationShown": "City: Paris; Country: FR",
		"ExifTool:ExifToolVersion":  "13.59",
	} {
		if got[k] != want {
			t.Errorf("%s: %q want %q", k, got[k], want)
		}
	}
}

func TestBuildViewGroupsAndFields(t *testing.T) {
	pretty, num := loadEntries(t, "pretty.json"), loadEntries(t, "num.json")
	v := buildView(`C:\x\photo.jpg`, 1234, pretty, num)

	var names []string
	for _, g := range v.Groups {
		names = append(names, g.Name)
	}
	want := []string{"File", "IFD0", "ExifIFD", "GPS", "XMP-dc", "XMP-iptcExt", "XMP-x", "XMP-xmp", "IPTC",
		"ICC_Profile", "Canon", "Composite", "ExifTool", "IFD1", "JFIF"}
	if !slices.Equal(names, want) {
		t.Errorf("group order:\n got %v\nwant %v", names, want)
	}
	collapsed := map[string]bool{}
	for _, g := range v.Groups {
		collapsed[g.Name] = g.Collapsed
	}
	if !collapsed["Canon"] || !collapsed["ICC_Profile"] || collapsed["IFD0"] || collapsed["GPS"] {
		t.Errorf("collapsed: %v", collapsed)
	}
	// System merged into File, in file order.
	if f := v.Groups[0].Fields; f[0].Tag != "System:FileName" || f[0].Label != "File Name" || f[1].Tag != "File:FileType" {
		t.Errorf("file group: %+v", f)
	}
	if v.Make != "Canon" || v.Model != "EOS R5" || v.DateTaken != "2024:05:01 10:20:30" {
		t.Errorf("header: %q %q %q", v.Make, v.Model, v.DateTaken)
	}
	if v.Name != "photo.jpg" && !strings.HasSuffix(v.Path, "photo.jpg") {
		t.Errorf("name: %q", v.Name)
	}
	if !v.HasLocation || v.Location == nil {
		t.Fatal("no location")
	}
	if math.Abs(v.Location.Lat-48.858333) > 1e-9 || math.Abs(v.Location.Lon-2.294444) > 1e-9 || !v.Location.HasAltitude || v.Location.Altitude != 35.5 {
		t.Errorf("location: %+v", v.Location)
	}
	if !v.Editable {
		t.Error("jpg should be editable")
	}
	wantFields := map[string]string{
		FieldTitle: "Eiffel", FieldDescription: "Line 1", FieldArtist: "Old Artist",
		FieldCopyright: "", FieldKeywords: "paris, tower", FieldDateTimeOriginal: "2024:05:01 10:20:30",
	}
	for k, w := range wantFields {
		if v.Fields[k] != w {
			t.Errorf("field %s: %q want %q", k, v.Fields[k], w)
		}
	}
	for _, name := range EditableFields() {
		if _, ok := v.Fields[name]; !ok {
			t.Errorf("Fields missing %s", name)
		}
	}
}

func TestLocationVariants(t *testing.T) {
	mk := func(kv ...any) []tagEntry {
		var out []tagEntry
		for i := 0; i < len(kv); i += 2 {
			g, tag, _ := strings.Cut(kv[i].(string), ":")
			out = append(out, tagEntry{Group: g, Tag: tag, Value: kv[i+1]})
		}
		return out
	}
	// Southern/western hemisphere from refs without Composite.
	loc := extractLocation(mk("GPS:GPSLatitude", jn("33.5"), "GPS:GPSLatitudeRef", "S",
		"GPS:GPSLongitude", jn("70.6"), "GPS:GPSLongitudeRef", "W", "GPS:GPSAltitude", jn("10"), "GPS:GPSAltitudeRef", jn("1")))
	if loc == nil || loc.Lat != -33.5 || loc.Lon != -70.6 || loc.Altitude != -10 {
		t.Errorf("refs: %+v", loc)
	}
	// Signed composites win.
	loc = extractLocation(mk("Composite:GPSLatitude", jn("-12.5"), "Composite:GPSLongitude", jn("-45.25")))
	if loc == nil || loc.Lat != -12.5 || loc.Lon != -45.25 || loc.HasAltitude {
		t.Errorf("composite: %+v", loc)
	}
	if extractLocation(mk("GPS:GPSLatitude", jn("1"))) != nil {
		t.Error("lat without lon is no location")
	}
	if extractLocation(mk("Composite:GPSLatitude", jn("95"), "Composite:GPSLongitude", jn("0"))) != nil {
		t.Error("out of range latitude is no location")
	}
	// No numeric pass: fall back to the display pass.
	v := buildView("/x/a.jpg", 1, mk("GPS:GPSLatitude", jn("5"), "GPS:GPSLongitude", jn("6")), nil)
	if !v.HasLocation {
		t.Error("fallback to display pass failed")
	}
	if v := buildView("/x/a.jpg", 1, mk("IFD0:Make", "X"), nil); v.HasLocation || v.Location != nil {
		t.Error("no GPS should mean no location")
	}
}

func TestEditableByFormat(t *testing.T) {
	for p, want := range map[string]bool{
		"/a/x.jpg": true, "/a/x.JPEG": true, "/a/x.png": true, "/a/x.heic": true, "/a/x.tiff": true,
		"/a/x.bmp": false, "/a/x.dng": false, "/a/x.CR2": false, "/a/x.nef": false,
	} {
		if got := buildView(p, 0, nil, nil).Editable; got != want {
			t.Errorf("%s: %v want %v", p, got, want)
		}
	}
}

func TestCountTags(t *testing.T) {
	if n := countTags(loadEntries(t, "before.json")); n != 4 {
		t.Errorf("before = %d", n)
	}
	if n := countTags(loadEntries(t, "after.json")); n != 1 {
		t.Errorf("after = %d", n)
	}
}

func fakeModule(t *testing.T) *Module {
	t.Helper()
	t.Setenv("FAKE_EXIFTOOL", "1")
	m := New(func(string) (string, error) { return os.Args[0], nil })
	t.Cleanup(m.Close)
	return m
}

func TestReadThroughFakeTool(t *testing.T) {
	t.Setenv("FAKE_EXIF_JSON", fixture(t, "pretty.json"))
	t.Setenv("FAKE_EXIF_JSON_NUM", fixture(t, "num.json"))
	log := filepath.Join(t.TempDir(), "log.txt")
	t.Setenv("FAKE_EXIF_LOG", log)
	m := fakeModule(t)
	path := filepath.Join(t.TempDir(), "photo.jpg")
	if err := os.WriteFile(path, []byte("jpegbytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	v, err := m.Read(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if v.Make != "Canon" || !v.HasLocation || v.SizeBytes != 9 || v.Name != "photo.jpg" || v.Path != path {
		t.Errorf("view: %+v", v)
	}
	b, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 {
		t.Fatalf("commands: %q", lines)
	}
	if !strings.HasPrefix(lines[0], "-j\x1f-G1\x1f-struct\x1f-charset\x1ffilename=utf8\x1f") ||
		!strings.HasPrefix(lines[1], "-j\x1f-G1\x1f-struct\x1f-n\x1f-charset") || !strings.HasSuffix(lines[1], "\x1f"+path) {
		t.Errorf("read args: %q", lines)
	}
}

func TestReadErrors(t *testing.T) {
	m := fakeModule(t)
	dir := t.TempDir()
	txt := filepath.Join(dir, "a.txt")
	os.WriteFile(txt, []byte("x"), 0o644)
	for name, p := range map[string]string{
		"relative":  "photo.jpg",
		"missing":   filepath.Join(dir, "nope.jpg"),
		"directory": dir,
		"extension": txt,
	} {
		if _, err := m.Read(context.Background(), p); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	// ExifTool failing to read → tool_failed with its message.
	t.Setenv("FAKE_EXIF_JSON", filepath.Join(dir, "missing.json"))
	p := filepath.Join(dir, "b.jpg")
	os.WriteFile(p, []byte("x"), 0o644)
	_, err := m.Read(context.Background(), p)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeToolFailed {
		t.Errorf("err = %v", err)
	}
	// Missing exiftool passes the dependency error through.
	dep := core.ErrDependencyMissing("exiftool", "install it")
	m2 := New(func(string) (string, error) { return "", dep })
	if _, err := m2.Read(context.Background(), p); !errors.Is(err, dep) {
		t.Errorf("dep err = %v", err)
	}
}

func jn(s string) json.Number { return json.Number(s) }
