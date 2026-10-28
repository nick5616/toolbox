//go:build integration

package exif

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
)

// TestExifIntegration installs the real managed ExifTool (network) into a
// temp support dir and runs the module against real JPEGs in a folder with a
// non-ASCII name.
func TestExifIntegration(t *testing.T) {
	// Not the fake: this test must use the real tool.
	t.Setenv("FAKE_EXIFTOOL", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	root := t.TempDir()
	binDir := filepath.Join(root, "support", "bin")
	svc := deps.New(binDir, deps.Catalog(), core.NewRegistry(), core.NopEmitter{})
	var mu sync.Mutex
	var last string
	job := core.NewJobContext(core.JobContext{ID: "install", TempDir: filepath.Join(root, "tmp")}, core.JobHooks{
		Progress: func(_ float64, m string) { mu.Lock(); last = m; mu.Unlock() },
		Log:      func(_ core.LogStream, l string) { t.Log(l) },
	})
	if err := svc.InstallManagedArchive(ctx, job, deps.ExifToolArchive()); err != nil {
		t.Fatalf("install: %v", err)
	}
	t.Logf("install: %s", last)
	exe, err := svc.Resolve(deps.ExifTool)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(exe, filepath.Join(binDir, "exiftool")) {
		t.Errorf("resolved %q, want under the managed dir", exe)
	}
	// A second install is a no-op.
	var again string
	job2 := core.NewJobContext(core.JobContext{ID: "install2", TempDir: filepath.Join(root, "tmp")}, core.JobHooks{
		Progress: func(_ float64, m string) { again = m },
	})
	if err := svc.InstallManagedArchive(ctx, job2, deps.ExifToolArchive()); err != nil || !strings.HasPrefix(again, "Already up to date") {
		t.Errorf("second install: %q %v", again, err)
	}

	m := New(svc.Resolve)
	defer m.Close()

	work := filepath.Join(root, "Fotó Ünï 写真")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(work, "base.jpg")
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for x := 0; x < 64; x++ {
		for y := 0; y < 48; y++ {
			img.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 5), 128, 255})
		}
	}
	f, err := os.Create(base)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(f, img, nil); err != nil {
		t.Fatal(err)
	}
	f.Close()

	photo := filepath.Join(work, "pâté.jpg")
	_, err = m.sess.Exec(ctx,
		"-GPSLatitude=48.858333", "-GPSLatitudeRef=N", "-GPSLongitude=2.294444", "-GPSLongitudeRef=E",
		"-GPSAltitude=35", "-Make=TestCam", "-Model=T-1000", "-Artist=Original Artist",
		"-DateTimeOriginal=2024:05:01 10:20:30", "-Orientation#=6", "-XMP-dc:Title=Old title",
		"-charset", "filename=utf8", "-o", photo, base)
	if err != nil {
		t.Fatalf("seed photo: %v", err)
	}
	sum := func(p string) [32]byte {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		return sha256.Sum256(b)
	}
	before := sum(photo)
	outDir := filepath.Join(work, "Metadata")

	run := func(opts Options) (Result, string) {
		t.Helper()
		var res Result
		var msg string
		raw, _ := json.Marshal(opts)
		var outs []string
		j := core.NewJobContext(core.JobContext{ID: "x", ModuleID: ModuleID, Inputs: []string{photo}, Options: raw,
			OutputDir: outDir, TempDir: t.TempDir()}, core.JobHooks{
			Progress: func(_ float64, m string) { msg = m },
			Log:      func(_ core.LogStream, l string) { t.Log(l) },
			Tool:     svc.Resolve,
			Output:   func(p string) (core.Output, error) { outs = append(outs, p); return core.Output{Path: p}, nil },
			Result:   func(b json.RawMessage) { _ = json.Unmarshal(b, &res) },
		})
		if err := m.Validate([]string{photo}, raw); err != nil {
			t.Fatalf("validate %s: %v", opts.Action, err)
		}
		if err := m.Run(ctx, j); err != nil {
			t.Fatalf("run %s: %v", opts.Action, err)
		}
		if len(outs) != 1 || res.Output != outs[0] {
			t.Fatalf("outputs %v result %+v", outs, res)
		}
		if sum(photo) != before {
			t.Fatalf("%s modified the input", opts.Action)
		}
		return res, msg
	}

	v, err := m.Read(ctx, photo)
	if err != nil {
		t.Fatal(err)
	}
	if !v.HasLocation || v.Location == nil || math.Abs(v.Location.Lat-48.858333) > 1e-4 || math.Abs(v.Location.Lon-2.294444) > 1e-4 {
		t.Fatalf("location: %v %+v", v.HasLocation, v.Location)
	}
	if v.Make != "TestCam" || v.Model != "T-1000" || v.DateTaken != "2024:05:01 10:20:30" || !v.Editable {
		t.Errorf("view header: %q %q %q %v", v.Make, v.Model, v.DateTaken, v.Editable)
	}
	if v.Fields[FieldArtist] != "Original Artist" || v.Fields[FieldTitle] != "Old title" {
		t.Errorf("fields: %v", v.Fields)
	}
	var names []string
	for _, g := range v.Groups {
		names = append(names, g.Name)
	}
	t.Logf("groups: %v", names)

	// strip-location
	res, msg := run(Options{Action: ActionStripLocation})
	t.Logf("strip-location: %+v %q", res, msg)
	if !strings.Contains(filepath.Base(res.Output), "(no location)") || res.RemovedTags < 1 {
		t.Errorf("strip-location result: %+v", res)
	}
	sv, err := m.Read(ctx, res.Output)
	if err != nil {
		t.Fatal(err)
	}
	if sv.HasLocation || sv.Make != "TestCam" {
		t.Errorf("after strip-location: loc=%v make=%q", sv.HasLocation, sv.Make)
	}

	// strip-all keeping orientation
	res, msg = run(Options{Action: ActionStripAll, KeepOrientation: true})
	t.Logf("strip-all: %+v %q", res, msg)
	av, err := m.Read(ctx, res.Output)
	if err != nil {
		t.Fatal(err)
	}
	if av.HasLocation || av.Make != "" || av.Fields[FieldArtist] != "" {
		t.Errorf("after strip-all: %+v", av.Fields)
	}
	orient := ""
	for _, g := range av.Groups {
		for _, fld := range g.Fields {
			if fld.Tag == "IFD0:Orientation" {
				orient = fld.Value
			}
		}
	}
	if orient == "" {
		t.Error("orientation was not kept")
	}
	res, _ = run(Options{Action: ActionStripAll})
	nv, _ := m.Read(ctx, res.Output)
	for _, g := range nv.Groups {
		for _, fld := range g.Fields {
			if fld.Tag == "IFD0:Orientation" {
				t.Errorf("orientation present without KeepOrientation: %v", fld)
			}
		}
	}

	// edit
	res, msg = run(Options{Action: ActionEdit, Fields: map[string]string{
		FieldTitle: "New & <title>", FieldDescription: "Line one\nLine two & more", FieldArtist: "Ünï Artist",
		FieldCopyright: "(c) 2024 Me", FieldKeywords: "paris, eiffel tower,night", FieldDateTimeOriginal: "2020:02:03 04:05:06",
	}})
	t.Logf("edit: %+v %q", res, msg)
	ev, err := m.Read(ctx, res.Output)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		FieldTitle: "New & <title>", FieldDescription: "Line one\nLine two & more", FieldArtist: "Ünï Artist",
		FieldCopyright: "(c) 2024 Me", FieldKeywords: "paris, eiffel tower, night", FieldDateTimeOriginal: "2020:02:03 04:05:06",
	}
	for k, w := range want {
		if ev.Fields[k] != w {
			t.Errorf("edited %s = %q, want %q", k, ev.Fields[k], w)
		}
	}
	if !ev.HasLocation {
		t.Error("edit should keep the location")
	}

	// removing a field
	res, _ = run(Options{Action: ActionEdit, Fields: map[string]string{FieldArtist: "", FieldKeywords: ""}})
	rv, _ := m.Read(ctx, res.Output)
	if rv.Fields[FieldArtist] != "" || rv.Fields[FieldKeywords] != "" || rv.Fields[FieldTitle] != "Old title" {
		t.Errorf("after removal: %v", rv.Fields)
	}
}
