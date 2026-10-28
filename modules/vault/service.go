package vault

import (
	"context"
	"encoding/json"

	"toolbox/core"
)

var errNotBuilt = core.Errorf(core.CodeInternal, "The vault isn't available yet")

// validate and run are implemented by VA1 (SPEC.md §6.2).
func (v *Vault) validate(inputs []string, options json.RawMessage) error {
	_, err := core.DecodeOptionsJSON[Options](options)
	return err
}

func (v *Vault) run(ctx context.Context, job *core.JobContext) error { return errNotBuilt }

// Service is the Vault's typed Wails service (SPEC.md §6.2).
type Service struct{ v *Vault }

// NewService builds the service.
func NewService(v *Vault) *Service { return &Service{v: v} }

// State returns the vault state.
func (s *Service) State() core.VaultState { return core.VaultState{} }

// Create makes a new vault and returns the recovery key (shown once).
func (s *Service) Create(passphrase string) (string, error) { return "", errNotBuilt }

// Unlock accepts the passphrase or an AGE-SECRET-KEY-1… recovery key.
func (s *Service) Unlock(secret string) error { return errNotBuilt }

// Lock locks the vault and wipes temporary open copies.
func (s *Service) Lock() error { return errNotBuilt }

// List returns entries in folder ("" = all) matching search. Requires unlocked.
func (s *Service) List(folder string, search string) ([]Entry, error) { return []Entry{}, errNotBuilt }

// Folders lists folder names.
func (s *Service) Folders() ([]string, error) { return []string{}, errNotBuilt }

// Enqueue adds files (copies, never moves) in one job.
func (s *Service) Enqueue(paths []string, folder string) ([]core.Job, error) {
	return []core.Job{}, errNotBuilt
}

// Rename renames an entry.
func (s *Service) Rename(id, name string) error { return errNotBuilt }

// Move moves entries to folder ("" = root).
func (s *Service) Move(ids []string, folder string) error { return errNotBuilt }

// Delete permanently deletes entries.
func (s *Service) Delete(ids []string) error { return errNotBuilt }

// Open decrypts an entry to a temporary copy and opens it with the default app.
func (s *Service) Open(id string) error { return errNotBuilt }

// Preview returns an image entry (≤ 20 MB) as a data URL, decrypted in memory.
func (s *Service) Preview(id string) (string, error) { return "", errNotBuilt }

// Export decrypts entries into <library>/Vault exports/.
func (s *Service) Export(ids []string) ([]core.Job, error) { return []core.Job{}, errNotBuilt }

// ChangePassphrase re-wraps the identity with a new passphrase.
func (s *Service) ChangePassphrase(old, new string) error { return errNotBuilt }

// RecoveryKey shows the recovery key again after checking the passphrase.
func (s *Service) RecoveryKey(passphrase string) (string, error) { return "", errNotBuilt }
