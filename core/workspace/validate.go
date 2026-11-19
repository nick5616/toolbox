package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// MaxNameLen is the longest workspace name (characters).
const MaxNameLen = 40

// Guard lists folders a workspace root may not overlap (inside or containing):
// the global support dir, the tools folder and Personal's library.
type Guard struct{ Protected []string }

func checkName(name string, lf listFile, exceptID string) error {
	n := utf8.RuneCountInString(name)
	if n < 1 || n > MaxNameLen {
		return core.ValidationError("Give the workspace a name of 1 to 40 characters", map[string]string{"name": "1 to 40 characters"})
	}
	if strings.EqualFold(name, "Personal") {
		return core.ValidationError(`"Personal" is taken`, map[string]string{"name": `"Personal" is reserved`})
	}
	for _, e := range lf.Workspaces {
		if e.ID != exceptID && strings.EqualFold(e.Name, name) {
			return core.ValidationError("A workspace with that name already exists", map[string]string{"name": "Already used"})
		}
	}
	return nil
}

// overlaps reports whether a is inside b or b is inside a.
func overlaps(a, b string) bool {
	return a != "" && b != "" && (core.IsWithin(a, b) || core.IsWithin(b, a))
}

func (g Guard) checkRoot(root string, lf listFile, exceptRoot string) error {
	if root == "" || !filepath.IsAbs(root) {
		return core.ValidationError("Pick a folder with a full path", map[string]string{"root": "Must be an absolute folder path"})
	}
	for _, p := range g.Protected {
		if overlaps(root, p) {
			return core.ValidationError("That folder overlaps Toolbox's own data or your library",
				map[string]string{"root": "Overlaps " + filepath.Base(p)}).WithHint("Pick a folder that is separate from Toolbox's data, tools and library folders")
		}
	}
	for _, e := range lf.Workspaces {
		if exceptRoot != "" && sameRoot(e.Root, exceptRoot) {
			continue
		}
		if overlaps(root, e.Root) {
			return core.ValidationError("That folder overlaps the workspace "+e.Name,
				map[string]string{"root": "Overlaps " + e.Name}).WithHint("Workspaces can't be inside each other")
		}
	}
	return nil
}

func normalise(req CreateRequest) (CreateRequest, error) {
	req.Name = strings.TrimSpace(req.Name)
	if req.Kind == "" {
		req.Kind = KindStandard
	}
	if req.Kind != KindStandard && req.Kind != KindDemo {
		return req, core.ValidationError("Pick Standard or Demo", map[string]string{"kind": "Standard or Demo"})
	}
	if req.Root != "" {
		req.Root = filepath.Clean(req.Root)
	}
	if req.Baseline != "" {
		req.Baseline = filepath.Clean(req.Baseline)
	}
	return req, nil
}

// Validate checks a create request without writing anything.
func (s Store) Validate(req CreateRequest, g Guard) error {
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, _ := s.load()
	return validateCreate(req, lf, g)
}

func validateCreate(req CreateRequest, lf listFile, g Guard) error {
	req, err := normalise(req)
	if err != nil {
		return err
	}
	if err := checkName(req.Name, lf, ""); err != nil {
		return err
	}
	if err := g.checkRoot(req.Root, lf, ""); err != nil {
		return err
	}
	if st, err := os.Stat(req.Root); err == nil {
		if !st.IsDir() {
			return core.ValidationError("That path is a file, not a folder", map[string]string{"root": "Not a folder"})
		}
		ents, err := os.ReadDir(req.Root)
		if err != nil {
			return core.ValidationError("That folder can't be read", map[string]string{"root": "Can't be read"})
		}
		if len(ents) > 0 {
			if _, err := os.Stat(filepath.Join(req.Root, SupportFolder)); err == nil {
				return core.ValidationError("That folder is already a workspace", map[string]string{"root": "Already a workspace"}).WithHint("Use Add existing folder")
			}
			return core.ValidationError("That folder isn't empty", map[string]string{"root": "Not empty"}).WithHint("Pick an empty folder, or use Add existing")
		}
	}
	if req.Baseline != "" {
		st, err := os.Stat(req.Baseline)
		if err != nil || !st.IsDir() {
			return core.ValidationError("The starting folder isn't there", map[string]string{"baseline": "Not found"})
		}
		if !filepath.IsAbs(req.Baseline) {
			return core.ValidationError("The starting folder needs a full path", map[string]string{"baseline": "Must be an absolute folder path"})
		}
		if overlaps(req.Baseline, req.Root) {
			return core.ValidationError("The starting folder can't be inside the workspace folder (or the other way round)",
				map[string]string{"baseline": "Overlaps the workspace folder"})
		}
	}
	return nil
}

// Create validates req, writes <root>/{Library,.toolbox/workspace.json} and
// adds the workspace to the list. It does not switch to it.
func (s Store) Create(req CreateRequest, g Guard) (Info, error) {
	if !s.Enabled() {
		return Info{}, core.ValidationError("Workspaces aren't available in a dev sandbox", nil)
	}
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, _ := s.load()
	req, err := normalise(req)
	if err != nil {
		return Info{}, err
	}
	if err := validateCreate(req, lf, g); err != nil {
		return Info{}, err
	}
	info := newInfo(req)
	if err := os.MkdirAll(LibraryDirOf(info.Root), 0o755); err != nil {
		return Info{}, core.Errorf(core.CodeInternal, "Couldn't create the workspace folder").WithCause(err)
	}
	if err := WriteInfo(info); err != nil {
		return Info{}, core.Errorf(core.CodeInternal, "Couldn't create the workspace folder").WithCause(err)
	}
	lf.Workspaces = append(lf.Workspaces, entry{ID: info.ID, Name: info.Name, Kind: info.Kind, Root: info.Root})
	if err := s.save(lf); err != nil {
		return Info{}, core.Errorf(core.CodeInternal, "Couldn't save the workspace list").WithCause(err)
	}
	return info, nil
}

func newInfo(req CreateRequest) Info {
	return Info{
		ID: NewID(), Name: req.Name, Kind: req.Kind, Root: req.Root, Baseline: req.Baseline,
		Present: req.Present, Keep: append([]string{}, DefaultKeep...), Exclude: []string{},
		StripLocation: req.Kind == KindDemo || req.Present, Created: core.NowMillis(),
	}
}

// AddExisting adds a folder that holds .toolbox/workspace.json. A folder that
// is already listed returns its entry.
func (s Store) AddExisting(root string, g Guard) (Info, error) {
	if !s.Enabled() {
		return Info{}, core.ValidationError("Workspaces aren't available in a dev sandbox", nil)
	}
	if root == "" || !filepath.IsAbs(root) {
		return Info{}, core.ValidationError("Pick a folder with a full path", map[string]string{"root": "Must be an absolute folder path"})
	}
	root = filepath.Clean(root)
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, _ := s.load()
	if i, ok := lf.byRoot(root); ok {
		for _, in := range infos(lf, "") {
			if in.ID == lf.Workspaces[i].ID {
				return in, nil
			}
		}
	}
	info, err := ReadInfo(root)
	if err != nil {
		return Info{}, core.ValidationError("That folder isn't a Toolbox workspace", map[string]string{"root": "No workspace found"}).
			WithHint("Pick the folder that contains a .toolbox folder")
	}
	if err := g.checkRoot(root, lf, ""); err != nil {
		return Info{}, err
	}
	if err := checkName(info.Name, lf, ""); err != nil {
		return Info{}, err
	}
	if _, clash := lf.byID(info.ID); clash || info.ID == PersonalID {
		info.ID = NewID() // a copied workspace folder
		if err := WriteInfo(info); err != nil {
			return Info{}, core.Errorf(core.CodeInternal, "Couldn't update the workspace").WithCause(err)
		}
	}
	lf.Workspaces = append(lf.Workspaces, entry{ID: info.ID, Name: info.Name, Kind: info.Kind, Root: info.Root})
	if err := s.save(lf); err != nil {
		return Info{}, core.Errorf(core.CodeInternal, "Couldn't save the workspace list").WithCause(err)
	}
	return info, nil
}
