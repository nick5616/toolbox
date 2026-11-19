package captions

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestExifArgs(t *testing.T) {
	f := Fields{
		Alt: "A dog", Description: "A dog on a beach.\nIt is sunny.", Caption: "Walkies", Title: "Dog", Keywords: []string{"dog", "beach"},
	}
	wo := DefaultOptions().Write
	got := exifArgs(f, wo)
	want := []string{
		"-charset", "iptc=UTF8", "-codedcharacterset=utf8", "-m", "-overwrite_original",
		"-XMP-iptcCore:AltTextAccessibility=A dog",
		"-XMP-iptcCore:ExtDescrAccessibility=A dog on a beach. It is sunny.",
		"-XMP-dc:Description=Walkies", "-EXIF:ImageDescription=Walkies", "-IPTC:Caption-Abstract=Walkies",
		"-XMP-dc:Title=Dog",
		"-XMP-dc:Subject=dog", "-IPTC:Keywords=dog", "-XMP-dc:Subject=beach", "-IPTC:Keywords=beach",
		"-gps:all=", "-xmp:GPS*=",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got\n%q\nwant\n%q", got, want)
	}
	// Caption from the description, location kept, only some fields.
	wo = WriteOptions{Caption: true, CaptionFrom: FieldDescription, KeepLocation: true}
	got = exifArgs(f, wo)
	want = []string{
		"-charset", "iptc=UTF8", "-codedcharacterset=utf8", "-m", "-overwrite_original",
		"-XMP-dc:Description=A dog on a beach. It is sunny.", "-EXIF:ImageDescription=A dog on a beach. It is sunny.",
		"-IPTC:Caption-Abstract=A dog on a beach. It is sunny.",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got\n%q\nwant\n%q", got, want)
	}
	// Empty fields are skipped, never blanked.
	got = exifArgs(Fields{}, DefaultOptions().Write)
	for _, a := range got {
		if strings.Contains(a, "=") && strings.HasSuffix(a, "=") && !strings.HasPrefix(a, "-gps") && !strings.HasPrefix(a, "-xmp:GPS") {
			t.Errorf("blank assignment %q", a)
		}
	}
}

func TestVideoArgs(t *testing.T) {
	f := Fields{Alt: "A dog", Description: "Long text", Caption: "Walkies", Title: "Dog", Keywords: []string{"dog", "beach"}}
	meta := videoMetaArgs(f, DefaultOptions().Write, ".mp4")
	want := []string{
		"-metadata", "title=Dog", "-metadata", "description=Long text", "-metadata", "comment=Walkies",
		"-metadata", "keywords=dog, beach", "-metadata", "location=", "-metadata", "location-eng=",
	}
	if !reflect.DeepEqual(meta, want) {
		t.Errorf("got %q", meta)
	}
	if got := videoMetaArgs(f, DefaultOptions().Write, ".webm"); !reflect.DeepEqual(got, []string{"-metadata", "title=Dog"}) {
		t.Errorf("webm %q", got)
	}
	keep := DefaultOptions().Write
	keep.KeepLocation = true
	for _, a := range videoMetaArgs(f, keep, ".mkv") {
		if strings.HasPrefix(a, "location") {
			t.Errorf("location touched while kept: %q", a)
		}
	}
	args := videoArgs("in.mp4", "out.mp4", meta, ".mp4")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-i in.mp4 -map 0 -c copy") || !strings.HasSuffix(joined, "use_metadata_tags out.mp4") {
		t.Errorf("args %s", joined)
	}
	if strings.Contains(strings.Join(videoArgs("in.mkv", "o.mkv", nil, ".mkv"), " "), "movflags") {
		t.Error("movflags only for mp4/mov")
	}
}

// captioned runs a caption job and returns the batch folder.
func captioned(t *testing.T, e *env, in []string, o Options) string {
	t.Helper()
	rec, err := mustRun(t, e, in, o)
	if err != nil {
		t.Fatal(err)
	}
	return rec.batchDir(t)
}

func writeOptions(dir string, wo WriteOptions) Options {
	o := DefaultOptions()
	o.Action, o.Batch, o.Write = ActionWrite, dir, wo
	return o
}

func TestWriteIntoCopies(t *testing.T) {
	e := newEnv(t)
	logPath := e.useFakeTools()
	e.vision.replies = []string{good("dog")}
	in := photos(t, t.TempDir(), "a.jpg", "b.jpg")
	o := DefaultOptions()
	o.Preset = PresetEverything
	dir := captioned(t, e, in, o)
	before := hashFiles(t, in)
	_ = os.Remove(logPath)

	rec := &recorder{}
	if err := e.m.Run(context.Background(), e.job(nil, writeOptions(dir, DefaultOptions().Write), rec)); err != nil {
		t.Fatal(err)
	}
	// Inputs untouched; copies exist and were written by the tool.
	for p, h := range hashFiles(t, in) {
		if before[p] != h {
			t.Errorf("input %s changed", p)
		}
	}
	for _, name := range []string{"a.jpg", "b.jpg"} {
		b, err := os.ReadFile(filepath.Join(dir, WithCaptionsDir, name))
		if err != nil || !strings.HasSuffix(string(b), "EXIFWRITTEN") {
			t.Errorf("%s copy: %v", name, err)
		}
	}
	if len(rec.outputs) != 2 || !reflect.DeepEqual(rec.outputs[0].Inputs, in[:1]) || filepath.Base(rec.outputs[1].Path) != "b.jpg" {
		t.Errorf("outputs %+v", rec.outputs)
	}
	log, _ := os.ReadFile(logPath)
	text := string(log)
	for _, want := range []string{
		"-XMP-iptcCore:AltTextAccessibility=A dog on a table", "-XMP-dc:Title=The dog", "-XMP-dc:Subject=dog", "-IPTC:Keywords=table",
		"-overwrite_original", "-gps:all=", "-xmp:GPS*=", "iptc=UTF8", "-codedcharacterset=utf8",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("exiftool log lacks %q:\n%s", want, text)
		}
	}
	// The command line: charset first, then the argfile, then the copy only.
	first := strings.SplitN(text, "\n", 2)[0]
	parts := strings.Split(first, "\x1f")
	if len(parts) != 8 || parts[1] != "-charset" || parts[2] != "utf8" || parts[5] != "-@" || parts[7] != filepath.Join(dir, WithCaptionsDir, "a.jpg") {
		t.Errorf("command line %q", parts)
	}
	for _, p := range parts {
		if p == in[0] {
			t.Error("exiftool was given the input")
		}
	}
	var res result
	if err := json.Unmarshal(rec.result, &res); err != nil || res.Done != 2 || res.Failed != 0 {
		t.Errorf("result %+v %v", res, err)
	}

	// Keep location: no GPS stripping. Second run: copies get unique names.
	_ = os.Remove(logPath)
	wo := DefaultOptions().Write
	wo.KeepLocation = true
	if err := e.m.Run(context.Background(), e.job(nil, writeOptions(dir, wo), &recorder{})); err != nil {
		t.Fatal(err)
	}
	log, _ = os.ReadFile(logPath)
	if strings.Contains(string(log), "-gps:all=") {
		t.Error("GPS stripped although location was kept")
	}
	if _, err := os.Stat(filepath.Join(dir, WithCaptionsDir, "a (1).jpg")); err != nil {
		t.Errorf("second copy should not overwrite: %v", err)
	}
}

func TestWriteErrorsArePerFile(t *testing.T) {
	e := newEnv(t)
	e.useFakeTools()
	e.vision.replies = []string{good("dog")}
	in := photos(t, t.TempDir(), "a.jpg", "bad.jpg", "c.jpg")
	dir := captioned(t, e, in, DefaultOptions())
	t.Setenv("FAKE_CAPTIONS_FAIL", "bad.jpg")
	rec := &recorder{}
	if err := e.m.Run(context.Background(), e.job(nil, writeOptions(dir, DefaultOptions().Write), rec)); err != nil {
		t.Fatalf("one failing file must not fail the job: %v", err)
	}
	if len(rec.outputs) != 2 {
		t.Errorf("outputs %+v", rec.outputs)
	}
	if _, err := os.Stat(filepath.Join(dir, WithCaptionsDir, "bad.jpg")); !os.IsNotExist(err) {
		t.Error("the failed copy should be removed")
	}
	found := false
	for _, l := range rec.logs {
		found = found || (strings.Contains(l, "bad.jpg") && strings.Contains(l, "Not a valid JPEG"))
	}
	if !found {
		t.Errorf("logs %q", rec.logs)
	}
	var res result
	_ = json.Unmarshal(rec.result, &res)
	if res.Done != 2 || res.Failed != 1 {
		t.Errorf("result %+v", res)
	}
	// Everything failing is an error.
	t.Setenv("FAKE_CAPTIONS_FAIL", ".jpg")
	err := e.m.Run(context.Background(), e.job(nil, writeOptions(dir, DefaultOptions().Write), &recorder{}))
	if err == nil || !strings.Contains(err.Error(), "Couldn't write any file") {
		t.Errorf("err %v", err)
	}
}

func TestWriteWithoutExifTool(t *testing.T) {
	e := newEnv(t)
	e.vision.replies = []string{good("dog")}
	in := photos(t, t.TempDir(), "a.jpg")
	dir := captioned(t, e, in, DefaultOptions())
	rec := &recorder{}
	err := e.m.Run(context.Background(), e.job(nil, writeOptions(dir, DefaultOptions().Write), rec))
	if err == nil || !strings.Contains(err.Error(), "ExifTool") {
		t.Errorf("err %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(dir, WithCaptionsDir)); len(entries) != 0 {
		t.Errorf("leftover copies: %v", entries)
	}
}

func TestWriteVideoCopy(t *testing.T) {
	e := newEnv(t)
	logPath := e.useFakeTools()
	e.vision.replies = []string{good("dog")}
	dir0 := t.TempDir()
	vid := filepath.Join(dir0, "clip.mp4")
	if err := os.WriteFile(vid, []byte("VIDEO"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := captioned(t, e, []string{vid}, DefaultOptions())
	_ = os.Remove(logPath)
	rec := &recorder{}
	if err := e.m.Run(context.Background(), e.job(nil, writeOptions(dir, DefaultOptions().Write), rec)); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, WithCaptionsDir, "clip.mp4"))
	if err != nil || string(b) != "VIDEO\nFFMPEGWRITTEN" {
		t.Errorf("copy %q %v", b, err)
	}
	if src, _ := os.ReadFile(vid); string(src) != "VIDEO" {
		t.Error("the input video changed")
	}
	log, _ := os.ReadFile(logPath)
	for _, want := range []string{"-c\x1fcopy", "comment=Look at this dog", "location=", "location-eng=", "-map\x1f0"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("ffmpeg log lacks %q: %q", want, log)
		}
	}
}

func TestRenameCopies(t *testing.T) {
	e := newEnv(t)
	e.vision.replies = []string{`{"name":"Dog on the beach"}`}
	dir0 := t.TempDir()
	in := photos(t, dir0, "a.jpg", "b.jpg", "c.JPG")
	o := DefaultOptions()
	o.Preset = PresetRename
	dir := captioned(t, e, in, o)
	before := hashFiles(t, in)
	// c has no name (user cleared it); a, b share one.
	if _, err := e.m.updateItem(dir, 2, func(it *Item) { it.Fields.Name = "" }); err != nil {
		t.Fatal(err)
	}
	ro := DefaultOptions()
	ro.Action, ro.Batch = ActionRename, dir
	rec := &recorder{}
	if err := e.m.Run(context.Background(), e.job(nil, ro, rec)); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, o := range rec.outputs {
		got = append(got, filepath.Base(o.Path))
	}
	if !reflect.DeepEqual(got, []string{"Dog on the beach.jpg", "Dog on the beach (1).jpg"}) {
		t.Errorf("outputs %v", got)
	}
	if !reflect.DeepEqual(rec.outputs[1].Inputs, in[1:2]) {
		t.Errorf("lineage %v", rec.outputs[1].Inputs)
	}
	var res result
	_ = json.Unmarshal(rec.result, &res)
	if res.Done != 2 || res.Failed != 1 {
		t.Errorf("result %+v", res)
	}
	// Run again: never overwrites.
	rec2 := &recorder{}
	if err := e.m.Run(context.Background(), e.job(nil, ro, rec2)); err != nil {
		t.Fatal(err)
	}
	if filepath.Base(rec2.outputs[0].Path) != "Dog on the beach (2).jpg" || filepath.Base(rec2.outputs[1].Path) != "Dog on the beach (3).jpg" {
		t.Errorf("second run %+v", rec2.outputs)
	}
	for p, h := range hashFiles(t, in) {
		if before[p] != h {
			t.Errorf("input %s changed", p)
		}
		if _, err := os.Stat(p); err != nil {
			t.Errorf("input %s was moved", p)
		}
	}
}

func TestThenInSameJob(t *testing.T) {
	e := newEnv(t)
	e.useFakeTools()
	e.vision.replies = []string{`{"name":"Harbour","alt":"x","caption":"y","hashtags":[],"title":"z","description":"d","keywords":["k"]}`}
	in := photos(t, t.TempDir(), "a.jpg")
	o := DefaultOptions()
	o.Preset = PresetEverything
	o.Then = ThenRenameCopies
	rec, err := mustRun(t, e, in, o)
	if err != nil {
		t.Fatal(err)
	}
	if !rec.hasOutput("Harbour.jpg") || !rec.hasOutput(CSVFile) {
		t.Errorf("outputs %+v", rec.outputs)
	}
	o.Then = ThenWriteCopies
	rec, err = mustRun(t, e, in, o)
	if err != nil {
		t.Fatal(err)
	}
	if !rec.hasOutput("a.jpg") {
		t.Errorf("outputs %+v", rec.outputs)
	}
}
