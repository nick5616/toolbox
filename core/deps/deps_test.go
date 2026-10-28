package deps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"toolbox/core"
)

// TestMain doubles as a fake tool: when DEPS_FAKE=1 the binary behaves per
// DEPS_FAKE_<NAME> ("fail", "hang", or the text to print).
func TestMain(m *testing.M) {
	if os.Getenv("DEPS_FAKE") == "1" {
		base := strings.TrimSuffix(filepath.Base(os.Args[0]), filepath.Ext(os.Args[0]))
		mode := os.Getenv("DEPS_FAKE_" + strings.ToUpper(strings.ReplaceAll(base, "-", "_")))
		switch mode {
		case "fail":
			fmt.Fprintln(os.Stderr, "boom")
			os.Exit(3)
		case "hang":
			time.Sleep(time.Minute)
		}
		fmt.Println(strings.ReplaceAll(mode, `\n`, "\n"))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func exeName(n string) string {
	if runtime.GOOS == "windows" {
		return n + ".exe"
	}
	return n
}

// fakeTool copies the test binary to dir/<name>[.exe].
func fakeTool(t *testing.T, dir, name string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, exeName(name))
	if err := os.WriteFile(p, data, 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func noLook(string) (string, error) { return "", errors.New("not found") }

func newSvc(t *testing.T, binDir string, reg *core.Registry, known ...string) *Service {
	t.Helper()
	if reg == nil {
		reg = core.NewRegistry()
	}
	s := New(binDir, Catalog(), reg, core.NopEmitter{})
	s.lookPath = noLook
	s.knownDirs = func() []string { return known }
	return s
}

func find(t *testing.T, list []core.DepStatus, id string) core.DepStatus {
	t.Helper()
	for _, d := range list {
		if d.ID == id {
			return d
		}
	}
	t.Fatalf("dep %s not in list", id)
	return core.DepStatus{}
}

func TestVersionRegexes(t *testing.T) {
	specs := map[string]Spec{}
	for _, sp := range Catalog() {
		specs[sp.ID] = sp
	}
	tests := []struct{ id, out, want string }{
		{FFmpeg, "ffmpeg version 8.0-full_build-www.gyan.dev Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc 15", "8.0-full_build-www.gyan.dev"},
		{FFmpeg, "ffmpeg version 7.1.1 Copyright (c)", "7.1.1"},
		{FFprobe, "ffprobe version 8.0-full_build Copyright", "8.0-full_build"},
		{Deno, "deno 2.5.1 (stable, release, x86_64-pc-windows-msvc)\nv8 14.0\ntypescript 5.9", "2.5.1"},
		{Node, "v24.22.1", "24.22.1"},
		{YtDlp, "2026.10.26", "2026.10.26"},
		{ExifTool, "13.10", "13.10"},
	}
	for _, tc := range tests {
		if got := parseVersion(specs[tc.id], tc.out); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.id, got, tc.want)
		}
	}
	if got := parseVersion(specs[FFmpeg], "garbage"); got != "" {
		t.Errorf("expected no match, got %q", got)
	}
}

func TestCatalogShape(t *testing.T) {
	c := Catalog()
	if len(c) != 9 {
		t.Fatalf("len=%d", len(c))
	}
	for _, sp := range c {
		for _, os := range []string{"darwin", "windows", "linux"} {
			if sp.InstallHint[os] == "" {
				t.Errorf("%s: no hint for %s", sp.ID, os)
			}
		}
		versioned := sp.VersionFile != "" || (sp.VersionRegex != nil && len(sp.VersionArgs) > 0)
		if sp.Purpose == "" || !versioned {
			t.Errorf("%s incomplete", sp.ID)
		}
	}
	if !strings.Contains(c[0].InstallHint["windows"], "Settings → Dependencies") || !c[0].Managed {
		t.Error("yt-dlp spec")
	}
	if !strings.Contains(strings.ToLower(c[2].InstallHint["windows"]), "ffmpeg") {
		t.Error("ffprobe hint")
	}
}

func TestResolutionOrder(t *testing.T) {
	t.Setenv("DEPS_FAKE", "1")
	t.Setenv("DEPS_FAKE_FFMPEG", "ffmpeg version 1.0 x")
	root := t.TempDir()
	bin, pathDir, known := filepath.Join(root, "bin"), filepath.Join(root, "path"), filepath.Join(root, "known")
	fakeTool(t, known, "ffmpeg")

	s := newSvc(t, bin, nil, known)
	s.lookPath = func(f string) (string, error) {
		p := filepath.Join(pathDir, f)
		if _, err := os.Stat(p); err != nil {
			return "", err
		}
		return p, nil
	}
	sp, _ := s.spec(FFmpeg)

	if _, src := s.find(sp); src != core.SourceKnownDir {
		t.Fatalf("want known-dir, got %q", src)
	}
	pp := fakeTool(t, pathDir, "ffmpeg")
	if p, src := s.find(sp); src != core.SourcePath || p != pp {
		t.Fatalf("want path, got %q %q", src, p)
	}
	// A loose binary in bin/ doesn't count for a pinned archive tool…
	fakeTool(t, bin, "ffmpeg")
	if _, src := s.find(sp); src != core.SourcePath {
		t.Fatalf("loose managed binary used: %q", src)
	}
	// …its own folder does, ahead of the system copy (AllowSystem).
	mp := fakeTool(t, filepath.Join(bin, "ffmpeg"), "ffmpeg")
	if p, src := s.find(sp); src != core.SourceManaged || p != mp {
		t.Fatalf("want managed, got %q %q", src, p)
	}
}

func TestAllowSystemNeverOutdated(t *testing.T) {
	t.Setenv("DEPS_FAKE", "1")
	t.Setenv("DEPS_FAKE_FFMPEG", "ffmpeg version 7.0 x")
	root := t.TempDir()
	known := filepath.Join(root, "known")
	fakeTool(t, known, "ffmpeg")
	s := newSvc(t, filepath.Join(root, "bin"), nil, known)
	sp, _ := s.spec(FFmpeg)
	st := s.detectOne(context.Background(), sp)
	if st.State != core.DepOK || st.Version != "7.0" || st.Source != core.SourceKnownDir {
		t.Fatalf("system copy: %+v", st)
	}
	// The managed copy is pinned: a stale VERSION is outdated.
	dir := filepath.Join(root, "bin", "ffmpeg")
	fakeTool(t, dir, "ffmpeg")
	if err := os.WriteFile(filepath.Join(dir, "VERSION"), []byte("8.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := s.detectOne(context.Background(), sp); st.State != core.DepOutdated || st.Source != core.SourceManaged {
		t.Fatalf("managed stale copy: %+v", st)
	}
}

func TestKnownDirsDefaults(t *testing.T) {
	for _, g := range []string{"darwin", "windows", "linux"} {
		if len(defaultKnownDirs(g)) == 0 {
			t.Errorf("%s: empty", g)
		}
	}
	if d := defaultKnownDirs("darwin"); d[0] != "/opt/homebrew/bin" {
		t.Errorf("darwin dirs: %v", d)
	}
}

func TestDetectStates(t *testing.T) {
	t.Setenv("DEPS_FAKE", "1")
	t.Setenv("DEPS_FAKE_FFMPEG", `ffmpeg version 8.0 Copyright\nbuilt`)
	t.Setenv("DEPS_FAKE_FFPROBE", "fail")
	t.Setenv("DEPS_FAKE_DENO", "hang")
	t.Setenv("DEPS_FAKE_NODE", "v24.22.1")
	// FFmpeg and Deno are pinned managed archives now; these are system copies.
	bin, sys := t.TempDir(), t.TempDir()
	for _, n := range []string{"ffmpeg", "ffprobe", "deno", "node"} {
		fakeTool(t, sys, n)
	}
	var mu sync.Mutex
	var events []core.DepsChanged
	em := core.EmitterFunc(func(name string, data any) {
		if name == core.EventDepsChanged {
			mu.Lock()
			events = append(events, data.(core.DepsChanged))
			mu.Unlock()
		}
	})
	s := New(bin, Catalog(), core.NewRegistry(), em)
	s.lookPath = noLook
	s.knownDirs = func() []string { return []string{sys} }

	pre := s.List()
	if len(pre) != 9 || pre[0].State != core.DepMissing || pre[0].InstallHint == "" || pre[0].RequiredBy == nil {
		t.Fatalf("pre-detect list: %+v", pre[0])
	}

	// deno hang: shrink nothing; real 5s timeout applies.
	got := s.Detect(context.Background())
	if len(got) != 9 {
		t.Fatalf("len=%d", len(got))
	}
	if d := find(t, got, FFmpeg); d.State != core.DepOK || d.Version != "8.0" || d.Source != core.SourceKnownDir || d.CheckedAt == 0 {
		t.Errorf("ffmpeg: %+v", d)
	}
	if d := find(t, got, FFprobe); d.State != core.DepError || d.Error == "" {
		t.Errorf("ffprobe: %+v", d)
	}
	if d := find(t, got, Deno); d.State != core.DepError || !strings.Contains(d.Error, "timed out") {
		t.Errorf("deno: %+v", d)
	}
	if d := find(t, got, Node); d.State != core.DepOK || d.Version != "24.22.1" {
		t.Errorf("node: %+v", d)
	}
	if d := find(t, got, ExifTool); d.State != core.DepMissing || d.Path != "" {
		t.Errorf("exiftool: %+v", d)
	}
	mu.Lock()
	if len(events) != 1 || len(events[0].Deps) != 9 {
		t.Errorf("events: %d", len(events))
	}
	mu.Unlock()
	if d := find(t, s.List(), FFmpeg); d.State != core.DepOK {
		t.Error("cache not populated")
	}
}

func TestResolve(t *testing.T) {
	t.Setenv("DEPS_FAKE", "1")
	t.Setenv("DEPS_FAKE_FFMPEG", "ffmpeg version 2.0")
	bin := t.TempDir()
	s := newSvc(t, bin, nil)

	if _, err := s.Resolve("nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	_, err := s.Resolve(FFmpeg)
	if !core.IsCode(err, core.CodeDependencyMissing) {
		t.Fatalf("want missing, got %v", err)
	}
	if ae := core.AsAppError(err); ae.Hint == "" {
		t.Error("no hint")
	}
	// Installed after the failed check: on-demand re-detect finds it.
	want := fakeTool(t, filepath.Join(bin, "ffmpeg"), "ffmpeg")
	if err := os.WriteFile(filepath.Join(bin, "ffmpeg", "VERSION"), []byte(FFmpegVersion), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := s.Resolve(FFmpeg)
	if err != nil || got != want {
		t.Fatalf("got %q %v", got, err)
	}
	// Cached OK: removing the file doesn't matter.
	os.Remove(want)
	if got, err := s.Resolve(FFmpeg); err != nil || got != want {
		t.Fatalf("cached: %q %v", got, err)
	}
}

type fakeMod struct{ d core.Descriptor }

func (f fakeMod) Descriptor() core.Descriptor                 { return f.d }
func (f fakeMod) Validate([]string, json.RawMessage) error    { return nil }
func (f fakeMod) Run(context.Context, *core.JobContext) error { return nil }

func TestRequiredBy(t *testing.T) {
	reg := core.NewRegistry()
	s := newSvc(t, t.TempDir(), reg)
	before := s.List()
	if find(t, before, YtDlp).Required {
		t.Fatal("required before registration")
	}
	// Modules register after New.
	if err := reg.Register(fakeMod{core.Descriptor{ID: "downloader", Name: "D", Status: core.StatusReady,
		Requires: []string{YtDlp, FFmpeg}, Recommends: []string{Deno}}}); err != nil {
		t.Fatal(err)
	}
	if err := reg.Register(fakeMod{core.Descriptor{ID: UpdateModuleID, Name: "U", Status: core.StatusReady,
		Requires: []string{YtDlp}}}); err != nil {
		t.Fatal(err)
	}
	if err := reg.RegisterPlaceholder(core.Descriptor{ID: "ph", Name: "P", Requires: []string{FFprobe}}); err != nil {
		t.Fatal(err)
	}
	l := s.List()
	y := find(t, l, YtDlp)
	if !y.Required || len(y.RequiredBy) != 1 || y.RequiredBy[0] != "downloader" {
		t.Errorf("yt-dlp: %+v", y)
	}
	if d := find(t, l, Deno); d.Required || len(d.RecommendedBy) != 1 || d.RecommendedBy[0] != "downloader" {
		t.Errorf("deno: %+v", d)
	}
	if d := find(t, l, FFprobe); d.Required || d.RequiredBy == nil || len(d.RequiredBy) != 0 {
		t.Errorf("ffprobe: %+v", d)
	}
}
