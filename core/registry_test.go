package core

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

type stubModule struct{ d Descriptor }

func (m stubModule) Descriptor() Descriptor                   { return m.d }
func (m stubModule) Validate([]string, json.RawMessage) error { return nil }
func (m stubModule) Run(context.Context, *JobContext) error   { return nil }

func TestRegistryRegisterAndList(t *testing.T) {
	r := NewRegistry()
	must(t, r.Register(stubModule{Descriptor{ID: "b", Name: "Bravo", Order: 10, Status: StatusReady}}))
	must(t, r.Register(stubModule{Descriptor{ID: "a", Name: "Alpha", Order: 10, Status: StatusReady}}))
	must(t, r.Register(stubModule{Descriptor{ID: "z", Name: "Zulu", Order: 1, Status: StatusReady}}))
	must(t, r.Register(stubModule{Descriptor{ID: "sys", Name: "Sys", Hidden: true, Status: StatusReady}}))
	must(t, r.RegisterPlaceholder(Descriptor{ID: "p", Name: "Placeholder", Order: 5, Status: StatusReady}))

	if err := r.Register(stubModule{Descriptor{ID: "a"}}); err == nil {
		t.Fatal("duplicate ID accepted")
	}
	if err := r.RegisterPlaceholder(Descriptor{ID: ""}); err == nil {
		t.Fatal("empty ID accepted")
	}

	var ids []string
	for _, d := range r.List() {
		ids = append(ids, d.ID)
	}
	if want := []string{"z", "p", "a", "b"}; !slices.Equal(ids, want) {
		t.Fatalf("List order = %v, want %v", ids, want)
	}
	if _, ok := r.Get("p"); ok {
		t.Fatal("placeholder is runnable")
	}
	if d, _ := r.Descriptor("p"); d.Status != StatusComingSoon {
		t.Fatalf("placeholder status = %q", d.Status)
	}
	if _, ok := r.Get("sys"); !ok {
		t.Fatal("hidden module not gettable")
	}
}

func TestRegistryMatch(t *testing.T) {
	r := NewRegistry()
	must(t, r.RegisterPlaceholder(Descriptor{ID: "stems", Name: "Stems", Order: 1, Accepts: Accepts{Extensions: []string{".MP3", ".wav"}}}))
	must(t, r.Register(stubModule{Descriptor{ID: "conv", Name: "Conv", Order: 9, Status: StatusReady, Accepts: Accepts{Extensions: []string{".mp3"}}}}))
	must(t, r.Register(stubModule{Descriptor{ID: "sys", Hidden: true, Status: StatusReady, Accepts: Accepts{Extensions: []string{".mp3"}}}}))

	dir := t.TempDir()
	sub := filepath.Join(dir, "folder.mp3")
	must(t, os.Mkdir(sub, 0o755))

	res := r.Match([]string{"/x/Song.MP3", "/x/a.wav", "/x/a.zip", sub, "/x/noext"})
	if len(res.Matches) != 2 {
		t.Fatalf("matches = %+v", res.Matches)
	}
	if res.Matches[0].Module.ID != "conv" {
		t.Fatalf("ready module not first: %+v", res.Matches)
	}
	if !slices.Equal(res.Matches[1].Paths, []string{"/x/Song.MP3", "/x/a.wav"}) {
		t.Fatalf("stems paths = %v", res.Matches[1].Paths)
	}
	if !slices.Equal(res.Unmatched, []string{"/x/a.zip", sub, "/x/noext"}) {
		t.Fatalf("unmatched = %v", res.Unmatched)
	}
}

func TestRegistryRequiringDep(t *testing.T) {
	r := NewRegistry()
	must(t, r.Register(stubModule{Descriptor{ID: "dl", Status: StatusReady, Requires: []string{"yt-dlp", "ffmpeg"}, Recommends: []string{"deno"}}}))
	must(t, r.Register(stubModule{Descriptor{ID: "up", Status: StatusReady, Hidden: true, Requires: []string{"yt-dlp"}}}))
	must(t, r.RegisterPlaceholder(Descriptor{ID: "ph", Requires: []string{"yt-dlp"}}))

	if got := r.RequiringDep("yt-dlp"); !slices.Equal(got, []string{"dl", "up"}) {
		t.Fatalf("RequiringDep = %v", got)
	}
	if got := r.RecommendingDep("deno"); !slices.Equal(got, []string{"dl"}) {
		t.Fatalf("RecommendingDep = %v", got)
	}
}

func TestIsWithin(t *testing.T) {
	base := filepath.Join(t.TempDir(), "lib")
	cases := map[string]bool{
		base:                                   true,
		filepath.Join(base, "a", "b.mp3"):      true,
		filepath.Join(base, "..", "other"):     false,
		filepath.Join(base+"x", "file"):        false,
		filepath.Join(base, "..", "lib", "ok"): true,
	}
	for p, want := range cases {
		if got := IsWithin(p, base); got != want {
			t.Errorf("IsWithin(%q) = %v, want %v", p, got, want)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
