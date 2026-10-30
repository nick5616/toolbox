package visualizer

// Saved designs ("My presets", SPEC.md §6.10) live in their own JSON file in
// the support dir: the settings store caps a module's state at 64 KB, far
// below 50 designs of up to 512 KiB.

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
	"toolbox/core/viz"
)

// Design is one saved design.
type Design struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ShowJSON  string `json:"showJson"`
	UpdatedMs int64  `json:"updatedMs"`
}

const (
	maxDesigns     = 50
	maxDesignsSize = 4 << 20
	maxNameRunes   = 80
)

type designStore struct {
	mu   sync.Mutex
	path string // "" = not configured
}

var designNow = time.Now

func (d *designStore) load() ([]Design, error) {
	if d.path == "" {
		return []Design{}, nil
	}
	b, err := os.ReadFile(d.path)
	if errors.Is(err, os.ErrNotExist) {
		return []Design{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading saved designs: %w", err)
	}
	var out []Design
	if err := json.Unmarshal(b, &out); err != nil {
		return []Design{}, nil // a damaged file starts over rather than blocking the tool
	}
	if out == nil {
		out = []Design{}
	}
	return out, nil
}

func (d *designStore) save(list []Design) error {
	if d.path == "" {
		return core.Errorf(core.CodeInternal, "Saved designs aren't available")
	}
	b, err := json.Marshal(list)
	if err != nil {
		return err
	}
	if len(b) > maxDesignsSize {
		return core.ValidationError("Your saved designs are using too much space", map[string]string{"design": "Delete a saved design first"})
	}
	if err := os.MkdirAll(filepath.Dir(d.path), 0o755); err != nil {
		return fmt.Errorf("creating the designs folder: %w", err)
	}
	tmp := d.path + ".part"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return fmt.Errorf("saving designs: %w", err)
	}
	return os.Rename(tmp, d.path)
}

func cleanName(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxNameRunes {
		s = string(r[:maxNameRunes])
	}
	if s == "" {
		s = "My design"
	}
	return s
}

func newDesignID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// list returns the saved designs, newest first.
func (d *designStore) list() ([]Design, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.load()
}

// put adds a design (empty ID) or replaces the one with its ID.
func (d *designStore) put(in Design) (Design, error) {
	s := strings.TrimSpace(in.ShowJSON)
	if s == "" || len(s) > viz.MaxShowBytes || !json.Valid([]byte(s)) {
		return Design{}, core.ValidationError("This design can't be saved", map[string]string{"showJson": "The design is missing, too large or not valid"})
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	list, err := d.load()
	if err != nil {
		return Design{}, err
	}
	in.Name, in.ShowJSON, in.UpdatedMs = cleanName(in.Name), s, designNow().UnixMilli()
	for i, x := range list {
		if in.ID != "" && x.ID == in.ID {
			list = append(append([]Design{in}, list[:i]...), list[i+1:]...)
			return in, d.save(list)
		}
	}
	if len(list) >= maxDesigns {
		return Design{}, core.ValidationError(fmt.Sprintf("You can keep %d saved designs", maxDesigns), map[string]string{"design": "Delete one first"})
	}
	in.ID = newDesignID()
	list = append([]Design{in}, list...)
	return in, d.save(list)
}

func (d *designStore) rename(id, name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	list, err := d.load()
	if err != nil {
		return err
	}
	for i := range list {
		if list[i].ID == id {
			list[i].Name, list[i].UpdatedMs = cleanName(name), designNow().UnixMilli()
			return d.save(list)
		}
	}
	return core.Errorf(core.CodeNotFound, "That design no longer exists")
}

func (d *designStore) remove(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	list, err := d.load()
	if err != nil {
		return err
	}
	out := list[:0]
	for _, x := range list {
		if x.ID != id {
			out = append(out, x)
		}
	}
	return d.save(out)
}

// SetDesignsFile tells the module where saved designs are kept.
func (m *Module) SetDesignsFile(path string) { m.designs.path = path }

// Designs lists the saved designs, newest first.
func (s *Service) Designs() ([]Design, error) { return s.m.designs.list() }

// SaveDesign adds a design (empty id) or updates one; it returns the stored design.
func (s *Service) SaveDesign(d Design) (Design, error) { return s.m.designs.put(d) }

// RenameDesign renames a saved design.
func (s *Service) RenameDesign(id, name string) error { return s.m.designs.rename(id, name) }

// DeleteDesign removes a saved design.
func (s *Service) DeleteDesign(id string) error { return s.m.designs.remove(id) }
