package vault

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

// Service is the Vault's typed Wails service (SPEC.md §6.2).
type Service struct{ v *Vault }

// NewService builds the service.
func NewService(v *Vault) *Service { return &Service{v: v} }

// State returns the vault state.
func (s *Service) State() core.VaultState { return s.v.state() }

// Create makes a new vault and returns the recovery key (shown once).
// The vault stays locked; the UI unlocks it after the key is confirmed.
func (s *Service) Create(passphrase string) (string, error) { return s.v.create(passphrase) }

// Unlock accepts the passphrase or an AGE-SECRET-KEY-1… recovery key.
func (s *Service) Unlock(secret string) error { return s.v.unlock(secret) }

// Lock locks the vault and wipes temporary open copies.
func (s *Service) Lock() error {
	s.v.lock()
	return nil
}

// List returns entries in folder ("" = all) matching search. Requires unlocked.
func (s *Service) List(folder string, search string) ([]Entry, error) {
	return s.v.list(folder, search)
}

// Folders lists folder names.
func (s *Service) Folders() ([]string, error) { return s.v.folders() }

// Enqueue adds files (copies, never moves) in one job.
func (s *Service) Enqueue(paths []string, folder string) ([]core.Job, error) {
	return s.v.enqueue(ActionAdd, paths, Options{Action: ActionAdd, Folder: folder})
}

// Rename renames an entry.
func (s *Service) Rename(id, name string) error { s.v.touch(); return s.v.rename(id, name) }

// Move moves entries to folder ("" = root).
func (s *Service) Move(ids []string, folder string) error { s.v.touch(); return s.v.move(ids, folder) }

// Delete permanently deletes entries.
func (s *Service) Delete(ids []string) error { s.v.touch(); return s.v.delete(ids) }

// Open decrypts an entry to a temporary copy and opens it with the default app.
func (s *Service) Open(id string) error { return s.v.open(id) }

// Preview returns an image entry (≤ 20 MB) as a data URL, decrypted in memory.
func (s *Service) Preview(id string) (string, error) { return s.v.preview(id) }

// Export decrypts entries into <library>/Vault exports/.
func (s *Service) Export(ids []string) ([]core.Job, error) {
	return s.v.enqueue(ActionExport, nil, Options{Action: ActionExport, IDs: ids})
}

// ChangePassphrase re-wraps the identity with a new passphrase.
func (s *Service) ChangePassphrase(old, new string) error { return s.v.changePassphrase(old, new) }

// RecoveryKey shows the recovery key again after checking the passphrase.
func (s *Service) RecoveryKey(passphrase string) (string, error) { return s.v.recoveryKey(passphrase) }

func (v *Vault) enqueue(action string, inputs []string, o Options) ([]core.Job, error) {
	v.touch()
	if _, _, _, err := v.unlockedSnapshot(); err != nil {
		return []core.Job{}, err
	}
	if o.IDs == nil {
		o.IDs = []string{}
	}
	b, err := json.Marshal(o)
	if err != nil {
		return []core.Job{}, err
	}
	jobs, err := v.submit(context.Background(), inputs, string(b))
	if err != nil {
		return []core.Job{}, err
	}
	return jobs, nil
}
