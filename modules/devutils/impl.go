package devutils

import (
	"context"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"hash/crc32"
	"io"
	"os"
	"slices"

	"toolbox/core"
)

const (
	maxInputs      = 100
	readChunk      = 1 << 20  // 1 MiB
	maxBase64Bytes = 10 << 20 // 10 MiB
)

func newHash(algo string) hash.Hash {
	switch algo {
	case AlgoMD5:
		return md5.New()
	case AlgoSHA1:
		return sha1.New()
	case AlgoSHA256:
		return sha256.New()
	case AlgoSHA512:
		return sha512.New()
	case AlgoCRC32:
		return crc32.NewIEEE()
	}
	return nil
}

// checkAlgorithms validates the algorithm list: ≥ 1, known, no duplicates.
func checkAlgorithms(algos []string) error {
	if len(algos) == 0 {
		return core.ValidationError("Some options are invalid", map[string]string{"algorithms": "Choose at least one algorithm"})
	}
	known := AllAlgorithms()
	seen := map[string]bool{}
	for _, a := range algos {
		if !slices.Contains(known, a) {
			return core.ValidationError("Some options are invalid", map[string]string{"algorithms": fmt.Sprintf("Unknown algorithm %q", a)})
		}
		if seen[a] {
			return core.ValidationError("Some options are invalid", map[string]string{"algorithms": fmt.Sprintf("%s is listed twice", a)})
		}
		seen[a] = true
	}
	return nil
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if len(inputs) == 0 {
		return core.ValidationError("Add at least one file", nil)
	}
	if len(inputs) > maxInputs {
		return core.ValidationError(fmt.Sprintf("At most %d files at a time", maxInputs), nil)
	}
	fields := map[string]string{}
	for i, p := range inputs {
		st, err := os.Stat(p)
		switch {
		case err != nil:
			fields[fmt.Sprintf("inputs.%d", i)] = "File not found"
		case !st.Mode().IsRegular():
			fields[fmt.Sprintf("inputs.%d", i)] = "Not a regular file"
		}
	}
	if len(fields) > 0 {
		return core.ValidationError("Some files can't be hashed", fields)
	}
	return checkAlgorithms(opts.Algorithms)
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if err := checkAlgorithms(opts.Algorithms); err != nil {
		return err
	}
	var total int64
	for _, p := range job.Inputs {
		st, err := os.Stat(p)
		if err != nil {
			return core.Errorf(core.CodeNotFound, "Can't read %s", p).WithCause(err)
		}
		total += st.Size()
	}
	job.SetTitle(fmt.Sprintf("Hashing %d files", len(job.Inputs)))

	var done int64
	buf := make([]byte, readChunk)
	res := Result{Files: make([]FileHashes, 0, len(job.Inputs))}
	for _, p := range job.Inputs {
		fh, err := hashFile(ctx, p, opts.Algorithms, buf, func(n int64) {
			done += n
			if total > 0 {
				job.Progress(float64(done)/float64(total), fmt.Sprintf("%d of %d bytes", done, total))
			}
		})
		if err != nil {
			return err
		}
		res.Files = append(res.Files, fh)
	}
	job.Progress(1, "Done")
	return job.SetResult(res)
}

func hashFile(ctx context.Context, path string, algos []string, buf []byte, onBytes func(int64)) (FileHashes, error) {
	f, err := os.Open(path)
	if err != nil {
		return FileHashes{}, core.Errorf(core.CodeNotFound, "Can't open %s", path).WithCause(err)
	}
	defer f.Close()
	hashes := make([]hash.Hash, len(algos))
	writers := make([]io.Writer, len(algos))
	for i, a := range algos {
		hashes[i] = newHash(a)
		writers[i] = hashes[i]
	}
	mw := io.MultiWriter(writers...)
	var size int64
	for {
		if err := ctx.Err(); err != nil {
			return FileHashes{}, fmt.Errorf("hashing cancelled: %w", err)
		}
		n, rerr := f.Read(buf)
		if n > 0 {
			_, _ = mw.Write(buf[:n]) // hash writers never fail
			size += int64(n)
			onBytes(int64(n))
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return FileHashes{}, fmt.Errorf("reading %s: %w", path, rerr)
		}
	}
	out := FileHashes{Path: path, Size: size, Hashes: make(map[string]string, len(algos))}
	for i, a := range algos {
		// crc32's Sum is big-endian: 4 bytes = 8 hex digits.
		out.Hashes[a] = hex.EncodeToString(hashes[i].Sum(nil))
	}
	return out, nil
}

func hashText(text string) []HashResult {
	data := []byte(text)
	out := make([]HashResult, 0, 5)
	for _, a := range AllAlgorithms() {
		h := newHash(a)
		_, _ = h.Write(data)
		out = append(out, HashResult{Algorithm: a, Hex: hex.EncodeToString(h.Sum(nil))})
	}
	return out
}

func fileBase64(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "File not found").WithCause(err)
	}
	if !st.Mode().IsRegular() {
		return "", core.ValidationError("Choose a file, not a folder", nil)
	}
	if st.Size() > maxBase64Bytes {
		return "", core.ValidationError("File is larger than 10 MiB", nil).WithHint("Base64 here is for small files; use Hash for big ones.")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	if len(data) > maxBase64Bytes {
		return "", core.ValidationError("File is larger than 10 MiB", nil)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}
