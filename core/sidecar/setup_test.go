package sidecar

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"toolbox/core"
	sidecarfiles "toolbox/sidecar"
)

type setupFixture struct {
	p        core.Paths
	reg      *core.Registry
	mod      core.Module
	uv       string
	mu       sync.Mutex
	pcts     []float64
	msgs     []string
	logs     []string
	detected int
	installs int
}

func exeName(n string) string {
	if runtime.GOOS == "windows" {
		return n + ".exe"
	}
	return n
}

// copySelf copies the test binary to dst (the fake uv / python).
func copySelf(t *testing.T, dst string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, b, 0o755); err != nil {
		t.Fatal(err)
	}
}

func newSetupFixture(t *testing.T, haveUV bool) *setupFixture {
	t.Helper()
	f := &setupFixture{p: core.NewPaths(t.TempDir()), reg: core.NewRegistry()}
	f.uv = filepath.Join(f.p.BinDir, exeName("uv"))
	if haveUV {
		copySelf(t, f.uv)
	}
	resolve := func() (string, error) {
		if isFile(f.uv) {
			return f.uv, nil
		}
		return "", core.ErrDependencyMissing("uv", "")
	}
	install := func(ctx context.Context, job *core.JobContext) error {
		f.installs++
		job.Progress(0.5, "Downloading uv")
		job.Progress(1, "Installed uv")
		copySelf(t, f.uv)
		return nil
	}
	detect := func(context.Context) { f.detected++ }
	if err := RegisterSetup(f.reg, f.p, nil, resolve, install, detect); err != nil {
		t.Fatal(err)
	}
	f.mod, _ = f.reg.Get(SetupModuleID)
	return f
}

func (f *setupFixture) job(t *testing.T) *core.JobContext {
	return core.NewJobContext(core.JobContext{ID: "j", ModuleID: SetupModuleID, TempDir: t.TempDir()}, core.JobHooks{
		Progress: func(p float64, m string) {
			f.mu.Lock()
			f.pcts = append(f.pcts, p)
			f.msgs = append(f.msgs, m)
			f.mu.Unlock()
		},
		Log: func(_ core.LogStream, l string) {
			f.mu.Lock()
			f.logs = append(f.logs, l)
			f.mu.Unlock()
		},
	})
}

func TestSetupDescriptor(t *testing.T) {
	f := newSetupFixture(t, true)
	d := f.mod.Descriptor()
	if d.ID != SetupModuleID || !d.Hidden || d.MaxConcurrent != 1 {
		t.Errorf("%+v", d)
	}
	if err := f.mod.Validate(nil, nil); err != nil {
		t.Error(err)
	}
	if err := f.mod.Validate([]string{"x"}, nil); err == nil {
		t.Error("inputs should be rejected")
	}
}

func TestSetupSuccess(t *testing.T) {
	f := newSetupFixture(t, true)
	// Stale files from an older engine must go; .venv must stay.
	stale := filepath.Join(f.p.SidecarDir, "toolbox_sidecar", "old_module.py")
	os.MkdirAll(filepath.Dir(stale), 0o755)
	os.WriteFile(stale, []byte("x"), 0o644)
	keep := filepath.Join(f.p.SidecarDir, ".venv", "keep.txt")
	os.MkdirAll(filepath.Dir(keep), 0o755)
	os.WriteFile(keep, []byte("x"), 0o644)

	if st := Detect(context.Background(), f.p); st.State != core.DepMissing {
		t.Fatalf("before: %+v", st)
	}
	if err := f.mod.Run(context.Background(), f.job(t)); err != nil {
		t.Fatal(err)
	}
	if f.installs != 0 {
		t.Error("installed uv although it was present")
	}
	if _, err := os.Stat(stale); err == nil {
		t.Error("stale file survived")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Error(".venv content removed")
	}
	for _, name := range sidecarfiles.Files() {
		if !isFile(filepath.Join(f.p.SidecarDir, filepath.FromSlash(name))) {
			t.Errorf("missing %s", name)
		}
	}
	h, _ := os.ReadFile(filepath.Join(f.p.SidecarDir, ".toolbox-hash"))
	if strings.TrimSpace(string(h)) != sidecarfiles.Hash() {
		t.Errorf("hash %q", h)
	}
	v, _ := os.ReadFile(filepath.Join(f.p.SidecarDir, ".toolbox-version"))
	if strings.TrimSpace(string(v)) != "toolbox-sidecar 0.2.0 · py 3.12.16 · torch 2.14.1" {
		t.Errorf("version %q", v)
	}
	if f.detected != 1 {
		t.Errorf("detected=%d", f.detected)
	}
	if !isFile(filepath.Join(f.p.CacheDir, "uv", "cleaned")) {
		t.Error("uv cache clean not run")
	}
	rec, _ := os.ReadFile(filepath.Join(f.p.SidecarDir, "uv-sync-record.txt"))
	for _, want := range []string{
		"cwd=" + f.p.SidecarDir, "cache=" + filepath.Join(f.p.CacheDir, "uv"), "pyinstall=" + f.p.PythonDir,
		"pref=only-managed", "link=copy", "noprogress=1", "args=sync --frozen --no-dev --python 3.12",
	} {
		if !strings.Contains(string(rec), want) {
			t.Errorf("sync record lacks %q:\n%s", want, rec)
		}
	}
	if f.msgs[len(f.msgs)-1] != "Audio engine ready" || f.pcts[len(f.pcts)-1] != 1 {
		t.Errorf("final: %q %v", f.msgs[len(f.msgs)-1], f.pcts[len(f.pcts)-1])
	}
	var sawUVLine, sawCheck bool
	for _, m := range f.msgs {
		sawUVLine = sawUVLine || m == "Installed 68 packages in 1ms"
		sawCheck = sawCheck || m == "Checking the audio engine"
	}
	if !sawUVLine || !sawCheck {
		t.Errorf("messages: %v", f.msgs)
	}
	if len(f.logs) == 0 {
		t.Error("no log lines")
	}
	st := Detect(context.Background(), f.p)
	if st.State != core.DepOK || st.Version != "toolbox-sidecar 0.2.0 · py 3.12.16 · torch 2.14.1" {
		t.Errorf("after: %+v", st)
	}
}

func TestSetupInstallsUVWhenMissing(t *testing.T) {
	f := newSetupFixture(t, false)
	if err := f.mod.Run(context.Background(), f.job(t)); err != nil {
		t.Fatal(err)
	}
	if f.installs != 1 {
		t.Errorf("installs=%d", f.installs)
	}
	// uv install progress is mapped into 0..10%.
	for i, m := range f.msgs {
		if m == "Downloading uv" && (f.pcts[i] <= 0 || f.pcts[i] > 0.10) {
			t.Errorf("scaled progress %v", f.pcts[i])
		}
	}
}

func TestSetupSyncFailure(t *testing.T) {
	t.Setenv("FAKE_UV_FAIL", "1")
	f := newSetupFixture(t, true)
	err := f.mod.Run(context.Background(), f.job(t))
	ae := core.AsAppError(err)
	if err == nil || ae.Code != core.CodeToolFailed || ae.Message != "Failed to download `torch`" ||
		ae.Hint != "Check your connection and retry; see the job log for details" {
		t.Fatalf("err=%v", err)
	}
	if isFile(filepath.Join(f.p.SidecarDir, ".toolbox-hash")) {
		t.Error("hash written despite failure")
	}
	if f.detected != 0 {
		t.Error("detect ran despite failure")
	}
}

func TestSetupSelftestFailure(t *testing.T) {
	t.Setenv("FAKE_SELFTEST_FAIL", "1")
	f := newSetupFixture(t, true)
	err := f.mod.Run(context.Background(), f.job(t))
	if !core.IsCode(err, core.CodeToolFailed) {
		t.Fatalf("err=%v", err)
	}
	if isFile(filepath.Join(f.p.SidecarDir, ".toolbox-hash")) {
		t.Error("hash written despite failure")
	}
}

func TestSetupCancel(t *testing.T) {
	f := newSetupFixture(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := f.mod.Run(ctx, f.job(t))
	if !core.IsCode(err, core.CodeCancelled) {
		t.Fatalf("err=%v", err)
	}
}

func TestSetupStopsManager(t *testing.T) {
	f := newSetupFixture(t, true)
	m := newTestManager(t, "")
	must(t, m, "ping", nil)
	reg := core.NewRegistry()
	resolve := func() (string, error) { return f.uv, nil }
	if err := RegisterSetup(reg, f.p, m, resolve, nil, nil); err != nil {
		t.Fatal(err)
	}
	mod, _ := reg.Get(SetupModuleID)
	if err := mod.Run(context.Background(), f.job(t)); err != nil {
		t.Fatal(err)
	}
	if m.Status().Running {
		t.Error("manager still running during setup")
	}
}

func TestDetectStates(t *testing.T) {
	p := core.NewPaths(t.TempDir())
	ctx := context.Background()
	st := Detect(ctx, p)
	if st.ID != DepID || st.Name != "Audio engine" || st.State != core.DepMissing || !st.Managed ||
		st.InstallHint != "Install from Settings → Dependencies" || st.Source != core.SourceNone {
		t.Errorf("missing: %+v", st)
	}

	py := PythonPath(p)
	os.MkdirAll(filepath.Dir(py), 0o755)
	os.WriteFile(py, []byte("x"), 0o755)
	os.WriteFile(filepath.Join(p.SidecarDir, ".toolbox-version"), []byte("toolbox-sidecar 0.1.0 · py 3.12.1 · torch 1\n"), 0o644)
	st = Detect(ctx, p)
	if st.State != core.DepOutdated || st.Path != py || st.Source != core.SourceManaged {
		t.Errorf("no hash: %+v", st)
	}
	os.WriteFile(filepath.Join(p.SidecarDir, ".toolbox-hash"), []byte("deadbeef"), 0o644)
	if st = Detect(ctx, p); st.State != core.DepOutdated {
		t.Errorf("wrong hash: %+v", st)
	}
	os.WriteFile(filepath.Join(p.SidecarDir, ".toolbox-hash"), []byte(sidecarfiles.Hash()+"\n"), 0o644)
	st = Detect(ctx, p)
	if st.State != core.DepOK || st.Version != "toolbox-sidecar 0.1.0 · py 3.12.1 · torch 1" || st.Path != py {
		t.Errorf("ok: %+v", st)
	}
	b, _ := json.Marshal(st)
	if len(b) == 0 {
		t.Error("marshal")
	}
}

func TestRemoveModelsUsageClear(t *testing.T) {
	p := core.NewPaths(t.TempDir())
	if n, err := ModelsUsage(p); err != nil || n != 0 {
		t.Fatalf("empty usage %d %v", n, err)
	}
	if err := ClearModels(p); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(p.ModelsDir, "audio-separator"), 0o755)
	os.WriteFile(filepath.Join(p.ModelsDir, "audio-separator", "a.bin"), make([]byte, 1000), 0o644)
	os.WriteFile(filepath.Join(p.ModelsDir, "b.bin"), make([]byte, 234), 0o644)
	if n, err := ModelsUsage(p); err != nil || n != 1234 {
		t.Fatalf("usage %d %v", n, err)
	}
	if err := ClearModels(p); err != nil {
		t.Fatal(err)
	}
	if n, _ := ModelsUsage(p); n != 0 {
		t.Errorf("usage after clear %d", n)
	}
	if fi, err := os.Stat(p.ModelsDir); err != nil || !fi.IsDir() {
		t.Error("models dir should remain")
	}

	os.MkdirAll(p.SidecarDir, 0o755)
	os.MkdirAll(p.PythonDir, 0o755)
	os.WriteFile(filepath.Join(p.PythonDir, "x"), []byte("x"), 0o644)
	m := newTestManager(t, "")
	must(t, m, "ping", nil)
	if err := Remove(p, m); err != nil {
		t.Fatal(err)
	}
	if m.Status().Running {
		t.Error("manager still running")
	}
	for _, d := range []string{p.SidecarDir, p.PythonDir} {
		if _, err := os.Stat(d); err == nil {
			t.Errorf("%s remains", d)
		}
	}
	if err := Remove(p, nil); err != nil {
		t.Errorf("second remove: %v", err)
	}
}
