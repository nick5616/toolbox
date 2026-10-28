package exif

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"toolbox/core"
)

func TestBuildArgs(t *testing.T) {
	tests := []struct {
		name string
		opts Options
		want []string
	}{
		{"strip location", Options{Action: ActionStripLocation},
			[]string{"-gps:all=", "-xmp:geotag="}},
		{"strip all keep", Options{Action: ActionStripAll, KeepOrientation: true},
			[]string{"-all=", "-tagsFromFile", "@", "-Orientation", "-ICC_Profile"}},
		{"strip all", Options{Action: ActionStripAll},
			[]string{"-all="}},
		{"edit title", Options{Action: ActionEdit, Fields: map[string]string{FieldTitle: " Hello "}},
			[]string{"-XMP-dc:Title=Hello"}},
		{"edit all in UI order", Options{Action: ActionEdit, Fields: map[string]string{
			FieldDateTimeOriginal: "2024:01:02 03:04:05", FieldKeywords: "a, b ,, c", FieldCopyright: "(c) me",
			FieldArtist: "Me", FieldDescription: "D", FieldTitle: "T"}},
			[]string{
				"-XMP-dc:Title=T",
				"-IFD0:ImageDescription=D", "-XMP-dc:Description=D",
				"-IFD0:Artist=Me", "-XMP-dc:Creator=Me",
				"-IFD0:Copyright=(c) me", "-XMP-dc:Rights=(c) me",
				"-XMP-dc:Subject=a", "-XMP-dc:Subject=b", "-XMP-dc:Subject=c",
				"-IPTC:Keywords=a", "-IPTC:Keywords=b", "-IPTC:Keywords=c",
				"-ExifIFD:DateTimeOriginal=2024:01:02 03:04:05",
			}},
		{"empty removes", Options{Action: ActionEdit, Fields: map[string]string{FieldKeywords: "", FieldArtist: "", FieldDateTimeOriginal: ""}},
			[]string{"-IFD0:Artist=", "-XMP-dc:Creator=", "-XMP-dc:Subject=", "-IPTC:Keywords=", "-ExifIFD:DateTimeOriginal="}},
		{"multiline description escapes", Options{Action: ActionEdit, Fields: map[string]string{FieldDescription: "a & b\r\nline2", FieldTitle: "x<y"}},
			[]string{"-E", "-XMP-dc:Title=x&lt;y", "-IFD0:ImageDescription=a &amp; b&#10;line2", "-XMP-dc:Description=a &amp; b&#10;line2"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := buildArgs(tc.opts)
			if !slices.Equal(got, tc.want) {
				t.Errorf("got\n %q\nwant\n %q", got, tc.want)
			}
			for _, a := range got {
				if strings.ContainsAny(a, "\r\n") {
					t.Errorf("argument with newline: %q", a)
				}
			}
			if slices.Contains(got, "-overwrite_original") {
				t.Error("must never overwrite")
			}
		})
	}
}

func TestValidate(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	jpg, raw, bmp := mk("a.jpg"), mk("b.dng"), mk("c.bmp")
	opts := func(o Options) json.RawMessage { b, _ := json.Marshal(o); return b }
	long := strings.Repeat("x", maxValueLen+1)

	tests := []struct {
		name    string
		inputs  []string
		options json.RawMessage
		field   string // expected key in Fields ("" = valid)
	}{
		{"strip location ok", []string{jpg}, opts(Options{Action: ActionStripLocation}), ""},
		{"strip all ok", []string{jpg}, opts(Options{Action: ActionStripAll, KeepOrientation: true}), ""},
		{"edit ok", []string{jpg}, opts(Options{Action: ActionEdit, Fields: map[string]string{FieldTitle: "x", FieldDateTimeOriginal: "2024:05:01 10:20:30"}}), ""},
		{"edit remove date ok", []string{jpg}, opts(Options{Action: ActionEdit, Fields: map[string]string{FieldDateTimeOriginal: ""}}), ""},
		{"multiline description ok", []string{jpg}, opts(Options{Action: ActionEdit, Fields: map[string]string{FieldDescription: "a\nb"}}), ""},
		{"default options", []string{jpg}, nil, "action"},
		{"unknown action", []string{jpg}, json.RawMessage(`{"action":"nuke"}`), "action"},
		{"unknown option", []string{jpg}, json.RawMessage(`{"action":"edit","bogus":1}`), ""},
		{"no inputs", nil, opts(Options{Action: ActionStripAll}), "inputs"},
		{"missing file", []string{filepath.Join(dir, "nope.jpg")}, opts(Options{Action: ActionStripAll}), "inputs.0"},
		{"raw", []string{raw}, opts(Options{Action: ActionStripAll}), "inputs.0"},
		{"bmp", []string{bmp}, opts(Options{Action: ActionStripLocation}), "inputs.0"},
		{"edit no fields", []string{jpg}, opts(Options{Action: ActionEdit}), "fields"},
		{"edit unknown field", []string{jpg}, opts(Options{Action: ActionEdit, Fields: map[string]string{"Bogus": "x"}}), "Bogus"},
		{"bad date", []string{jpg}, opts(Options{Action: ActionEdit, Fields: map[string]string{FieldDateTimeOriginal: "2024-05-01"}}), FieldDateTimeOriginal},
		{"too long", []string{jpg}, opts(Options{Action: ActionEdit, Fields: map[string]string{FieldTitle: long}}), FieldTitle},
		{"newline in title", []string{jpg}, opts(Options{Action: ActionEdit, Fields: map[string]string{FieldTitle: "a\nb"}}), FieldTitle},
		{"newline in keywords", []string{jpg}, opts(Options{Action: ActionEdit, Fields: map[string]string{FieldKeywords: "a\nb"}}), FieldKeywords},
	}
	m := New(func(string) (string, error) { return "", errors.New("unused") })
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(tc.inputs, tc.options)
			if tc.name == "unknown option" {
				if err == nil {
					t.Error("unknown options must be rejected")
				}
				return
			}
			if tc.field == "" {
				if err != nil {
					t.Fatalf("unexpected: %v", err)
				}
				return
			}
			var ae *core.AppError
			if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
				t.Fatalf("err = %v", err)
			}
			if _, ok := ae.Fields[tc.field]; !ok {
				t.Errorf("fields = %v, want key %q", ae.Fields, tc.field)
			}
		})
	}
	// The RAW message is the spec'd one.
	err := m.Validate([]string{raw}, opts(Options{Action: ActionStripAll}))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Fields["inputs.0"] != "RAW files are read-only here" {
		t.Errorf("raw message: %v", err)
	}
}

func TestDescriptor(t *testing.T) {
	d := New(func(string) (string, error) { return "", nil }).Descriptor()
	if d.ID != "exif" || !d.SplitInputs || d.MaxInputs != 100 || d.OutputSubdir != "Metadata" || len(d.Requires) != 1 {
		t.Errorf("descriptor: %+v", d)
	}
}
