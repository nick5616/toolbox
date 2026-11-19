package grade

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"toolbox/core"
)

// Saved looks ("Mine"): <support>/grade/looks.json, at most MaxLooks, newest
// first, written atomically.

// MaxLooks is the most saved looks.
const MaxLooks = 200

type looksFile struct {
	Looks []Recipe `json:"looks"`
}

var looksMu sync.Mutex // one file, one writer (the module is a singleton)

func (m *Module) readLooks() ([]Recipe, error) {
	if m.cfg.LooksFile == "" {
		return nil, core.Errorf(core.CodeInternal, "Saved looks aren't available")
	}
	b, err := os.ReadFile(m.cfg.LooksFile)
	if errors.Is(err, os.ErrNotExist) {
		return []Recipe{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading saved looks: %w", err)
	}
	var f looksFile
	if err := json.Unmarshal(b, &f); err != nil {
		// Keep the damaged file for inspection and start fresh.
		_ = os.Rename(m.cfg.LooksFile, m.cfg.LooksFile+".bad")
		return []Recipe{}, nil
	}
	out := make([]Recipe, 0, len(f.Looks))
	for _, r := range f.Looks {
		if n, err := Normalize(r); err == nil {
			out = append(out, n)
		}
	}
	return out, nil
}

func (m *Module) writeLooks(looks []Recipe) error {
	b, err := json.MarshalIndent(looksFile{Looks: looks}, "", " ")
	if err != nil {
		return fmt.Errorf("encoding saved looks: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(m.cfg.LooksFile), 0o755); err != nil {
		return fmt.Errorf("creating the looks folder: %w", err)
	}
	part := m.cfg.LooksFile + ".part"
	if err := os.WriteFile(part, b, 0o644); err != nil {
		return fmt.Errorf("writing saved looks: %w", err)
	}
	if err := os.Rename(part, m.cfg.LooksFile); err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("saving looks: %w", err)
	}
	return nil
}

// Looks returns the saved looks, newest first.
func (m *Module) Looks() ([]Recipe, error) {
	looksMu.Lock()
	defer looksMu.Unlock()
	return m.readLooks()
}

func lookName(name string) (string, error) {
	n := cutName(name)
	if n == "" {
		return "", core.ValidationError("Give the look a name", map[string]string{"name": "Give the look a name"})
	}
	return n, nil
}

func indexOfLook(looks []Recipe, name string) int {
	for i, l := range looks {
		if strings.EqualFold(l.Name, name) {
			return i
		}
	}
	return -1
}

// SaveLook stores r (as tier "mine"); a look with the same name is replaced.
func (m *Module) SaveLook(r Recipe) (Recipe, error) {
	name, err := lookName(r.Name)
	if err != nil {
		return Recipe{}, err
	}
	r.Name, r.Tier = name, TierMine
	n, err := Normalize(r)
	if err != nil {
		return Recipe{}, core.ValidationError("This look isn't valid", map[string]string{"recipe": err.Error()})
	}
	looksMu.Lock()
	defer looksMu.Unlock()
	looks, err := m.readLooks()
	if err != nil {
		return Recipe{}, err
	}
	if i := indexOfLook(looks, n.Name); i >= 0 {
		looks = append(looks[:i], looks[i+1:]...)
	}
	if len(looks) >= MaxLooks {
		return Recipe{}, core.ValidationError(fmt.Sprintf("You can keep %d looks. Delete one first", MaxLooks), nil)
	}
	looks = append([]Recipe{n}, looks...)
	return n, m.writeLooks(looks)
}

// RenameLook renames a saved look.
func (m *Module) RenameLook(oldName, newName string) error {
	nn, err := lookName(newName)
	if err != nil {
		return err
	}
	looksMu.Lock()
	defer looksMu.Unlock()
	looks, err := m.readLooks()
	if err != nil {
		return err
	}
	i := indexOfLook(looks, strings.TrimSpace(oldName))
	if i < 0 {
		return core.Errorf(core.CodeNotFound, "That look isn't saved any more")
	}
	if j := indexOfLook(looks, nn); j >= 0 && j != i {
		return core.Errorf(core.CodeConflict, "A look called %q already exists", nn)
	}
	looks[i].Name = nn
	return m.writeLooks(looks)
}

// DeleteLook removes a saved look (a missing one is not an error).
func (m *Module) DeleteLook(name string) error {
	looksMu.Lock()
	defer looksMu.Unlock()
	looks, err := m.readLooks()
	if err != nil {
		return err
	}
	i := indexOfLook(looks, strings.TrimSpace(name))
	if i < 0 {
		return nil
	}
	return m.writeLooks(append(looks[:i], looks[i+1:]...))
}
