package packs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"toolbox/core"
)

// toolsSubfolder is created inside a picked folder that already has other
// content (SPEC.md §7.3).
const toolsSubfolder = "Toolbox Tools"

// pendingFile is the content of setup-pending.json.
type pendingFile struct {
	Packs []string `json:"packs"`
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// within reports whether child is parent or inside it.
func within(parent, child string) bool {
	p, c := filepath.Clean(parent), filepath.Clean(child)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		p, c = strings.ToLower(p), strings.ToLower(c)
	}
	rel, err := filepath.Rel(p, c)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func hasMarker(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, core.ToolsMarkerFile))
	return err == nil
}

func isEmptyDir(dir string) bool {
	ents, err := os.ReadDir(dir)
	return err == nil && len(ents) == 0
}

var errPickDifferent = func() *core.AppError {
	return core.ValidationError("Pick a different folder", map[string]string{"path": "Pick a different folder"})
}

// checkToolsTarget refuses folders the tools can't live in: the library, or
// anything inside the support dir other than the support dir itself.
func (s *Service) checkToolsTarget(dir string) error {
	p := s.cfg.Paths
	if dir == "" || !filepath.IsAbs(dir) {
		return core.ValidationError("Pick a folder", map[string]string{"path": "Pick a folder"})
	}
	if samePath(dir, p.SupportDir) {
		return nil
	}
	if within(p.SupportDir, dir) {
		return errPickDifferent()
	}
	if s.cfg.Settings != nil {
		if lib := s.cfg.Settings.Current().LibraryDir; lib != "" && (within(lib, dir) || samePath(lib, dir)) {
			return errPickDifferent()
		}
	}
	return nil
}

// ResolveToolsDir applies the folder-picking rules of SPEC.md §7.3 to a
// folder the user picked and returns the tools folder to use: the folder
// itself when it is empty, new or already a tools folder, else its
// "Toolbox Tools" subfolder. The library folder and folders inside the
// support dir (other than the support dir itself) are refused.
func (s *Service) ResolveToolsDir(picked string) (string, error) {
	picked = strings.TrimSpace(picked)
	if picked == "" {
		return "", core.ValidationError("Pick a folder", map[string]string{"path": "Pick a folder"})
	}
	abs, err := filepath.Abs(picked)
	if err != nil {
		return "", core.ValidationError("That isn't a usable folder", map[string]string{"path": picked})
	}
	abs = filepath.Clean(abs)
	if err := s.checkToolsTarget(abs); err != nil {
		return "", err
	}
	if samePath(abs, s.cfg.Paths.SupportDir) {
		return abs, nil
	}
	fi, err := os.Stat(abs)
	switch {
	case err != nil && os.IsNotExist(err):
		return abs, nil
	case err != nil:
		return "", core.ValidationError("Can't use that folder", map[string]string{"path": picked}).WithCause(err)
	case !fi.IsDir():
		return "", core.ValidationError("Pick a folder, not a file", map[string]string{"path": picked})
	}
	if hasMarker(abs) || isEmptyDir(abs) {
		return abs, nil
	}
	sub := filepath.Join(abs, toolsSubfolder)
	if err := s.checkToolsTarget(sub); err != nil {
		return "", err
	}
	if sfi, err := os.Stat(sub); err == nil {
		if !sfi.IsDir() {
			return "", core.ValidationError("Pick a different folder", map[string]string{"path": picked})
		}
		if !hasMarker(sub) && !isEmptyDir(sub) {
			return "", core.ValidationError("Pick a different folder", map[string]string{"path": picked}).
				WithHint(`"Toolbox Tools" already exists there and holds other files`)
		}
	}
	return sub, nil
}

// hasManaged reports whether any managed tool files exist in the current
// tools folder.
func (s *Service) hasManaged() bool {
	for _, d := range s.cfg.Paths.ToolsDirs() {
		if ents, err := os.ReadDir(d); err == nil && len(ents) > 0 {
			return true
		}
	}
	return false
}

// ensureMarker marks the tools folder (when it isn't the support dir).
func (s *Service) ensureMarker() {
	dir := s.cfg.Paths.ToolsDir
	if dir == "" || samePath(dir, s.cfg.Paths.SupportDir) {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, core.ToolsMarkerFile), nil, 0o644)
}

// writeMarker creates dir (if needed) and its marker.
func writeMarker(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create tools folder: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, core.ToolsMarkerFile), nil, 0o644); err != nil {
		return fmt.Errorf("mark tools folder: %w", err)
	}
	return nil
}

// StartupTasks runs at app start before services are used. It finishes a
// tools-folder move (deleting the old folder's tools once the new folder is
// in use) and reads and deletes setup-pending.json, returning the packs to
// install (nil when none are pending).
func (s *Service) StartupTasks() []string {
	s.finishMoveCleanup()
	path := filepath.Join(s.cfg.Paths.SupportDir, core.SetupPendingFile)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	_ = os.Remove(path)
	var pf pendingFile
	if json.Unmarshal(b, &pf) != nil {
		return nil
	}
	var out []string
	for _, id := range pf.Packs {
		if _, ok := packByID(id); ok {
			out = append(out, id)
		}
	}
	return out
}

// finishMoveCleanup deletes the four tools subfolders of the old location
// after a move, only when the new folder (the current one) carries its marker.
func (s *Service) finishMoveCleanup() {
	p := s.cfg.Paths
	cleanup := filepath.Join(p.SupportDir, core.ToolsMoveCleanupFile)
	b, err := os.ReadFile(cleanup)
	if err != nil {
		return
	}
	old := filepath.Clean(strings.TrimSpace(string(b)))
	if old == "" || old == "." || !filepath.IsAbs(old) || filepath.Dir(old) == old {
		_ = os.Remove(cleanup)
		return
	}
	if samePath(old, p.ToolsDir) {
		_ = os.Remove(cleanup) // moved back or reverted: nothing to clean
		return
	}
	if !hasMarker(p.ToolsDir) {
		return // the new folder isn't in use (yet): keep the old files
	}
	for _, name := range toolsSubdirNames {
		_ = os.RemoveAll(filepath.Join(old, name))
	}
	if !samePath(old, p.SupportDir) {
		// A dedicated old tools folder: drop its marker and the folder if empty.
		_ = os.Remove(filepath.Join(old, core.ToolsMarkerFile))
		_ = os.Remove(old)
	}
	_ = os.Remove(cleanup)
}

// toolsSubdirNames are the folders of a tools folder, as in Paths.ToolsDirs.
var toolsSubdirNames = []string{"bin", "python", "sidecar", "models"}
