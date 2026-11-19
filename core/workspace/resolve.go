package workspace

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// Resolve picks the workspace to open (SPEC §A3). The first rule that applies
// wins:
//  1. TOOLBOX_SUPPORT_DIR: the legacy dev sandbox, unchanged;
//  2. TOOLBOX_WORKSPACE: that folder, created if missing (sandboxed);
//  3. --workspace <root|id> (an unknown root is added to the list);
//  4. workspaces.json "active";
//  5. Personal.
//
// Sandboxed runs (1, 2) never write the global support dir.
func Resolve(args []string) (Boot, error) {
	gp, err := core.ResolvePaths() // Personal's paths: the sandbox dir under rule 1, else the global dir
	if err != nil {
		return Boot{}, err
	}
	if os.Getenv(core.EnvSupportDir) != "" {
		info := Info{ID: "sandbox", Name: "Dev sandbox", Kind: KindSandbox, Root: gp.SupportDir, Keep: []string{}, Exclude: []string{}, Current: true}
		return Boot{Info: info, Paths: gp, Sandboxed: true}, nil
	}
	if root := os.Getenv(EnvWorkspace); root != "" {
		return resolveEnv(root, gp)
	}

	st := Store{Dir: gp.SupportDir}
	_, notice := st.List("") // handles a corrupt list (kept as .bak)
	guard := GuardFor(gp, "")

	target, found, n := st.pick(argValue(args), guard)
	if n != "" {
		notice = joinNotice(notice, n)
	}
	if found {
		info, err := ReadInfo(target.Root)
		if err != nil {
			notice = joinNotice(notice, fmt.Sprintf("%s's folder isn't there", target.Name))
			slog.Warn("workspace missing, opening Personal", "workspace", target.Name, "root", target.Root, "err", err)
		} else {
			info.ID = target.ID
			info.Current = true
			b := Boot{
				Info:       info,
				Paths:      pathsFor(info.Root, gp),
				GlobalDir:  gp.SupportDir,
				LibraryDir: LibraryDirOf(info.Root),
				Notice:     notice,
			}
			b.SeedPending = seedPending(info)
			st.NoteUsed(info.ID)
			return b, nil
		}
	}
	st.NoteUsed(PersonalID)
	return Boot{Info: personalInfo(PersonalID), Paths: gp, GlobalDir: gp.SupportDir, Notice: notice}, nil
}

// GuardFor lists the folders a workspace may not overlap: the global support
// dir, the tools folder and Personal's library. personalLib overrides the
// default library (Personal's setting) when known.
func GuardFor(p core.Paths, personalLib string) Guard {
	if personalLib == "" {
		if d, err := core.DefaultLibraryDir(); err == nil {
			personalLib = d
		}
	}
	g := Guard{}
	for _, d := range []string{p.SupportDir, p.ToolsDir, personalLib} {
		if d != "" {
			g.Protected = append(g.Protected, filepath.Clean(d))
		}
	}
	return g
}

func pathsFor(root string, global core.Paths) core.Paths {
	p := core.NewPathsWithTools(SupportDirOf(root), global.ToolsDir)
	p.ToolsDirFromEnv = global.ToolsDirFromEnv
	return p
}

func seedPending(info Info) bool {
	if info.Baseline == "" {
		return false
	}
	_, ok, err := ReadManifest(info.Root)
	return err == nil && !ok
}

func joinNotice(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	return a + " " + b
}

// argValue returns the value of --workspace (or --workspace=…), "" if none.
func argValue(args []string) string {
	for i, a := range args {
		if a == ArgWorkspace && i+1 < len(args) {
			return args[i+1]
		}
		if v, ok := strings.CutPrefix(a, ArgWorkspace+"="); ok {
			return v
		}
	}
	return ""
}

// WithArg returns args with --workspace set to value (replacing any earlier
// one). value "" removes it.
func WithArg(args []string, value string) []string {
	out := make([]string, 0, len(args)+2)
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == ArgWorkspace {
			i++ // skip its value
			continue
		}
		if strings.HasPrefix(a, ArgWorkspace+"=") {
			continue
		}
		out = append(out, a)
	}
	if value != "" {
		out = append(out, ArgWorkspace, value)
	}
	return out
}

// ArgValue is argValue for other packages (the second-instance handler).
func ArgValue(args []string) string { return argValue(args) }

// pick finds the workspace to open: the --workspace argument (an ID or a
// root; an unknown root is added), else the list's "active". found is false
// for Personal.
func (s Store) pick(arg string, g Guard) (info Info, found bool, notice string) {
	if arg != "" && arg != PersonalID && !strings.EqualFold(arg, "personal") {
		if filepath.IsAbs(arg) || strings.ContainsAny(arg, `/\`) {
			abs, err := filepath.Abs(arg)
			if err != nil {
				return Info{}, false, "Couldn't open that workspace"
			}
			added, err := s.AddExisting(abs, g)
			if err != nil {
				return Info{}, false, "Couldn't open the workspace: " + userMessage(err)
			}
			return added, true, ""
		}
		if in, ok := s.Find(arg); ok {
			return in, true, ""
		}
		return Info{}, false, "There is no workspace " + arg
	}
	if arg != "" {
		return Info{}, false, ""
	}
	storeMu.Lock()
	lf, _ := s.load()
	storeMu.Unlock()
	if lf.Active != "" && lf.Active != PersonalID {
		if in, ok := s.Find(lf.Active); ok {
			return in, true, ""
		}
	}
	return Info{}, false, ""
}

func userMessage(err error) string {
	if ae := core.AsAppError(err); ae != nil && ae.Message != "" {
		return ae.Message
	}
	return err.Error()
}

// resolveEnv opens $TOOLBOX_WORKSPACE (sandboxed, nothing written to the
// global support dir).
func resolveEnv(root string, gp core.Paths) (Boot, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return Boot{}, fmt.Errorf("resolve %s: %w", EnvWorkspace, err)
	}
	if err := os.MkdirAll(LibraryDirOf(abs), 0o755); err != nil {
		return Boot{}, fmt.Errorf("create workspace folder: %w", err)
	}
	info, err := ReadInfo(abs)
	if err != nil {
		kind := Kind(os.Getenv(EnvWorkspaceKind))
		switch kind {
		case KindStandard, KindDemo, KindSandbox:
		default:
			kind = KindSandbox
		}
		name := strings.TrimSpace(os.Getenv(EnvWorkspaceName))
		if name == "" {
			name = filepath.Base(abs)
		}
		info = Info{
			ID: NewID(), Name: name, Kind: kind, Root: abs, Baseline: os.Getenv(EnvWorkspaceBaseline),
			Present: kind == KindDemo, Keep: append([]string{}, DefaultKeep...), Exclude: []string{},
			StripLocation: kind == KindDemo, Created: core.NowMillis(),
		}
		if err := WriteInfo(info); err != nil {
			return Boot{}, fmt.Errorf("write workspace.json: %w", err)
		}
	}
	info.Current = true
	return Boot{
		Info: info, Paths: pathsFor(abs, gp), LibraryDir: LibraryDirOf(abs),
		Sandboxed: true, SeedPending: seedPending(info),
	}, nil
}
