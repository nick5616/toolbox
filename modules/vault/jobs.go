package vault

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"filippo.io/age"

	"toolbox/core"
)

func (v *Vault) validate(inputs []string, options json.RawMessage) error {
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if _, _, _, err := v.unlockedSnapshot(); err != nil {
		return err
	}
	switch o.Action {
	case ActionAdd:
		if _, err := cleanFolder(o.Folder); err != nil {
			return err
		}
		if len(inputs) == 0 {
			return core.ValidationError("Choose files to add", map[string]string{"inputs": "Choose files to add"})
		}
		for _, in := range inputs {
			fi, err := os.Stat(in)
			if err != nil {
				return core.ValidationError("A file couldn't be read", map[string]string{"inputs": "A file couldn't be read"}).WithCause(err)
			}
			if !fi.Mode().IsRegular() {
				return core.ValidationError("Folders can't be added. Choose files", map[string]string{"inputs": "Choose files, not folders"})
			}
			if fi.Size() > maxAddBytes {
				return core.ValidationError("Files over 20 GB can't be added", map[string]string{"inputs": "Files over 20 GB can't be added"})
			}
		}
	case ActionExport:
		if len(o.IDs) == 0 {
			return core.ValidationError("Choose files to export", map[string]string{"ids": "Choose files to export"})
		}
		for _, id := range o.IDs {
			if _, err := v.entry(id); err != nil {
				return err
			}
		}
	default:
		return core.ValidationError("Unknown vault action", map[string]string{"action": "Must be add or export"})
	}
	return nil
}

func (v *Vault) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	jctx, done, err := v.registerJob(ctx)
	if err != nil {
		return err
	}
	defer done()
	switch o.Action {
	case ActionAdd:
		err = v.runAdd(jctx, job, o)
	case ActionExport:
		err = v.runExport(jctx, job, o)
	default:
		return core.ValidationError("Unknown vault action", nil)
	}
	if err != nil && jctx.Err() != nil && ctx.Err() == nil {
		return errLocked // cancelled by lock
	}
	return err
}

func (v *Vault) runAdd(ctx context.Context, job *core.JobContext, o Options) error {
	folder, err := cleanFolder(o.Folder)
	if err != nil {
		return err
	}
	ident, dir, _, err := v.unlockedSnapshot()
	if err != nil {
		return err
	}
	var total int64
	for _, in := range job.Inputs {
		fi, err := os.Stat(in)
		if err != nil {
			return core.ValidationError("A file couldn't be read", nil).WithCause(err)
		}
		if fi.Size() > maxAddBytes {
			return core.ValidationError("Files over 20 GB can't be added", nil)
		}
		total += fi.Size()
	}
	job.SetTitle(fmt.Sprintf("Add %d file(s) to the vault", len(job.Inputs)))
	var done int64
	for i, in := range job.Inputs {
		if err := ctx.Err(); err != nil {
			return err
		}
		job.Progress(fraction(done, total), fmt.Sprintf("Encrypting %d of %d", i+1, len(job.Inputs)))
		base := done
		e, err := v.addOne(ctx, dir, ident.Recipient(), in, folder, func(n int64) {
			job.Progress(fraction(base+n, total), fmt.Sprintf("Encrypting %d of %d", i+1, len(job.Inputs)))
		})
		if err != nil {
			return err
		}
		done += e
		v.touch()
	}
	job.Progress(1, "Done")
	return nil
}

func fraction(done, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return float64(done) / float64(total)
}

// addOne encrypts one file into a blob and records it in the index. It
// returns the plaintext bytes processed.
func (v *Vault) addOne(ctx context.Context, dir string, rec age.Recipient, src, folder string, onBytes func(n int64)) (int64, error) {
	f, err := os.Open(src)
	if err != nil {
		return 0, core.ValidationError("A file couldn't be read", nil).WithCause(err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return 0, err
	}
	blobID := core.NewID()
	rel := path.Join(dirBlobs, blobID[len(blobID)-2:], blobID+".age")
	full := blobPath(dir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
		return 0, fmt.Errorf("create vault folder: %w", err)
	}
	tmp := full + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, fmt.Errorf("create vault file: %w", err)
	}
	fail := func(err error) (int64, error) {
		out.Close()
		os.Remove(tmp)
		return 0, err
	}
	w, err := age.Encrypt(out, rec)
	if err != nil {
		return fail(err)
	}
	h := sha256.New()
	var n int64
	cr := &ctxReader{ctx: ctx, r: io.TeeReader(f, h), onBytes: func(k int) {
		n += int64(k)
		onBytes(n)
	}}
	if _, err := io.CopyBuffer(w, cr, make([]byte, 1<<20)); err != nil {
		return fail(err)
	}
	if err := w.Close(); err != nil {
		return fail(err)
	}
	if err := out.Sync(); err != nil {
		return fail(err)
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	if err := os.Rename(tmp, full); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	entry := indexEntry{
		Entry: Entry{
			ID: core.NewID(), Name: filepath.Base(src), Folder: folder, Size: n,
			ModTime: fi.ModTime().UnixMilli(), AddedAt: core.NowMillis(),
		},
		Blob: rel, SHA256: hex.EncodeToString(h.Sum(nil)),
	}
	err = v.mutate(func(ix *index) error {
		entry.Name = uniqueName(ix, folder, entry.Name, "")
		ix.Entries = append(ix.Entries, entry)
		return nil
	})
	if err != nil {
		os.Remove(full)
		return 0, err
	}
	return n, nil
}

func (v *Vault) runExport(ctx context.Context, job *core.JobContext, o Options) error {
	ident, dir, _, err := v.unlockedSnapshot()
	if err != nil {
		return err
	}
	var entries []indexEntry
	var total int64
	for _, id := range o.IDs {
		e, err := v.entry(id)
		if err != nil {
			return err
		}
		entries = append(entries, e)
		total += e.Size
	}
	job.SetTitle(fmt.Sprintf("Export %d file(s) from the vault", len(entries)))
	var done int64
	for i, e := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		stem, ext := splitExt(sanitizeFileName(e.Name))
		f, outPath, err := createUnique(job.OutputDir, stem, ext)
		if err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't create the exported file").WithCause(err)
		}
		base := done
		var seen int64
		derr := decryptBlob(ctx, blobPath(dir, e.Blob), ident, e.SHA256, f, func(n int) {
			seen += int64(n)
			job.Progress(fraction(base+seen, total), fmt.Sprintf("Decrypting %d of %d", i+1, len(entries)))
		})
		cerr := f.Close()
		if derr == nil {
			derr = cerr
		}
		if derr != nil {
			os.Remove(outPath)
			return derr
		}
		done += e.Size
		if _, err := job.Output(outPath); err != nil {
			return err
		}
		v.touch()
	}
	job.Progress(1, "Done")
	return nil
}

// createUnique creates dir/<stem><ext> (or " (n)") exclusively.
func createUnique(dir, stem, ext string) (*os.File, string, error) {
	for range 100 {
		p := core.UniquePath(dir, stem, ext)
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			return f, p, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, "", err
		}
	}
	return nil, "", fmt.Errorf("no free name for %s", strings.TrimSpace(stem))
}
