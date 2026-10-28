package packs

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/sidecar"
)

// ---- fakes ------------------------------------------------------------------

// world is the fake machine: which deps and models are installed.
type world struct {
	mu     sync.Mutex
	dep    map[string]core.DepStatus // by dep ID; absent = missing
	models map[string]bool           // "module/preset"
	log    []string                  // installer/fetch order
	fail   map[string]error          // dep ID or "module/preset" → error
	svc    *deps.Service
}

func (w *world) set(id string, st core.DepState, src core.DepSource) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.dep[id] = core.DepStatus{ID: id, State: st, Source: src, Path: "/x/" + id}
}

func (w *world) detect(id string) func(context.Context) core.DepStatus {
	return func(context.Context) core.DepStatus {
		w.mu.Lock()
		defer w.mu.Unlock()
		if d, ok := w.dep[id]; ok {
			return d
		}
		return core.DepStatus{ID: id, State: core.DepMissing}
	}
}

// fakeInstaller is a dependency installer module.
type fakeInstaller struct {
	w     *world
	id    string // module ID
	dep   string
	steps int
}

func (f *fakeInstaller) Descriptor() core.Descriptor {
	return core.Descriptor{ID: f.id, Name: f.id, Hidden: true, Status: core.StatusReady, Category: core.CategoryUtility}
}
func (f *fakeInstaller) Validate([]string, json.RawMessage) error { return nil }
func (f *fakeInstaller) Run(ctx context.Context, job *core.JobContext) error {
	if string(job.Options) != "{}" {
		return errors.New("installer got options " + string(job.Options))
	}
	f.w.mu.Lock()
	f.w.log = append(f.w.log, f.dep)
	err := f.w.fail[f.dep]
	f.w.mu.Unlock()
	job.Progress(0.5, "half")
	if err != nil {
		return err
	}
	f.w.set(f.dep, core.DepOK, core.SourceManaged)
	f.w.svc.Detect(ctx)
	job.Progress(1, "done")
	return nil
}

// fakeModels is a tool module that is also a ModelProvider.
type fakeModels struct {
	w  *world
	id string
}

func (f *fakeModels) Descriptor() core.Descriptor {
	return core.Descriptor{ID: f.id, Name: "Tool " + f.id, Icon: "i-" + f.id, Status: core.StatusReady, Category: core.CategoryAudio}
}
func (f *fakeModels) Validate([]string, json.RawMessage) error    { return nil }
func (f *fakeModels) Run(context.Context, *core.JobContext) error { return nil }
func (f *fakeModels) ModelPresent(preset string) bool {
	f.w.mu.Lock()
	defer f.w.mu.Unlock()
	return f.w.models[f.id+"/"+preset]
}
func (f *fakeModels) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	key := f.id + "/" + preset
	f.w.mu.Lock()
	f.w.log = append(f.w.log, key)
	err := f.w.fail[key]
	f.w.mu.Unlock()
	job.Progress(0.5, "half")
	if err != nil {
		return err
	}
	f.w.mu.Lock()
	f.w.models[key] = true
	f.w.mu.Unlock()
	job.Progress(1, "done")
	return nil
}
func (f *fakeModels) RemoveModel(preset string) error {
	f.w.mu.Lock()
	defer f.w.mu.Unlock()
	delete(f.w.models, f.id+"/"+preset)
	return nil
}

type fixture struct {
	t       *testing.T
	w       *world
	s       *Service
	reg     *core.Registry
	paths   core.Paths
	support string
	events  *[]core.PacksChanged
	mu      *sync.Mutex
}

func newFixture(t *testing.T, goos, goarch string) *fixture {
	t.Helper()
	support, tools := t.TempDir(), t.TempDir()
	paths := core.NewPathsWithTools(support, tools)
	reg := core.NewRegistry()
	w := &world{dep: map[string]core.DepStatus{}, models: map[string]bool{}, fail: map[string]error{}}
	svc := deps.New(paths.BinDir, nil, reg, core.NopEmitter{})
	w.svc = svc
	for _, id := range []string{deps.YtDlp, deps.FFmpeg, deps.Deno, sidecar.DepID, deps.Upscayl, deps.ExifTool, deps.Llama} {
		svc.RegisterVirtual(deps.Spec{ID: id, Name: id, Managed: true}, w.detect(id))
	}
	for dep, mod := range installerModules {
		if err := reg.Register(&fakeInstaller{w: w, id: mod, dep: dep}); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"stems", "transcribe", "bg-remover", "llm-chat"} {
		if err := reg.Register(&fakeModels{w: w, id: id}); err != nil {
			t.Fatal(err)
		}
	}
	var mu sync.Mutex
	var events []core.PacksChanged
	em := core.EmitterFunc(func(name string, data any) {
		if name == core.EventPacksChanged {
			mu.Lock()
			events = append(events, data.(core.PacksChanged))
			mu.Unlock()
		}
	})
	s := New(Config{Paths: paths, Reg: reg, Deps: svc, Emitter: em, GOOS: goos, GOARCH: goarch,
		StopEngines: func() {}})
	s.notifyDelay = 0
	if err := Register(reg, s); err != nil {
		t.Fatal(err)
	}
	svc.Detect(context.Background())
	return &fixture{t: t, w: w, s: s, reg: reg, paths: paths, support: support, events: &events, mu: &mu}
}

func (f *fixture) pack(id string) core.PackStatus {
	f.t.Helper()
	for _, p := range f.s.List() {
		if p.ID == id {
			return p
		}
	}
	f.t.Fatalf("no pack %s", id)
	return core.PackStatus{}
}

func (f *fixture) comp(packID, compID string) core.PackComponentStatus {
	f.t.Helper()
	for _, c := range f.pack(packID).Components {
		if c.ID == compID {
			return c
		}
	}
	f.t.Fatalf("no component %s in %s", compID, packID)
	return core.PackComponentStatus{}
}

type progress struct {
	mu    sync.Mutex
	pcts  []float64
	title string
	logs  []string
}

func (f *fixture) job(opts any) (*core.JobContext, *progress) {
	f.t.Helper()
	b, _ := json.Marshal(opts)
	p := &progress{}
	return core.NewJobContext(core.JobContext{ID: "job1", Options: b, TempDir: f.t.TempDir()}, core.JobHooks{
		Progress: func(pct float64, _ string) { p.mu.Lock(); p.pcts = append(p.pcts, pct); p.mu.Unlock() },
		Log:      func(_ core.LogStream, l string) { p.logs = append(p.logs, l) },
		Title:    func(t string) { p.title = t },
		Tool:     func(string) (string, error) { return "/x", nil },
	}), p
}

func (f *fixture) runInstall(pack string, only ...string) (*progress, error) {
	f.t.Helper()
	mod, _ := f.reg.Get(InstallModuleID)
	job, p := f.job(InstallOptions{Pack: pack, Only: only})
	return p, mod.Run(context.Background(), job)
}

func monotonic(t *testing.T, pcts []float64) {
	t.Helper()
	prev := -1.0
	for _, p := range pcts {
		if p < 0 {
			continue
		}
		if p < prev-1e-9 || p > 1+1e-9 {
			t.Fatalf("progress not monotonic within [0,1]: %v", pcts)
		}
		prev = p
	}
}

const win, mac = "windows", "darwin"

// ---- catalog ----------------------------------------------------------------

func TestCatalogIntegrity(t *testing.T) {
	comps := map[string]ComponentSpec{}
	for _, c := range Components() {
		if _, dup := comps[c.ID]; dup {
			t.Errorf("duplicate component %s", c.ID)
		}
		comps[c.ID] = c
	}
	used := map[string]bool{}
	for _, p := range Catalog() {
		for _, id := range p.Components {
			if _, ok := comps[id]; !ok {
				t.Errorf("%s: unknown component %s", p.ID, id)
			}
			used[id] = true
		}
		for _, u := range p.Unlocks {
			for _, n := range u.Needs {
				if !slices.Contains(p.Components, n) {
					t.Errorf("%s unlock %s needs %s which is not in the pack", p.ID, u.Module, n)
				}
			}
		}
	}
	for id, c := range comps {
		if !used[id] {
			t.Errorf("component %s is in no pack", id)
		}
		for key, sz := range c.Sizes {
			if sz.Download <= 0 || sz.Disk <= 0 {
				t.Errorf("%s/%s: empty size %+v", id, key, sz)
			}
		}
		if len(c.Sizes) == 0 {
			t.Errorf("%s has no sizes", id)
		}
		if c.Kind == core.ComponentDep {
			if _, ok := installerModules[c.DepID]; !ok {
				t.Errorf("dep %s has no installer module", c.DepID)
			}
		}
	}
}

func TestPlatformKey(t *testing.T) {
	for _, c := range []struct{ os, arch, want string }{
		{"windows", "amd64", Windows}, {"windows", "arm64", Windows},
		{"darwin", "arm64", MacARM}, {"darwin", "amd64", MacIntel}, {"linux", "amd64", ""},
	} {
		if got := PlatformKey(c.os, c.arch); got != c.want {
			t.Errorf("%s/%s = %q", c.os, c.arch, got)
		}
	}
}

// ---- status -----------------------------------------------------------------

func TestStatusStates(t *testing.T) {
	f := newFixture(t, win, "amd64")
	if st := f.pack("media").State; st != core.PackMissing {
		t.Fatalf("fresh media = %s", st)
	}
	ff := f.comp("media", "ffmpeg")
	if ff.State != core.ComponentMissing || ff.DownloadBytes != 114_768_076 || ff.DiskBytes != 210_680_000 {
		t.Errorf("ffmpeg %+v", ff)
	}
	if !slices.Equal(ff.Packs, []string{"media", "music"}) {
		t.Errorf("ffmpeg packs %v", ff.Packs)
	}

	f.w.set(deps.FFmpeg, core.DepOK, core.SourceManaged)
	f.s.cfg.Deps.Detect(context.Background())
	if st := f.pack("media").State; st != core.PackPartial {
		t.Errorf("one of three = %s", st)
	}
	if c := f.comp("media", "ffmpeg"); c.State != core.ComponentInstalled || c.DownloadBytes != 0 || c.DiskBytes != 0 {
		t.Errorf("present ffmpeg costs: %+v", c)
	}

	// A copy found on the system counts as present, costs nothing.
	f.w.set(deps.YtDlp, core.DepOK, core.SourcePath)
	f.w.set(deps.Deno, core.DepOK, core.SourceKnownDir)
	f.s.cfg.Deps.Detect(context.Background())
	if c := f.comp("media", "yt-dlp"); c.State != core.ComponentSystem || c.DownloadBytes != 0 {
		t.Errorf("system yt-dlp %+v", c)
	}
	if st := f.pack("media").State; st != core.PackInstalled {
		t.Errorf("media = %s", st)
	}

	// Outdated: still present, but updating downloads again.
	f.w.set(deps.FFmpeg, core.DepOutdated, core.SourceManaged)
	f.s.cfg.Deps.Detect(context.Background())
	if st := f.pack("media").State; st != core.PackOutdated {
		t.Errorf("media = %s", st)
	}
	if c := f.comp("media", "ffmpeg"); c.State != core.ComponentOutdated || c.DownloadBytes == 0 {
		t.Errorf("outdated ffmpeg %+v", c)
	}
}

func TestStatusModelsUnlocksAndSharedEngine(t *testing.T) {
	f := newFixture(t, win, "amd64")
	f.w.set(sidecar.DepID, core.DepOK, core.SourceManaged)
	f.s.cfg.Deps.Detect(context.Background())
	if st := f.pack("documents").State; st != core.PackInstalled {
		t.Errorf("documents (engine only) = %s", st)
	}
	if st := f.pack("speech").State; st != core.PackPartial {
		t.Errorf("speech = %s", st)
	}
	f.w.models["transcribe/small"] = true
	if st := f.pack("speech").State; st != core.PackInstalled {
		t.Errorf("speech = %s", st)
	}
	if got := f.comp("image", "engine").Packs; !slices.Equal(got, []string{"music", "image", "speech", "documents"}) {
		t.Errorf("engine packs %v", got)
	}
	// Only registered tools are listed as unlocked.
	speech := f.pack("speech")
	if len(speech.Unlocks) != 1 || speech.Unlocks[0].ModuleID != "transcribe" || speech.Unlocks[0].Name != "Tool transcribe" {
		t.Errorf("unlocks %+v", speech.Unlocks)
	}
	if len(f.pack("media").Unlocks) != 0 {
		t.Error("unregistered tools listed")
	}
}

func TestStatusUnsupportedPlatform(t *testing.T) {
	f := newFixture(t, mac, "amd64") // Intel Mac: no FFmpeg, Deno or chat engine
	media := f.pack("media")
	if media.State != core.PackUnsupported || media.UnsupportedReason == "" {
		t.Errorf("media on Intel Mac: %+v", media.State)
	}
	if st := f.comp("media", "ffmpeg").State; st != core.ComponentUnsupported {
		t.Errorf("ffmpeg = %s", st)
	}
	if _, err := f.s.Install([]string{"media"}, ""); err == nil {
		t.Error("installing an unsupported pack should fail")
	}
	g := newFixture(t, "linux", "amd64")
	for _, p := range g.s.List() {
		if p.State != core.PackUnsupported {
			t.Errorf("%s on linux = %s", p.ID, p.State)
		}
	}
}

// ---- install job ------------------------------------------------------------

func TestInstallSkipsPresentAndSharesComponents(t *testing.T) {
	f := newFixture(t, win, "amd64")
	f.w.set(deps.FFmpeg, core.DepOK, core.SourceManaged) // already there
	f.s.cfg.Deps.Detect(context.Background())

	p, err := f.runInstall("music")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{sidecar.DepID, "stems/four-fast"}; !slices.Equal(f.w.log, want) {
		t.Fatalf("install order %v, want %v (ffmpeg skipped)", f.w.log, want)
	}
	if p.title != "Install Music pack" {
		t.Errorf("title %q", p.title)
	}
	monotonic(t, p.pcts)
	if last := p.pcts[len(p.pcts)-1]; last != 1 {
		t.Errorf("final progress %v", last)
	}
	if st := f.pack("music").State; st != core.PackInstalled {
		t.Errorf("music = %s", st)
	}

	// The next pack finds the shared engine present: only its own parts install.
	f.w.log = nil
	if _, err := f.runInstall("image"); err != nil {
		t.Fatal(err)
	}
	if want := []string{"bg-remover/balanced", deps.Upscayl, deps.ExifTool}; !slices.Equal(f.w.log, want) {
		t.Errorf("second pack installed %v, want %v", f.w.log, want)
	}

	// Everything present: nothing runs.
	f.w.log = nil
	p, err = f.runInstall("image")
	if err != nil || len(f.w.log) != 0 {
		t.Fatalf("reinstall: %v %v", err, f.w.log)
	}
	if p.pcts[len(p.pcts)-1] != 1 {
		t.Error("no final progress")
	}
}

func TestInstallProgressIsByteWeighted(t *testing.T) {
	f := newFixture(t, win, "amd64")
	p, err := f.runInstall("media")
	if err != nil {
		t.Fatal(err)
	}
	monotonic(t, p.pcts)
	// ffmpeg (114.8 MB of 181.3 MB) completes at about 0.63.
	var sawFFmpegDone bool
	for _, v := range p.pcts {
		if v > 0.62 && v < 0.64 {
			sawFFmpegDone = true
		}
	}
	if !sawFFmpegDone {
		t.Errorf("no progress near the ffmpeg share: %v", p.pcts)
	}
}

func TestInstallOnlyInstallsRequested(t *testing.T) {
	f := newFixture(t, win, "amd64")
	if _, err := f.runInstall("music", "engine"); err != nil {
		t.Fatal(err)
	}
	if want := []string{sidecar.DepID}; !slices.Equal(f.w.log, want) {
		t.Errorf("installed %v", f.w.log)
	}
	mod, _ := f.reg.Get(InstallModuleID)
	if err := mod.Validate(nil, json.RawMessage(`{"pack":"music","only":["deno"]}`)); err == nil {
		t.Error("component outside the pack accepted")
	}
	if err := mod.Validate(nil, json.RawMessage(`{"pack":"nope"}`)); err == nil {
		t.Error("unknown pack accepted")
	}
	if err := mod.Validate([]string{"a"}, json.RawMessage(`{"pack":"media"}`)); err == nil {
		t.Error("inputs accepted")
	}
}

func TestInstallFailureNamesComponentAndKeepsFinished(t *testing.T) {
	f := newFixture(t, win, "amd64")
	f.w.fail[deps.Deno] = core.Errorf(core.CodeToolFailed, "Checksum mismatch").WithHint("Try again")
	_, err := f.runInstall("media")
	ae := core.AsAppError(err)
	if err == nil || ae.Code != core.CodeToolFailed || ae.Message != "Deno: Checksum mismatch" || ae.Hint != "Try again" {
		t.Fatalf("err %+v", ae)
	}
	if st := f.comp("media", "ffmpeg").State; st != core.ComponentInstalled {
		t.Errorf("finished component lost: %s", st)
	}
	if st := f.pack("media").State; st != core.PackPartial {
		t.Errorf("media = %s", st)
	}
}

func TestInstallCancelLeavesFinishedComponents(t *testing.T) {
	f := newFixture(t, win, "amd64")
	ctx, cancel := context.WithCancel(context.Background())
	// Cancel as the second component starts: fail it with a cancelled error.
	f.w.fail[deps.YtDlp] = core.Errorf(core.CodeCancelled, "Cancelled")
	mod, _ := f.reg.Get(InstallModuleID)
	job, _ := f.job(InstallOptions{Pack: "media"})
	err := mod.Run(ctx, job)
	cancel()
	if !core.IsCode(err, core.CodeCancelled) {
		t.Fatalf("err %v", err)
	}
	if core.AsAppError(err).Message != "Cancelled" {
		t.Errorf("cancel message %q", core.AsAppError(err).Message)
	}
	if f.comp("media", "ffmpeg").State != core.ComponentInstalled {
		t.Error("finished component lost on cancel")
	}

	// A context cancelled before a component starts stops before running it.
	f2 := newFixture(t, win, "amd64")
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	mod2, _ := f2.reg.Get(InstallModuleID)
	job2, _ := f2.job(InstallOptions{Pack: "media"})
	if err := mod2.Run(ctx2, job2); !core.IsCode(err, core.CodeCancelled) || len(f2.w.log) != 0 {
		t.Errorf("pre-cancelled: %v %v", err, f2.w.log)
	}
}

func TestInstallMissingInstallerModuleIsGraceful(t *testing.T) {
	f := newFixture(t, win, "amd64")
	f.s.cfg.Reg = core.NewRegistry() // no installers, no providers
	_, err := (&installModule{s: f.s}).runPack(f, "documents")
	if err == nil || core.AsAppError(err).Message != "AI engine: AI engine can't be installed in this build" {
		t.Fatalf("err %v", err)
	}
}

func (m *installModule) runPack(f *fixture, pack string) (*progress, error) {
	job, p := f.job(InstallOptions{Pack: pack})
	return p, m.Run(context.Background(), job)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// ---- remove -----------------------------------------------------------------

func TestRemovePreviewKeepsSharedAndSkipsSystem(t *testing.T) {
	f := newFixture(t, win, "amd64")
	for _, id := range []string{sidecar.DepID, deps.FFmpeg, deps.Upscayl, deps.ExifTool} {
		f.w.set(id, core.DepOK, core.SourceManaged)
	}
	f.w.models["stems/four-fast"] = true
	f.w.models["bg-remover/balanced"] = true
	f.s.cfg.Deps.Detect(context.Background())

	// Music and Image are installed and share the engine; Music also has ffmpeg.
	pv := f.s.RemovePreview("image")
	if len(pv.Kept) != 1 || pv.Kept[0].Component != "AI engine" || !slices.Equal(pv.Kept[0].UsedBy, []string{"Music", "Documents"}) {
		t.Fatalf("kept %+v", pv.Kept)
	}
	want := int64(224_005_088 + 54_247_123 + 34_532_543)
	if pv.FreedBytes != want {
		t.Errorf("freed %d, want %d", pv.FreedBytes, want)
	}

	// System copies are not removed or counted.
	f.w.set(deps.ExifTool, core.DepOK, core.SourcePath)
	f.s.cfg.Deps.Detect(context.Background())
	if pv2 := f.s.RemovePreview("image"); pv2.FreedBytes != want-34_532_543 {
		t.Errorf("freed with system exiftool %d", pv2.FreedBytes)
	}
	if pv := f.s.RemovePreview("nope"); pv.FreedBytes != 0 || pv.Kept == nil {
		t.Errorf("unknown pack preview %+v", pv)
	}
}

func TestRemoveDeletesModelsAndUnsharedDeps(t *testing.T) {
	f := newFixture(t, win, "amd64")
	f.w.set(sidecar.DepID, core.DepOK, core.SourceManaged)
	f.w.models["transcribe/small"] = true
	f.s.cfg.Deps.Detect(context.Background())
	stopped := false
	f.s.cfg.StopEngines = func() { stopped = true }

	// Speech is not installed fully shared: Documents (engine only) keeps the
	// engine, so removing Speech deletes only the model and never stops it.
	if err := f.s.Remove("speech"); err != nil {
		t.Fatal(err)
	}
	if f.w.models["transcribe/small"] || stopped {
		t.Errorf("model survived %v, or engine stopped %v", f.w.models["transcribe/small"], stopped)
	}
	// Removing Documents (the last user) stops the engine and deletes its folders.
	if err := os.MkdirAll(f.paths.SidecarDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Remove("documents"); err != nil {
		t.Fatal(err)
	}
	if !stopped {
		t.Error("engine not stopped before removal")
	}
	if _, err := os.Stat(f.paths.SidecarDir); !os.IsNotExist(err) {
		t.Error("sidecar folder survived")
	}
	if err := f.s.Remove("nope"); !core.IsCode(err, core.CodeNotFound) {
		t.Errorf("unknown pack: %v", err)
	}
}

func TestRemoveKeepsSharedModelsPackComponents(t *testing.T) {
	f := newFixture(t, win, "amd64")
	f.w.set(sidecar.DepID, core.DepOK, core.SourceManaged)
	f.w.models["transcribe/small"] = true
	f.s.cfg.Deps.Detect(context.Background())
	// Documents (engine only) is installed, so removing Speech keeps the engine.
	pv := f.s.RemovePreview("speech")
	if len(pv.Kept) != 1 || pv.Kept[0].UsedBy[0] != "Documents" {
		t.Fatalf("kept %+v", pv.Kept)
	}
	if err := f.s.Remove("speech"); err != nil {
		t.Fatal(err)
	}
	if f.w.models["transcribe/small"] {
		t.Error("model survived")
	}
	if st := f.comp("documents", "engine").State; st != core.ComponentInstalled {
		t.Errorf("shared engine = %s", st)
	}
}

// ---- events -----------------------------------------------------------------

func TestPacksChangedEvents(t *testing.T) {
	f := newFixture(t, win, "amd64")
	f.s.OnEvent(core.EventDepsChanged, nil)
	f.s.OnEvent(core.EventJobsChanged, core.Job{ModuleID: "converter"})
	f.s.OnEvent(core.EventJobsChanged, core.Job{ModuleID: InstallModuleID})
	f.s.OnEvent(core.EventJobsChanged, core.Job{ModuleID: MoveModuleID})
	f.s.OnEvent("other", nil)
	f.mu.Lock()
	n := len(*f.events)
	last := (*f.events)[n-1]
	f.mu.Unlock()
	if n != 3 {
		t.Fatalf("%d events, want 3 (deps, install job, move job)", n)
	}
	if len(last.Packs) != len(Catalog()) {
		t.Errorf("event carries %d packs", len(last.Packs))
	}
	if _, err := f.runInstall("documents"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	after := len(*f.events)
	f.mu.Unlock()
	if after <= n {
		t.Error("no packs:changed after a component finished")
	}
}

func TestNotifyCoalesces(t *testing.T) {
	f := newFixture(t, win, "amd64")
	f.s.notifyDelay = 20 * 1e6 // 20ms
	for range 10 {
		f.s.notify()
	}
	waitFor(t, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(*f.events) >= 1 })
	f.mu.Lock()
	n := len(*f.events)
	f.mu.Unlock()
	if n != 1 {
		t.Errorf("%d events for one burst", n)
	}
}
