package vault

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"filippo.io/age"

	"toolbox/core"
)

// On-disk layout (SPEC.md §6.1), relative to <library>/Vault.
const (
	fileMeta     = "vault.json"
	fileIdentity = "identity.age"
	fileIndex    = "index.age"
	fileIndexBak = "index.age.bak"
	dirBlobs     = "blobs"

	defaultWorkFactor = 18
	maxWorkFactor     = 22

	maxAddBytes     = int64(20) << 30 // files over 20 GB are refused
	maxPreviewBytes = int64(20) << 20 // images over 20 MB aren't previewed
	minPassphrase   = 8
	recoveryPrefix  = "AGE-SECRET-KEY-1"
	indexVersion    = 1
)

// meta is vault.json (plaintext, no secrets).
type meta struct {
	Format     int    `json:"format"`
	Created    int64  `json:"created"`
	KDF        string `json:"kdf"`
	WorkFactor int    `json:"workFactor"`
}

// indexEntry is an Entry plus the private storage fields.
type indexEntry struct {
	Entry
	Blob   string `json:"blob"` // slash-separated, relative to the vault dir
	SHA256 string `json:"sha256"`
}

// index is the decrypted index.age.
type index struct {
	Version int          `json:"version"`
	Entries []indexEntry `json:"entries"`
}

func (ix *index) clone() *index {
	return &index{Version: ix.Version, Entries: append([]indexEntry{}, ix.Entries...)}
}

func (ix *index) find(id string) int {
	for i := range ix.Entries {
		if ix.Entries[i].ID == id {
			return i
		}
	}
	return -1
}

var (
	errWrongKey = errors.New("wrong passphrase or key")

	errLocked  = core.ValidationError("The vault is locked", nil)
	errDamaged = core.Errorf(core.CodeInternal, "This file is damaged in the vault").
			WithHint("Export your other files, then restore this one from a backup")
)

func errNotFound() error {
	return core.Errorf(core.CodeNotFound, "That file isn't in the vault")
}

func readMeta(dir string) (meta, error) {
	var m meta
	b, err := os.ReadFile(filepath.Join(dir, fileMeta))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("read vault.json: %w", err)
	}
	if m.Format != 1 || m.WorkFactor < 1 || m.WorkFactor > maxWorkFactor {
		return m, core.Errorf(core.CodeInternal, "This vault was made by a newer version of Toolbox")
	}
	return m, nil
}

// writeFileAtomic writes data to path via a synced temp file and a rename.
func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func encryptBytes(data []byte, r age.Recipient) ([]byte, error) {
	var buf bytes.Buffer
	w, err := age.Encrypt(&buf, r)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// decryptBytes maps "no identity matched" to errWrongKey.
func decryptBytes(data []byte, id age.Identity, limit int64) ([]byte, error) {
	r, err := age.Decrypt(bytes.NewReader(data), id)
	if err != nil {
		var nm *age.NoIdentityMatchError
		if errors.As(err, &nm) {
			return nil, errWrongKey
		}
		return nil, err
	}
	out, err := io.ReadAll(io.LimitReader(r, limit))
	if err != nil {
		return nil, err
	}
	return out, nil
}

// sealIdentity encrypts the identity string to the passphrase.
func sealIdentity(identity *age.X25519Identity, pass string, workFactor int) ([]byte, error) {
	rec, err := age.NewScryptRecipient(pass)
	if err != nil {
		return nil, err
	}
	rec.SetWorkFactor(workFactor)
	return encryptBytes([]byte(identity.String()), rec)
}

// openIdentity decrypts identity.age with the passphrase.
func openIdentity(data []byte, pass string, workFactor int) (*age.X25519Identity, error) {
	si, err := age.NewScryptIdentity(pass)
	if err != nil {
		return nil, err
	}
	si.SetMaxWorkFactor(workFactor)
	b, err := decryptBytes(data, si, 4096)
	if err != nil {
		return nil, err
	}
	return age.ParseX25519Identity(string(bytes.TrimSpace(b)))
}

// saveIndex writes the index atomically, keeping the previous one as .bak.
func saveIndex(dir string, ix *index, rec age.Recipient) error {
	b, err := json.Marshal(ix)
	if err != nil {
		return err
	}
	enc, err := encryptBytes(b, rec)
	if err != nil {
		return err
	}
	cur := filepath.Join(dir, fileIndex)
	tmp := cur + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(enc); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	if _, err := os.Stat(cur); err == nil {
		if err := os.Rename(cur, filepath.Join(dir, fileIndexBak)); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, cur); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func loadIndexFile(path string, id age.Identity) (*index, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	plain, err := decryptBytes(b, id, 1<<30)
	if err != nil {
		return nil, err
	}
	var ix index
	if err := json.Unmarshal(plain, &ix); err != nil {
		return nil, err
	}
	if ix.Version != indexVersion {
		return nil, fmt.Errorf("unsupported index version %d", ix.Version)
	}
	if ix.Entries == nil {
		ix.Entries = []indexEntry{}
	}
	return &ix, nil
}

// loadIndex reads index.age, falling back to the .bak copy (usedBak = true).
// errWrongKey is returned when the identity opens neither file.
func loadIndex(dir string, id age.Identity) (ix *index, usedBak bool, err error) {
	ix, err = loadIndexFile(filepath.Join(dir, fileIndex), id)
	if err == nil {
		return ix, false, nil
	}
	if errors.Is(err, errWrongKey) {
		return nil, false, err
	}
	bak, bakErr := loadIndexFile(filepath.Join(dir, fileIndexBak), id)
	if bakErr == nil {
		return bak, true, nil
	}
	if errors.Is(bakErr, errWrongKey) {
		return nil, false, bakErr
	}
	return nil, false, core.Errorf(core.CodeInternal, "The vault index is damaged").WithCause(err)
}

// ctxReader aborts reads when ctx is done and reports bytes read.
type ctxReader struct {
	ctx     context.Context
	r       io.Reader
	onBytes func(n int)
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := c.r.Read(p)
	if n > 0 && c.onBytes != nil {
		c.onBytes(n)
	}
	return n, err
}

// errWriter remembers the first write error so decrypt errors and
// destination errors can be told apart.
type errWriter struct {
	w   io.Writer
	err error
}

func (e *errWriter) Write(p []byte) (int, error) {
	n, err := e.w.Write(p)
	if err != nil && e.err == nil {
		e.err = err
	}
	return n, err
}

// decryptBlob streams a blob into dst and verifies the plaintext sha256.
// Any decrypt, authentication or checksum failure is errDamaged.
func decryptBlob(ctx context.Context, path string, id age.Identity, wantSHA string, dst io.Writer, onBytes func(int)) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return errDamaged
		}
		return fmt.Errorf("open vault file: %w", err)
	}
	defer f.Close()
	r, err := age.Decrypt(f, id)
	if err != nil {
		return errDamaged
	}
	h := sha256.New()
	ew := &errWriter{w: io.MultiWriter(dst, h)}
	buf := make([]byte, 256<<10)
	if _, err := io.CopyBuffer(ew, &ctxReader{ctx: ctx, r: r, onBytes: onBytes}, buf); err != nil {
		if ew.err != nil {
			return fmt.Errorf("write decrypted file: %w", ew.err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errDamaged
	}
	if hex.EncodeToString(h.Sum(nil)) != wantSHA {
		return errDamaged
	}
	return nil
}
