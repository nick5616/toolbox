package focus

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/focus"
)

// The app catalog (SPEC.md §4.3, §1.7): installed programs from the Start
// menu / Applications, the rule each one suggests, and what is running now.

const appsCacheTTL = 10 * time.Minute

var (
	reAppVersion = regexp.MustCompile(`(?i)^app-\d[\w.\-]*$`)
	reVersion    = regexp.MustCompile(`^\d+(\.\d+)+$`)
)

// SuggestRule guesses the allow rule for a program: a folder rule at its
// install root, or an exe rule when the root would be too broad.
func SuggestRule(exePath string) focus.AllowRule {
	return suggestRule(exePath, focus.BroadFolder)
}

// suggestRule is SuggestRule with the broad-folder check injected.
func suggestRule(exePath string, broad func(string) bool) focus.AllowRule {
	if strings.HasPrefix(exePath, "/") {
		return suggestRuleUnix(exePath, broad)
	}
	return suggestRuleWin(exePath, broad)
}

func exeRule(path, label string) focus.AllowRule {
	return focus.AllowRule{ID: core.NewID(), Label: clampLabel(label), Kind: focus.RuleExe, Path: path, Children: true}
}

func folderRule(path, label string) focus.AllowRule {
	return focus.AllowRule{ID: core.NewID(), Label: clampLabel(label), Kind: focus.RuleFolder, Path: path, Children: true}
}

func clampLabel(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > focus.MaxRuleLabel {
		s = string(r[:focus.MaxRuleLabel])
	}
	return s
}

func suggestRuleWin(exePath string, broad func(string) bool) focus.AllowRule {
	p := strings.ReplaceAll(exePath, "/", `\`)
	segs := strings.Split(p, `\`)
	exeName := segs[len(segs)-1]
	exeLabel := strings.TrimSuffix(exeName, filepath.Ext(exeName))
	fallback := exeRule(p, exeLabel)
	if len(segs) < 3 {
		return fallback
	}
	// WindowsApps\<Name>_<version>_<arch>__<publisher>\app.exe
	for i := 0; i+2 < len(segs); i++ {
		if strings.EqualFold(segs[i], "WindowsApps") {
			if name, _, ok := strings.Cut(segs[i+1], "_"); ok && name != "" {
				return folderRule(strings.Join(segs[:i+1], `\`)+`\`+name+`_*`, name)
			}
			return fallback
		}
	}
	root := segs[:len(segs)-1]
	last := root[len(root)-1]
	if len(root) > 1 && (reAppVersion.MatchString(last) || reVersion.MatchString(last) ||
		strings.EqualFold(last, "bin") || strings.EqualFold(last, "Program") || strings.EqualFold(last, "current")) {
		root = root[:len(root)-1]
	}
	if len(root) < 2 {
		return fallback
	}
	rootPath := strings.Join(root, `\`)
	if broad != nil && broad(rootPath) {
		return fallback
	}
	return folderRule(rootPath, root[len(root)-1])
}

func suggestRuleUnix(path string, broad func(string) bool) focus.AllowRule {
	if b := bundleOf(path); b != "" {
		if broad == nil || !broad(b) {
			return folderRule(b, strings.TrimSuffix(filepath.Base(b), ".app"))
		}
	}
	return exeRule(path, filepath.Base(path))
}

// bundleOf returns the outermost .app folder containing path ("" if none).
func bundleOf(path string) string {
	i := strings.Index(path, ".app/")
	if i < 0 {
		if strings.HasSuffix(path, ".app") {
			return path
		}
		return ""
	}
	return path[:i+4]
}

func isStorePath(path string) bool {
	return strings.Contains(strings.ToLower(strings.ReplaceAll(path, "/", `\`)), `\windowsapps\`)
}

func appFromExe(label, exe string) App {
	r := suggestRule(exe, focus.BroadFolder)
	if label != "" {
		r.Label = clampLabel(label)
	}
	path := exe
	if b := bundleOf(exe); b != "" {
		path = b
	}
	return App{Label: r.Label, Path: path, Rule: r, Store: isStorePath(exe)}
}

// ---- installed apps ------------------------------------------------------

// Apps lists installed programs (Start menu / Applications), cached 10 min.
func (s *Service) Apps() ([]App, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.apps != nil && s.clock().Sub(s.appsAt) < appsCacheTTL {
		return cloneApps(s.apps), nil
	}
	scan := s.scan
	if scan == nil {
		scan = scanApps
	}
	apps := scan()
	if apps == nil {
		apps = []App{}
	}
	s.apps, s.appsAt = apps, s.clock()
	return cloneApps(apps), nil
}

func cloneApps(a []App) []App { return append([]App{}, a...) }

// scanApps reads this OS's catalog.
func scanApps() []App {
	switch runtime.GOOS {
	case "windows":
		var dirs []string
		for _, base := range []string{os.Getenv("ProgramData"), os.Getenv("APPDATA")} {
			if base != "" {
				dirs = append(dirs, filepath.Join(base, "Microsoft", "Windows", "Start Menu", "Programs"))
			}
		}
		return scanStartMenu(dirs)
	case "darwin":
		dirs := []string{"/Applications", "/System/Applications"}
		if home, err := os.UserHomeDir(); err == nil {
			dirs = append(dirs, filepath.Join(home, "Applications"))
		}
		return scanBundles(dirs)
	}
	return []App{}
}

// scanStartMenu resolves every .lnk under dirs (recursively). Targets that
// aren't existing .exe files, and uninstallers, are dropped; apps with the
// same target are listed once.
func scanStartMenu(dirs []string) []App {
	apps := []App{}
	seen := map[string]bool{}
	for _, dir := range dirs {
		_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".lnk") {
				return nil
			}
			target, err := readLnk(p)
			if err != nil || !strings.EqualFold(filepath.Ext(target), ".exe") {
				return nil
			}
			if st, err := os.Stat(target); err != nil || st.IsDir() {
				return nil
			}
			label := strings.TrimSuffix(d.Name(), filepath.Ext(d.Name()))
			if isUninstaller(label, target) {
				return nil
			}
			key := strings.ToLower(filepath.Clean(target))
			if seen[key] {
				return nil
			}
			seen[key] = true
			apps = append(apps, appFromExe(label, target))
			return nil
		})
	}
	sortApps(apps)
	return apps
}

func isUninstaller(label, target string) bool {
	l := strings.ToLower(label)
	b := strings.ToLower(filepath.Base(target))
	return strings.HasPrefix(l, "uninstall") || strings.HasPrefix(b, "unins") || strings.HasPrefix(b, "uninstall")
}

// scanBundles lists the .app bundles in dirs (top level and one folder down).
func scanBundles(dirs []string) []App {
	apps := []App{}
	seen := map[string]bool{}
	add := func(p string) {
		if seen[p] {
			return
		}
		seen[p] = true
		apps = append(apps, appFromExe(strings.TrimSuffix(filepath.Base(p), ".app"), p))
	}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			if strings.HasSuffix(e.Name(), ".app") {
				add(p)
				continue
			}
			if !e.IsDir() {
				continue
			}
			sub, err := os.ReadDir(p)
			if err != nil {
				continue
			}
			for _, se := range sub {
				if strings.HasSuffix(se.Name(), ".app") {
					add(filepath.Join(p, se.Name()))
				}
			}
		}
	}
	sortApps(apps)
	return apps
}

func sortApps(a []App) {
	sort.SliceStable(a, func(i, j int) bool {
		li, lj := strings.ToLower(a[i].Label), strings.ToLower(a[j].Label)
		if li != lj {
			return li < lj
		}
		return a[i].Path < a[j].Path
	})
}

// ---- running apps --------------------------------------------------------

// Running lists programs with a window that are running now: the user's own
// session, never the OS folder or Toolbox, de-duplicated by path.
func (s *Service) Running() ([]App, error) {
	plat := s.plat()
	if err := plat.Supported(); err != nil {
		return []App{}, nil
	}
	procs, err := plat.Snapshot(context.Background())
	if err != nil {
		return []App{}, core.Errorf(core.CodeInternal, "Couldn't list running programs").WithCause(err)
	}
	return runningApps(plat, procs), nil
}

func runningApps(plat focus.Platform, procs []focus.ProcInfo) []App {
	self := plat.Self().PID
	session := plat.InteractiveSession()
	windows := plat.Windows()
	byPID := make(map[uint32]focus.ProcInfo, len(procs))
	for _, p := range procs {
		byPID[p.PID] = p
	}
	isToolbox := func(p focus.ProcInfo) bool {
		for i := 0; i < 64; i++ {
			if p.PID == self {
				return true
			}
			par, ok := byPID[p.ParentPID]
			if !ok || p.ParentPID == p.PID || par.Created > p.Created {
				return false
			}
			p = par
		}
		return false
	}
	var cand []focus.ProcInfo
	for _, p := range procs {
		if p.Session != session || !windows[p.PID] || isToolbox(p) {
			continue
		}
		cand = append(cand, p)
	}
	plat.Paths(cand)
	root := strings.ToLower(strings.TrimRight(plat.SystemRoot(), `\/`))
	apps := []App{}
	seen := map[string]bool{}
	for _, p := range cand {
		if p.Path == "" || underRoot(p.Path, root) {
			continue
		}
		app := appFromExe("", p.Path)
		key := strings.ToLower(app.Path)
		if seen[key] {
			continue
		}
		seen[key] = true
		if !strings.HasPrefix(p.Path, "/") {
			// Windows: the exe name is a better label than the folder.
			app.Label = clampLabel(strings.TrimSuffix(p.Name, filepath.Ext(p.Name)))
			if app.Label == "" {
				app.Label = clampLabel(strings.TrimSuffix(filepath.Base(p.Path), ".exe"))
			}
			app.Rule.Label = app.Label
		}
		apps = append(apps, app)
	}
	sortApps(apps)
	return apps
}

func underRoot(path, lowerRoot string) bool {
	if lowerRoot == "" {
		return false
	}
	p := strings.ToLower(strings.TrimPrefix(path, `\\?\`))
	return p == lowerRoot || strings.HasPrefix(p, lowerRoot+`\`) || strings.HasPrefix(p, lowerRoot+"/")
}

// ---- browsing -------------------------------------------------------------

// AppFor turns a browsed path into an App with its suggested rule.
func (s *Service) AppFor(path string) (App, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return App{}, core.ValidationError("Pick a program", nil)
	}
	if strings.EqualFold(filepath.Ext(path), ".lnk") {
		t, err := readLnk(path)
		if err != nil {
			return App{}, core.ValidationError("That shortcut couldn't be read", nil).WithCause(err)
		}
		path = t
	}
	st, err := os.Stat(path)
	if err != nil {
		return App{}, core.Errorf(core.CodeNotFound, "That program isn't there").WithCause(err)
	}
	if runtime.GOOS == "darwin" {
		if bundleOf(path) == "" {
			return App{}, core.ValidationError("Pick an application", nil).WithHint("Choose a .app from Applications")
		}
	} else if st.IsDir() || !strings.EqualFold(filepath.Ext(path), ".exe") {
		return App{}, core.ValidationError("Pick a program", nil).WithHint("Choose an .exe file")
	}
	label := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if b := bundleOf(path); b != "" {
		label = strings.TrimSuffix(filepath.Base(b), ".app")
	}
	return appFromExe(label, path), nil
}

// ---- first open -------------------------------------------------------------

// studioPicks are the apps the first-open "Studio" profile preselects when
// they are installed (SPEC.md §4.3), matched on the app's label.
var studioPicks = []string{"discord", "claude", "visual studio code", "windows terminal", "ableton live"}

// StudioSuggestion is the "Studio" profile made from the detected apps
// (installed first, then running ones such as Store apps). Rules is empty
// when none were found. It isn't saved.
func (s *Service) StudioSuggestion() (focus.Profile, error) {
	apps, err := s.Apps()
	if err != nil {
		return focus.Profile{}, err
	}
	running, _ := s.Running()
	return studioProfile(append(apps, running...)), nil
}

func studioProfile(apps []App) focus.Profile {
	p := focus.Profile{Name: "Studio", Rules: []focus.AllowRule{}}
	for _, want := range studioPicks {
		for _, a := range apps {
			if strings.Contains(strings.ToLower(a.Label), want) {
				p.Rules = append(p.Rules, a.Rule)
				break
			}
		}
	}
	return p
}
