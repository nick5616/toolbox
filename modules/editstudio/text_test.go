package editstudio

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runMarkers(t *testing.T, req TextRequest) (string, *recorder, error) {
	t.Helper()
	m := newTestModule(t)
	r := &recorder{}
	dir := t.TempDir()
	job := newJob(t, dir, Options{Action: ActionText, Text: &req}, r, nil)
	err := m.runText(context.Background(), job, req)
	if len(r.outputs) > 0 {
		return r.outputs[0], r, err
	}
	return "", r, err
}

var sampleRows = []MarkerRow{
	{Lane: "kick", TimelineMs: 0, SongMs: 10_000, Strength: 0.9, Bar: 4, Beat: 16},
	{Lane: "section", TimelineMs: 0, SongMs: 10_000, EndMs: 8000, Strength: 0.85, Label: `Chorus, "big"`, Bar: 4, Beat: -1},
	{Lane: "custom", TimelineMs: 1250, SongMs: 11_250, Strength: 1, Label: "line\nbreak", Bar: 5, Beat: -1},
}

func TestWriteMarkersCSV(t *testing.T) {
	path, r, err := runMarkers(t, TextRequest{Kind: TextMarkersCSV, Name: "My edit markers", Markers: sampleRows})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "My edit markers.csv" || len(r.outputs) != 1 {
		t.Fatalf("path %q outputs %v", path, r.outputs)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "\r\n") {
		t.Fatal("RFC 4180 wants CRLF")
	}
	recs, err := csv.NewReader(strings.NewReader(string(b))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"lane", "timeline_ms", "song_ms", "end_ms", "strength", "label", "bar", "beat"},
		{"kick", "0", "10000", "", "0.900", "", "4", "16"},
		{"section", "0", "10000", "8000", "0.850", `Chorus, "big"`, "4", ""},
		{"custom", "1250", "11250", "", "1.000", "line\nbreak", "5", ""},
	}
	if len(recs) != len(want) {
		t.Fatalf("rows %d want %d", len(recs), len(want))
	}
	for i := range want {
		if strings.Join(recs[i], "|") != strings.Join(want[i], "|") {
			t.Errorf("row %d = %q want %q", i, recs[i], want[i])
		}
	}
}

func TestWriteMarkersJSON(t *testing.T) {
	meta := `{"project":"Edit","song":"/m/s.mp3","startMs":10000,"endMs":40000,"fps":30}`
	path, _, err := runMarkers(t, TextRequest{Kind: TextMarkersJSON, Name: "Edit markers", Markers: sampleRows, Meta: meta})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Ext(path) != ".json" {
		t.Fatal(path)
	}
	b, _ := os.ReadFile(path)
	var got struct {
		Project string      `json:"project"`
		EndMs   int         `json:"endMs"`
		FPS     int         `json:"fps"`
		Markers []MarkerRow `json:"markers"`
	}
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Project != "Edit" || got.EndMs != 40000 || got.FPS != 30 || len(got.Markers) != 3 || got.Markers[1].Label != `Chorus, "big"` {
		t.Fatalf("%+v", got)
	}
}

func TestWriteMarkersNames(t *testing.T) {
	cases := []struct{ name, want string }{
		{"a/b:c markers", "a_b_c markers.csv"},
		{"   ", "Untitled.csv"},
		{"x?.", "x_.csv"},
	}
	for _, c := range cases {
		path, _, err := runMarkers(t, TextRequest{Kind: TextMarkersCSV, Name: c.name, Markers: sampleRows})
		if err != nil {
			t.Fatal(err)
		}
		if got := filepath.Base(path); got != c.want {
			t.Errorf("%q -> %q want %q", c.name, got, c.want)
		}
	}
}

func TestWriteMarkersUniqueAndErrors(t *testing.T) {
	m := newTestModule(t)
	r := &recorder{}
	req := TextRequest{Kind: TextMarkersCSV, Name: "x", Markers: sampleRows}
	job := newJob(t, t.TempDir(), Options{Action: ActionText, Text: &req}, r, nil)
	for i := 0; i < 2; i++ {
		if err := m.runText(context.Background(), job, req); err != nil {
			t.Fatal(err)
		}
	}
	if filepath.Base(r.outputs[0]) != "x.csv" || filepath.Base(r.outputs[1]) != "x (1).csv" {
		t.Fatalf("%v", r.outputs)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.writeMarkers(ctx, job, req); err == nil {
		t.Fatal("cancelled context should fail")
	}
	bad := TextRequest{Kind: TextMarkersJSON, Name: "x", Markers: sampleRows, Meta: "[1]"}
	if err := m.writeMarkers(context.Background(), job, bad); err == nil {
		t.Fatal("meta that isn't an object should fail")
	}
}
