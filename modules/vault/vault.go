package vault

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"filippo.io/age"

	"toolbox/core"
)

const emitEvery = 5 * time.Second

// vaultDir is the vault folder for the current library.
func (v *Vault) vaultDir() string {
	lib := ""
	if v.cfg.LibraryDir != nil {
		lib = v.cfg.LibraryDir()
	}
	return filepath.Join(lib, "Vault")
}

func (v *Vault) autoLockMinutes() int {
	if v.minutes != nil {
		return v.minutes()
	}
	if v.cfg.Settings != nil {
		return v.cfg.Settings.Current().Vault.AutoLockMinutes
	}
	return core.DefaultVaultSettings().AutoLockMinutes
}

// stateLocked builds the state; v.mu must be held.
func (v *Vault) stateLocked() core.VaultState {
	dir := v.dir
	if v.idx == nil {
		dir = v.vaultDir()
	}
	_, err := os.Stat(filepath.Join(dir, fileMeta))
	st := core.VaultState{Exists: err == nil, AutoLockMinutes: v.autoLockMinutes(), Notice: v.notice}
	if v.idx != nil {
		st.Unlocked = true
		st.Entries = len(v.idx.Entries)
		if st.AutoLockMinutes > 0 {
			st.LockAt = v.lastActive.Add(time.Duration(st.AutoLockMinutes) * time.Minute).UnixMilli()
		}
	}
	return st
}

func (v *Vault) state() core.VaultState {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.stateLocked()
}

// emitState publishes vault:state. Callers must not hold v.mu.
func (v *Vault) emitState() {
	v.mu.Lock()
	st := v.stateLocked()
	v.lastEmit = v.now()
	v.mu.Unlock()
	v.cfg.Emitter.Emit(core.EventVaultState, st)
}

// touch records activity (resets the auto-lock countdown).
func (v *Vault) touch() {
	v.mu.Lock()
	if v.idx == nil {
		v.mu.Unlock()
		return
	}
	now := v.now()
	v.lastActive = now
	due := now.Sub(v.lastEmit) >= emitEvery
	v.mu.Unlock()
	if due {
		v.emitState()
	}
}

// unlockedSnapshot returns what an operation needs, or errLocked.
func (v *Vault) unlockedSnapshot() (id *age.X25519Identity, dir, session string, err error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.idx == nil {
		return nil, "", "", errLocked
	}
	return v.identity, v.dir, v.session, nil
}

func (v *Vault) checkAutoLock() {
	v.mu.Lock()
	if v.idx == nil || v.active > 0 {
		v.mu.Unlock()
		return
	}
	m := v.autoLockMinutes()
	expired := m > 0 && !v.now().Before(v.lastActive.Add(time.Duration(m)*time.Minute))
	v.mu.Unlock()
	if expired {
		v.lock()
	}
}

// lock clears the identity and index, cancels running jobs and wipes the
// temporary open copies.
func (v *Vault) lock() {
	v.mu.Lock()
	was := v.idx != nil
	v.identity, v.idx, v.dir, v.session = nil, nil, "", ""
	cancels := v.cancels
	v.cancels = map[int]context.CancelFunc{}
	v.mu.Unlock()
	for _, c := range cancels {
		c()
	}
	v.wipeOpen()
	if was {
		v.emitState()
	}
}

// wipeOpen deletes everything in OpenDir except the live session folder.
// Leftovers (Windows: still open elsewhere) are retried every retryEvery.
func (v *Vault) wipeOpen() {
	if v.cfg.OpenDir == "" {
		return
	}
	v.mu.Lock()
	keep := v.session
	v.mu.Unlock()
	if !wipeDir(v.cfg.OpenDir, keep) {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.closed || v.wipeTimer != nil {
		return
	}
	v.wipeTimer = time.AfterFunc(v.retryEvery, func() {
		v.mu.Lock()
		v.wipeTimer = nil
		v.mu.Unlock()
		v.wipeOpen()
	})
}

// wipeDir removes the children of dir except keep; it reports whether
// anything could not be removed.
func wipeDir(dir, keep string) (left bool) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range ents {
		if keep != "" && e.Name() == keep {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			left = true
		}
	}
	return left
}

func checkPassphrase(p string) error {
	if utf8.RuneCountInString(p) < minPassphrase {
		return core.ValidationError("Use at least 8 characters",
			map[string]string{"passphrase": "Use at least 8 characters"})
	}
	return nil
}

func wrongSecret(recovery bool) error {
	if recovery {
		return core.ValidationError("Wrong recovery key", map[string]string{"secret": "Wrong recovery key"})
	}
	return core.ValidationError("Wrong passphrase", map[string]string{"secret": "Wrong passphrase"})
}

func (v *Vault) create(passphrase string) (string, error) {
	if err := checkPassphrase(passphrase); err != nil {
		return "", err
	}
	v.opMu.Lock()
	defer v.opMu.Unlock()
	dir := v.vaultDir()
	if _, err := os.Stat(filepath.Join(dir, fileMeta)); err == nil {
		return "", core.Errorf(core.CodeConflict, "A vault already exists")
	}
	ident, err := age.GenerateX25519Identity()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(dir, dirBlobs), 0o700); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create the vault folder").WithCause(err)
	}
	sealed, err := sealIdentity(ident, passphrase, v.workFactor)
	if err != nil {
		return "", err
	}
	if err := writeFileAtomic(filepath.Join(dir, fileIdentity), sealed); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't write the vault").WithCause(err)
	}
	if err := saveIndex(dir, &index{Version: indexVersion, Entries: []indexEntry{}}, ident.Recipient()); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't write the vault").WithCause(err)
	}
	mb, _ := json.Marshal(meta{Format: 1, Created: core.NowMillis(), KDF: "age-scrypt", WorkFactor: v.workFactor})
	// vault.json is written last: its presence means the vault is complete.
	if err := writeFileAtomic(filepath.Join(dir, fileMeta), mb); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't write the vault").WithCause(err)
	}
	v.emitState()
	return ident.String(), nil
}

func (v *Vault) unlock(secret string) error {
	v.opMu.Lock()
	defer v.opMu.Unlock()
	dir := v.vaultDir()
	m, err := readMeta(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return core.ValidationError("There's no vault yet", nil)
		}
		return err
	}
	var ident *age.X25519Identity
	trimmed := strings.TrimSpace(secret)
	recovery := strings.HasPrefix(strings.ToUpper(trimmed), recoveryPrefix)
	if recovery {
		ident, err = age.ParseX25519Identity(strings.ToUpper(trimmed))
		if err != nil {
			return wrongSecret(true)
		}
	} else {
		blob, rerr := os.ReadFile(filepath.Join(dir, fileIdentity))
		if rerr != nil {
			return core.Errorf(core.CodeInternal, "The vault is damaged").WithCause(rerr)
		}
		ident, err = openIdentity(blob, secret, m.WorkFactor)
		if err != nil {
			if errors.Is(err, errWrongKey) {
				return wrongSecret(false)
			}
			return core.Errorf(core.CodeInternal, "The vault is damaged").WithCause(err)
		}
	}
	ix, usedBak, err := loadIndex(dir, ident)
	if err != nil {
		if errors.Is(err, errWrongKey) {
			return wrongSecret(recovery)
		}
		return err
	}
	v.mu.Lock()
	if v.idx == nil {
		v.identity, v.idx, v.dir = ident, ix, dir
		v.session = core.NewID()
		v.lastActive = v.now()
		v.notice = ""
		if usedBak {
			v.notice = "The vault index was restored from its backup copy"
		}
	}
	v.mu.Unlock()
	if usedBak {
		slog.Warn("vault index restored from backup copy")
	}
	v.emitState()
	// The notice is delivered once: the state emitted above carried it; later
	// states (and State()) don't. The view latches it until dismissed.
	v.mu.Lock()
	v.notice = ""
	v.mu.Unlock()
	return nil
}

// mutate applies fn to a copy of the index, saves it, then publishes it.
func (v *Vault) mutate(fn func(ix *index) error) error {
	v.opMu.Lock()
	defer v.opMu.Unlock()
	v.mu.Lock()
	if v.idx == nil {
		v.mu.Unlock()
		return errLocked
	}
	ident, dir, cur := v.identity, v.dir, v.idx.clone()
	v.mu.Unlock()

	if err := fn(cur); err != nil {
		return err
	}
	if err := saveIndex(dir, cur, ident.Recipient()); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the vault index").WithCause(err)
	}
	v.mu.Lock()
	if v.idx != nil && v.identity == ident {
		v.idx = cur
		v.lastActive = v.now()
	}
	v.mu.Unlock()
	v.emitState()
	return nil
}

func (v *Vault) changePassphrase(oldPass, newPass string) error {
	if err := checkPassphrase(newPass); err != nil {
		return err
	}
	v.opMu.Lock()
	defer v.opMu.Unlock()
	dir := v.vaultDir()
	m, err := readMeta(dir)
	if err != nil {
		return core.ValidationError("There's no vault yet", nil)
	}
	ident, err := v.readIdentity(dir, m, oldPass)
	if err != nil {
		return err
	}
	sealed, err := sealIdentity(ident, newPass, m.WorkFactor)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, fileIdentity), sealed); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the new passphrase").WithCause(err)
	}
	v.touch()
	return nil
}

func (v *Vault) recoveryKey(passphrase string) (string, error) {
	dir := v.vaultDir()
	m, err := readMeta(dir)
	if err != nil {
		return "", core.ValidationError("There's no vault yet", nil)
	}
	ident, err := v.readIdentity(dir, m, passphrase)
	if err != nil {
		return "", err
	}
	v.touch()
	return ident.String(), nil
}

func (v *Vault) readIdentity(dir string, m meta, pass string) (*age.X25519Identity, error) {
	blob, err := os.ReadFile(filepath.Join(dir, fileIdentity))
	if err != nil {
		return nil, core.Errorf(core.CodeInternal, "The vault is damaged").WithCause(err)
	}
	ident, err := openIdentity(blob, pass, m.WorkFactor)
	if err != nil {
		if errors.Is(err, errWrongKey) {
			return nil, wrongSecret(false)
		}
		return nil, core.Errorf(core.CodeInternal, "The vault is damaged").WithCause(err)
	}
	return ident, nil
}

// registerJob tracks a running job so lock can cancel it.
func (v *Vault) registerJob(ctx context.Context) (context.Context, func(), error) {
	v.mu.Lock()
	if v.idx == nil {
		v.mu.Unlock()
		return ctx, nil, errLocked
	}
	jctx, cancel := context.WithCancel(ctx)
	n := v.nextCancel
	v.nextCancel++
	v.cancels[n] = cancel
	v.active++
	v.mu.Unlock()
	return jctx, func() {
		cancel()
		v.mu.Lock()
		delete(v.cancels, n)
		v.active--
		if v.idx != nil {
			v.lastActive = v.now()
		}
		v.mu.Unlock()
	}, nil
}
