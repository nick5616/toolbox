package sidecar

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"toolbox/core"
	sidecarfiles "toolbox/sidecar"
)

const (
	hashFile    = ".toolbox-hash"
	versionFile = ".toolbox-version"
)

func isFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

// Detect reports the installed engine as a dependency status (never starts
// Python): missing / outdated (hash mismatch) / ok.
func Detect(ctx context.Context, p core.Paths) core.DepStatus {
	st := core.DepStatus{
		ID: DepID, Name: "AI engine",
		Purpose:     "Python runtime for stems, BPM & key and MIDI (≈1 GB)",
		State:       core.DepMissing,
		Source:      core.SourceNone,
		Managed:     true,
		RequiredBy:  []string{},
		InstallHint: "Install from Settings → Dependencies",
		CheckedAt:   time.Now().UnixMilli(),
	}
	st.RecommendedBy = []string{}
	py := PythonPath(p)
	if !isFile(py) {
		return st
	}
	st.Path, st.Source = py, core.SourceManaged
	if b, err := os.ReadFile(filepath.Join(p.SidecarDir, versionFile)); err == nil {
		st.Version = strings.TrimSpace(string(b))
	}
	h, _ := os.ReadFile(filepath.Join(p.SidecarDir, hashFile))
	if strings.TrimSpace(string(h)) != sidecarfiles.Hash() {
		st.State = core.DepOutdated
		return st
	}
	st.State = core.DepOK
	return st
}

// Remove stops the engine and deletes the venv, project and Python installs.
func Remove(p core.Paths, m *Manager) error {
	if m != nil {
		if err := m.Stop(); err != nil {
			return err
		}
	}
	for _, d := range []string{p.SidecarDir, p.PythonDir} {
		if err := os.RemoveAll(d); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't remove the AI engine").WithCause(err).
				WithHint("Close anything using it and try again")
		}
	}
	return nil
}

// ModelsUsage is the total size of the models dir in bytes.
func ModelsUsage(p core.Paths) (int64, error) {
	var total int64
	err := filepath.WalkDir(p.ModelsDir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if d.Type().IsRegular() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("measure models: %w", err)
	}
	return total, nil
}

// ClearModels deletes everything inside the models dir.
func ClearModels(p core.Paths) error {
	entries, err := os.ReadDir(p.ModelsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read models dir: %w", err)
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(p.ModelsDir, e.Name())); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't delete the models").WithCause(err)
		}
	}
	return nil
}
