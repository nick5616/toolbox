package eraser

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"toolbox/core"
)

// Saved masks (Phase 14) are what the automatic mode (the pipeline step)
// erases with: a mask painted once in the tool, kept under a name, applied to
// every photo of the same shape (a tripod series).
// <support>/eraser/masks/<id>.png plus <id>.json (name, size, time).

const (
	maxSavedMasks = 50
	maxMaskName   = 60
)

// SavedMask describes one saved mask.
type SavedMask struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	CreatedAt int64  `json:"createdAt"` // Unix ms
}

var maskIDRe = regexp.MustCompile(`^[0-9a-f]{24}$`)

// SetSavedMasksDir sets where saved masks live. Without it they are in
// <support>/eraser/masks, found from the temporary mask folder
// (<support>/tmp/eraser).
func (m *Module) SetSavedMasksDir(dir string) { m.savedDir = dir }

func (m *Module) savedMasksDir() string {
	if m.savedDir != "" {
		return m.savedDir
	}
	if m.maskDir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(filepath.Dir(filepath.Clean(m.maskDir))), "eraser", "masks")
}

func (m *Module) maskFile(id string) (string, error) {
	dir := m.savedMasksDir()
	if dir == "" {
		return "", core.Errorf(core.CodeInternal, "The saved masks folder isn't configured")
	}
	if !maskIDRe.MatchString(id) {
		return "", core.Errorf(core.CodeNotFound, "That mask doesn't exist")
	}
	return filepath.Join(dir, id), nil
}

func (m *Module) readMask(id string) (SavedMask, error) {
	base, err := m.maskFile(id)
	if err != nil {
		return SavedMask{}, err
	}
	b, err := os.ReadFile(base + ".json")
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return SavedMask{}, core.Errorf(core.CodeNotFound, "That mask doesn't exist")
		}
		return SavedMask{}, fmt.Errorf("reading a saved mask: %w", err)
	}
	var sm SavedMask
	if err := json.Unmarshal(b, &sm); err != nil {
		return SavedMask{}, fmt.Errorf("reading a saved mask: %w", err)
	}
	sm.ID = id
	if _, err := os.Stat(base + ".png"); err != nil {
		return SavedMask{}, core.Errorf(core.CodeNotFound, "That mask's picture is missing")
	}
	return sm, nil
}

// saveMask keeps a painted mask (base64 PNG, white = erase) under a name.
func (m *Module) saveMask(name, maskPNG string) (SavedMask, error) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < 1 || n > maxMaskName {
		return SavedMask{}, core.ValidationError("Name the mask (1 to 60 characters)", map[string]string{"name": "Name the mask"})
	}
	data, img, err := decodeMask(maskPNG)
	if err != nil {
		return SavedMask{}, err
	}
	if !maskPainted(img) {
		return SavedMask{}, core.ValidationError(paintFirst, map[string]string{"mask": paintFirst})
	}
	dir := m.savedMasksDir()
	if dir == "" {
		return SavedMask{}, core.Errorf(core.CodeInternal, "The saved masks folder isn't configured")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return SavedMask{}, fmt.Errorf("creating the saved masks folder: %w", err)
	}
	existing, err := m.listMasks()
	if err != nil {
		return SavedMask{}, err
	}
	if len(existing) >= maxSavedMasks {
		return SavedMask{}, core.ValidationError(fmt.Sprintf("You can keep %d masks", maxSavedMasks), nil).
			WithHint("Delete one you no longer use")
	}
	for _, e := range existing {
		if strings.EqualFold(e.Name, name) {
			return SavedMask{}, core.ValidationError("A mask already has that name", map[string]string{"name": "Pick another name"})
		}
	}
	rn, err := randomName()
	if err != nil {
		return SavedMask{}, err
	}
	id := strings.TrimSuffix(rn, ".png")[:24]
	b := img.Bounds()
	sm := SavedMask{ID: id, Name: name, Width: b.Dx(), Height: b.Dy(), CreatedAt: time.Now().UnixMilli()}
	meta, err := json.Marshal(sm)
	if err != nil {
		return SavedMask{}, fmt.Errorf("encoding a saved mask: %w", err)
	}
	base := filepath.Join(dir, id)
	if err := os.WriteFile(base+".png", data, 0o600); err != nil {
		return SavedMask{}, fmt.Errorf("saving the mask: %w", err)
	}
	if err := os.WriteFile(base+".json", meta, 0o600); err != nil {
		_ = os.Remove(base + ".png")
		return SavedMask{}, fmt.Errorf("saving the mask: %w", err)
	}
	return sm, nil
}

// listMasks returns the saved masks, newest first. Entries with a missing or
// unreadable half are skipped.
func (m *Module) listMasks() ([]SavedMask, error) {
	dir := m.savedMasksDir()
	out := []SavedMask{}
	if dir == "" {
		return out, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return out, nil
		}
		return nil, fmt.Errorf("listing saved masks: %w", err)
	}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !maskIDRe.MatchString(id) {
			continue
		}
		if sm, err := m.readMask(id); err == nil {
			out = append(out, sm)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

// deleteMask removes a saved mask.
func (m *Module) deleteMask(id string) error {
	base, err := m.maskFile(id)
	if err != nil {
		return err
	}
	if _, err := os.Stat(base + ".json"); err != nil {
		return core.Errorf(core.CodeNotFound, "That mask doesn't exist")
	}
	for _, ext := range []string{".png", ".json"} {
		if err := os.Remove(base + ext); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("deleting a saved mask: %w", err)
		}
	}
	return nil
}

// maskDataURL returns a saved mask as "data:image/png;base64,…".
func (m *Module) maskDataURL(id string) (string, error) {
	if _, err := m.readMask(id); err != nil {
		return "", err
	}
	base, _ := m.maskFile(id)
	b, err := os.ReadFile(base + ".png")
	if err != nil {
		return "", fmt.Errorf("reading a saved mask: %w", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b), nil
}

// SavedMasks lists the saved masks (the Library's "Other places", Phase 19).
func (m *Module) SavedMasks() ([]SavedMask, error) { return m.listMasks() }
