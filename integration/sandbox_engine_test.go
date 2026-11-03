//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// Updates the dev sandbox's AI engine (.dev/support) to the embedded sidecar
// project, the way Settings → Update does, so app runs against the sandbox
// (VizLab, Edit Lab's e2e mode) don't stop at "The AI engine needs an update".
// Run: TOOLBOX_UPDATE_SANDBOX_ENGINE=1 go test -tags integration -run TestUpdateSandboxEngine -v -timeout 30m ./integration/
func TestUpdateSandboxEngine(t *testing.T) {
	if os.Getenv("TOOLBOX_UPDATE_SANDBOX_ENGINE") != "1" {
		t.Skip("set TOOLBOX_UPDATE_SANDBOX_ENGINE=1")
	}
	repo, _ := filepath.Abs("..")
	support := filepath.Join(repo, ".dev", "support")
	if _, err := os.Stat(filepath.Join(support, "sidecar")); err != nil {
		t.Skip("no sandbox engine in .dev/support")
	}
	paths := core.NewPaths(support)
	uv := filepath.Join(paths.BinDir, "uv.exe")
	if _, err := os.Stat(uv); err != nil {
		uv = filepath.Join(paths.BinDir, "uv")
	}
	reg := core.NewRegistry()
	if err := sidecar.RegisterSetup(reg, paths, nil, func() (string, error) { return uv, nil }, nil, nil); err != nil {
		t.Fatal(err)
	}
	mod, ok := reg.Get(sidecar.SetupModuleID)
	if !ok {
		t.Fatal("setup module not registered")
	}
	tmp := t.TempDir()
	job := core.NewJobContext(core.JobContext{ID: "sandbox-engine", ModuleID: sidecar.SetupModuleID, Options: json.RawMessage(`{}`), TempDir: tmp, OutputDir: tmp},
		core.JobHooks{
			Progress: func(p float64, msg string) { t.Logf("%.0f%% %s", p*100, msg) },
			Log:      func(_ core.LogStream, line string) { t.Log(line) },
		})
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()
	if err := mod.Run(ctx, job); err != nil {
		t.Fatal(err)
	}
}
