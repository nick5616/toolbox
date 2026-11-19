package workspace

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"toolbox/core"
)

// onDisk is workspace.json (SPEC §A2). Root, Current and Missing are never
// stored: the folder it sits in is the root.
type onDisk struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Kind          Kind     `json:"kind"`
	Baseline      string   `json:"baseline"`
	Present       bool     `json:"present"`
	Keep          []string `json:"keep"`
	Exclude       []string `json:"exclude"`
	StripLocation bool     `json:"stripLocation"`
	Created       int64    `json:"created"`
}

// SupportDirOf is <root>/.toolbox.
func SupportDirOf(root string) string { return filepath.Join(root, SupportFolder) }

// LibraryDirOf is <root>/Library.
func LibraryDirOf(root string) string { return filepath.Join(root, LibraryFolder) }

// ReadInfo reads <root>/.toolbox/workspace.json.
func ReadInfo(root string) (Info, error) {
	b, err := os.ReadFile(filepath.Join(SupportDirOf(root), InfoFile))
	if err != nil {
		return Info{}, err
	}
	var d onDisk
	if err := json.Unmarshal(b, &d); err != nil {
		return Info{}, fmt.Errorf("read %s: %w", InfoFile, err)
	}
	if d.ID == "" || strings.TrimSpace(d.Name) == "" {
		return Info{}, fmt.Errorf("read %s: missing id or name", InfoFile)
	}
	if d.Kind == "" || d.Kind == KindPersonal {
		d.Kind = KindStandard
	}
	info := Info{
		ID: d.ID, Name: d.Name, Kind: d.Kind, Root: filepath.Clean(root), Baseline: d.Baseline,
		Present: d.Present, Keep: d.Keep, Exclude: d.Exclude, StripLocation: d.StripLocation, Created: d.Created,
	}
	if info.Keep == nil {
		info.Keep = []string{}
	}
	if info.Exclude == nil {
		info.Exclude = []string{}
	}
	return info, nil
}

// WriteInfo writes info to its root's workspace.json (atomically), creating
// the support folder.
func WriteInfo(info Info) error {
	if info.Root == "" {
		return errors.New("workspace has no root")
	}
	d := onDisk{
		ID: info.ID, Name: info.Name, Kind: info.Kind, Baseline: info.Baseline, Present: info.Present,
		Keep: info.Keep, Exclude: info.Exclude, StripLocation: info.StripLocation, Created: info.Created,
	}
	if d.Keep == nil {
		d.Keep = []string{}
	}
	if d.Exclude == nil {
		d.Exclude = []string{}
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(SupportDirOf(info.Root), InfoFile), b)
}

func writeFileAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ReadManifest reads <root>/.toolbox/baseline-manifest.json. ok is false when
// there is none.
func ReadManifest(root string) (m Manifest, ok bool, err error) {
	b, err := os.ReadFile(filepath.Join(SupportDirOf(root), ManifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return Manifest{}, false, nil
	}
	if err != nil {
		return Manifest{}, false, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return Manifest{}, false, fmt.Errorf("read %s: %w", ManifestFile, err)
	}
	return m, true, nil
}

// WriteManifest writes the baseline manifest (atomically).
func WriteManifest(root string, m Manifest) error {
	if m.Files == nil {
		m.Files = []ManifestEntry{}
	}
	b, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(SupportDirOf(root), ManifestFile), b)
}

// NewID returns a 12-hex-char workspace ID.
func NewID() string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%012x", time.Now().UnixNano()&0xffffffffffff)
	}
	return hex.EncodeToString(b[:])
}

// entry is one workspace in workspaces.json.
type entry struct {
	ID   string `json:"id"`
	Name string `json:"name"` // cached for Missing roots
	Kind Kind   `json:"kind"`
	Root string `json:"root"`
}

// listFile is workspaces.json.
type listFile struct {
	Version    int     `json:"version"`
	Active     string  `json:"active"`   // the workspace a plain launch opens ("" = personal)
	LastUsed   string  `json:"lastUsed"` // the workspace opened last
	Workspaces []entry `json:"workspaces"`
}

// Store reads and writes workspaces.json in the global support dir. A Store
// with an empty Dir (sandboxed runs) never touches disk.
type Store struct{ Dir string }

var storeMu sync.Mutex // one process: serialise read-modify-write

// Enabled reports whether the list can be read and written.
func (s Store) Enabled() bool { return s.Dir != "" }

func (s Store) path() string { return filepath.Join(s.Dir, ListFile) }

// load reads the list. A corrupt file is kept as workspaces.json.bak and an
// empty list is returned with a notice.
func (s Store) load() (listFile, string) {
	if !s.Enabled() {
		return listFile{Version: 1}, ""
	}
	b, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return listFile{Version: 1}, ""
	}
	var lf listFile
	if err == nil {
		err = json.Unmarshal(b, &lf)
	}
	if err != nil {
		_ = os.Remove(s.path() + ".bak")
		_ = os.Rename(s.path(), s.path()+".bak")
		return listFile{Version: 1}, "The workspace list couldn't be read, so Personal opened. The old list is kept as " + ListFile + ".bak."
	}
	lf.Version = 1
	return lf, ""
}

func (s Store) save(lf listFile) error {
	if !s.Enabled() {
		return errors.New("workspaces can't be saved in a dev sandbox")
	}
	if lf.Workspaces == nil {
		lf.Workspaces = []entry{}
	}
	b, err := json.MarshalIndent(lf, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path(), b)
}

func sameRoot(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	return a == b || (isWindowsPath(a) && strings.EqualFold(a, b))
}

func isWindowsPath(p string) bool {
	return filepath.VolumeName(p) != "" || strings.HasPrefix(p, `\\`)
}

func (lf listFile) byRoot(root string) (int, bool) {
	for i, e := range lf.Workspaces {
		if sameRoot(e.Root, root) {
			return i, true
		}
	}
	return -1, false
}

func (lf listFile) byID(id string) (int, bool) {
	for i, e := range lf.Workspaces {
		if e.ID == id {
			return i, true
		}
	}
	return -1, false
}

// List returns Personal first, then every listed workspace. current (an ID)
// is marked Current. Entries whose root or workspace.json is gone are
// Missing, with the cached name and kind. notice is set when the file was
// corrupt.
func (s Store) List(current string) (out []Info, notice string) {
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, notice := s.load()
	return infos(lf, current), notice
}

func personalInfo(current string) Info {
	return Info{ID: PersonalID, Name: "Personal", Kind: KindPersonal, Keep: []string{}, Exclude: []string{}, Current: current == PersonalID}
}

func infos(lf listFile, current string) []Info {
	out := []Info{personalInfo(current)}
	for _, e := range lf.Workspaces {
		info, err := ReadInfo(e.Root)
		if err != nil {
			info = Info{ID: e.ID, Name: e.Name, Kind: e.Kind, Root: e.Root, Keep: []string{}, Exclude: []string{}, Missing: true}
		} else {
			info.ID = e.ID // the list is authoritative (a copied folder keeps its own file)
		}
		info.Current = info.ID == current
		out = append(out, info)
	}
	return out
}

// Find returns the listed workspace with this ID.
func (s Store) Find(id string) (Info, bool) {
	list, _ := s.List("")
	for _, i := range list {
		if i.ID == id {
			return i, true
		}
	}
	return Info{}, false
}

// NoteUsed records the workspace as the last used (best effort).
func (s Store) NoteUsed(id string) {
	if !s.Enabled() {
		return
	}
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, _ := s.load()
	if lf.LastUsed == id {
		return
	}
	lf.LastUsed = id
	_ = s.save(lf)
}

// SetActive sets the workspace a plain launch opens ("" or "personal" =
// Personal).
func (s Store) SetActive(id string) error {
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, _ := s.load()
	lf.Active = id
	return s.save(lf)
}

// Rename changes a workspace's name in its workspace.json and the list.
func (s Store) Rename(id, name string) error {
	if id == PersonalID {
		return core.ValidationError("Personal can't be renamed", nil)
	}
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, _ := s.load()
	i, ok := lf.byID(id)
	if !ok {
		return core.Errorf(core.CodeNotFound, "That workspace isn't in the list")
	}
	name = strings.TrimSpace(name)
	if err := checkName(name, lf, id); err != nil {
		return err
	}
	if info, err := ReadInfo(lf.Workspaces[i].Root); err == nil {
		info.Name = name
		if err := WriteInfo(info); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't rename the workspace").WithCause(err)
		}
	}
	lf.Workspaces[i].Name = name
	return s.save(lf)
}

// Remove takes a workspace off the list. Files are never touched.
func (s Store) Remove(id string) error {
	if id == PersonalID {
		return core.ValidationError("Personal can't be removed", nil)
	}
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, _ := s.load()
	i, ok := lf.byID(id)
	if !ok {
		return core.Errorf(core.CodeNotFound, "That workspace isn't in the list")
	}
	lf.Workspaces = append(lf.Workspaces[:i], lf.Workspaces[i+1:]...)
	if lf.Active == id {
		lf.Active = ""
	}
	if lf.LastUsed == id {
		lf.LastUsed = ""
	}
	return s.save(lf)
}

// UpdateInfo rewrites a listed workspace's workspace.json through fn.
func (s Store) UpdateInfo(id string, fn func(*Info)) (Info, error) {
	storeMu.Lock()
	defer storeMu.Unlock()
	lf, _ := s.load()
	i, ok := lf.byID(id)
	if !ok {
		return Info{}, core.Errorf(core.CodeNotFound, "That workspace isn't in the list")
	}
	info, err := ReadInfo(lf.Workspaces[i].Root)
	if err != nil {
		return Info{}, core.Errorf(core.CodeNotFound, "That workspace's folder isn't there")
	}
	fn(&info)
	info.ID = id
	if err := WriteInfo(info); err != nil {
		return Info{}, core.Errorf(core.CodeInternal, "Couldn't save the workspace").WithCause(err)
	}
	lf.Workspaces[i].Name, lf.Workspaces[i].Kind = info.Name, info.Kind
	if err := s.save(lf); err != nil {
		return Info{}, err
	}
	return info, nil
}
