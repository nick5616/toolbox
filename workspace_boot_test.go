package main

import (
	"path/filepath"
	"strings"
	"testing"

	"toolbox/api"
	"toolbox/core"
	"toolbox/core/workspace"
)

func bootFor(kind workspace.Kind, name string, sandboxed bool, support string) workspace.Boot {
	return workspace.Boot{
		Info:      workspace.Info{ID: "x", Name: name, Kind: kind},
		Paths:     core.NewPaths(support),
		Sandboxed: sandboxed,
	}
}

func TestInstanceIDPerCase(t *testing.T) {
	personal := instanceID(bootFor(workspace.KindPersonal, "Personal", false, `C:\a\Toolbox`))
	demo := instanceID(bootFor(workspace.KindDemo, "Demo", false, `C:\w\demo\.toolbox`))
	if personal != "dev.toolbox.app" || demo != "dev.toolbox.app" {
		t.Errorf("real workspaces share one lock: %q %q", personal, demo)
	}
	s1 := instanceID(bootFor(workspace.KindSandbox, "Dev sandbox", true, `C:\repo\.dev\support`))
	s1b := instanceID(bootFor(workspace.KindSandbox, "Dev sandbox", true, `c:\REPO\.dev\support`))
	s2 := instanceID(bootFor(workspace.KindDemo, "Demo", true, `C:\repo\workspaces\demo\.toolbox`))
	if !strings.HasPrefix(s1, "dev.toolbox.app.") || s1 == personal || s1 == s2 {
		t.Errorf("sandboxed locks: %q %q", s1, s2)
	}
	if runtimeIsWindows() && s1 != s1b {
		t.Errorf("case-insensitive support dir should give one lock: %q %q", s1, s1b)
	}
}

func runtimeIsWindows() bool { return filepath.Separator == '\\' }

func TestSwitchRequest(t *testing.T) {
	global := t.TempDir()
	st := workspace.Store{Dir: global}
	root := filepath.Join(t.TempDir(), "Demo")
	demo, err := st.Create(workspace.CreateRequest{Name: "Demo", Root: root, Kind: workspace.KindDemo}, workspace.Guard{})
	if err != nil {
		t.Fatal(err)
	}
	svc := &api.WorkspacesService{Boot: workspace.Boot{
		Info:  workspace.Info{ID: workspace.PersonalID, Name: "Personal", Kind: workspace.KindPersonal, Current: true},
		Paths: core.NewPaths(global), GlobalDir: global,
	}}
	if _, ok := switchRequest(svc, []string{"a.png"}); ok {
		t.Error("no --workspace, no request")
	}
	if _, ok := switchRequest(svc, []string{"--workspace", workspace.PersonalID}); ok {
		t.Error("the open workspace needs no request")
	}
	req, ok := switchRequest(svc, []string{"--workspace", root})
	if !ok || req.ID != demo.ID || req.Name != "Demo" || req.Root != demo.Root {
		t.Errorf("known root: %+v %v", req, ok)
	}
	req, ok = switchRequest(svc, []string{"--workspace=" + demo.ID})
	if !ok || req.Name != "Demo" {
		t.Errorf("by id: %+v %v", req, ok)
	}
	req, ok = switchRequest(svc, []string{"--workspace", filepath.Join(t.TempDir(), "Unknown")})
	if !ok || req.ID != "" || req.Root == "" {
		t.Errorf("unknown root: %+v %v", req, ok)
	}
}

func TestWindowTitleAndTooltip(t *testing.T) {
	if got := windowTitle(bootFor(workspace.KindPersonal, "Personal", false, "x")); got != "Toolbox" {
		t.Errorf("personal title = %q", got)
	}
	if got := windowTitle(bootFor(workspace.KindDemo, "Demo", false, "x")); got != "Toolbox — Demo" {
		t.Errorf("demo title = %q", got)
	}
	if tooltipWorkspace(bootFor(workspace.KindPersonal, "Personal", false, "x")) != "" || tooltipWorkspace(bootFor(workspace.KindDemo, "Demo", false, "x")) != "Demo" {
		t.Error("tooltip suffix")
	}
}

func TestWebviewDirAndDevtools(t *testing.T) {
	sup := filepath.Join(t.TempDir(), ".toolbox")
	if got := webviewDir(bootFor(workspace.KindPersonal, "Personal", false, sup)); got != "" {
		t.Errorf("personal webview dir = %q", got)
	}
	for _, k := range []workspace.Kind{workspace.KindDemo, workspace.KindStandard, workspace.KindSandbox} {
		if got := webviewDir(bootFor(k, "W", false, sup)); got != filepath.Join(sup, "webview2") {
			t.Errorf("%s webview dir = %q", k, got)
		}
	}
	t.Setenv("TOOLBOX_DEVTOOLS_PORT", "9222")
	if len(devtoolsArgs(true)) == 0 {
		t.Error("devtools off when sandboxed")
	}
	if devtoolsArgs(false) != nil {
		t.Error("devtools on in a real workspace")
	}
	t.Setenv("TOOLBOX_DEVTOOLS_PORT", "80")
	if devtoolsArgs(true) != nil {
		t.Error("privileged port accepted")
	}
}

func TestDemoAlias(t *testing.T) {
	if demoAlias(bootFor(workspace.KindDemo, "Demo", false, "x")) != "Toolbox Demo" {
		t.Error("demo alias")
	}
	if demoAlias(bootFor(workspace.KindStandard, "S", false, "x")) != "" || demoAlias(bootFor(workspace.KindPersonal, "P", false, "x")) != "" {
		t.Error("alias set for non-demo")
	}
}
