package devutils

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"toolbox/core"
)

// The pipeline actions (Phase 14): Checksums and Encode write files.

// checkActionOptions validates the options of the job's action.
func checkActionOptions(o Options, inputs []string) error {
	switch o.Action {
	case "", ActionHash:
		return checkAlgorithms(o.Algorithms)
	case ActionChecksums:
		if err := checkAlgorithms(o.Algorithms); err != nil {
			return err
		}
		switch o.Format {
		case "", FormatSidecar, FormatCSV:
		default:
			return core.ValidationError("Some options are invalid", map[string]string{"format": "Choose a .sha256 file or a CSV"})
		}
	case ActionEncode:
		switch o.Encoding {
		case "", EncodingBase64, EncodingHex:
		default:
			return core.ValidationError("Some options are invalid", map[string]string{"encoding": "Choose Base64 or hex"})
		}
		for _, p := range inputs {
			if err := checkEncodable(p); err != nil {
				return err
			}
		}
	default:
		return core.ValidationError("Some options are invalid", map[string]string{"action": fmt.Sprintf("Unknown action %q", o.Action)})
	}
	return nil
}

// checkEncodable refuses folders and files over the Base64 cap.
func checkEncodable(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		return core.Errorf(core.CodeNotFound, "Can't read %s", filepath.Base(path)).WithCause(err)
	}
	if !st.Mode().IsRegular() {
		return core.ValidationError(filepath.Base(path)+" isn't a file", nil)
	}
	if st.Size() > maxBase64Bytes {
		return core.ValidationError(filepath.Base(path)+" is larger than 10 MiB", nil).
			WithHint("Encoding is for small files; use Checksums for big ones.")
	}
	return nil
}

// cleanStem makes s safe as a file name stem on Windows and macOS.
func cleanStem(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x20 || r == 0x7f, strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteRune('-')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	if r := []rune(out); len(r) > 150 {
		out = string(r[:150])
	}
	return strings.TrimRight(out, " .")
}

// writeNew writes data to a path in dir that doesn't exist yet.
func writeNew(dir, stem, ext string, data []byte) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("creating %s: %w", dir, err)
	}
	for range 1000 {
		p := core.UniquePath(dir, stem, ext)
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("creating %s: %w", filepath.Base(p), err)
		}
		_, werr := f.Write(data)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			_ = os.Remove(p)
			return "", fmt.Errorf("writing %s: %w", filepath.Base(p), werr)
		}
		return p, nil
	}
	return "", fmt.Errorf("no free name for %s%s", stem, ext)
}

func register(job *core.JobContext, path string) error {
	if _, err := job.Output(path); err != nil {
		return fmt.Errorf("register %s: %w", filepath.Base(path), err)
	}
	return nil
}

func runChecksums(ctx context.Context, job *core.JobContext, o Options) error {
	res, err := hashAll(ctx, job, o.Algorithms, 0.9)
	if err != nil {
		return err
	}
	stem := cleanStem(o.Name)
	if stem == "" {
		if len(job.Inputs) == 1 {
			stem = cleanStem(filepath.Base(job.Inputs[0]))
		}
		if stem == "" {
			stem = "checksums"
		}
	}
	var written []string
	if o.Format == FormatCSV {
		var sb strings.Builder
		w := csv.NewWriter(&sb)
		header := append([]string{"file", "size"}, o.Algorithms...)
		if err := w.Write(header); err != nil {
			return fmt.Errorf("writing the CSV: %w", err)
		}
		for _, f := range res.Files {
			row := []string{filepath.Base(f.Path), strconv.FormatInt(f.Size, 10)}
			for _, a := range o.Algorithms {
				row = append(row, f.Hashes[a])
			}
			if err := w.Write(row); err != nil {
				return fmt.Errorf("writing the CSV: %w", err)
			}
		}
		w.Flush()
		if err := w.Error(); err != nil {
			return fmt.Errorf("writing the CSV: %w", err)
		}
		p, err := writeNew(job.OutputDir, stem, ".csv", []byte(sb.String()))
		if err != nil {
			return err
		}
		written = append(written, p)
	} else {
		for _, a := range o.Algorithms {
			var sb strings.Builder
			for _, f := range res.Files {
				fmt.Fprintf(&sb, "%s  %s\n", f.Hashes[a], filepath.Base(f.Path)) // sha256sum -c format
			}
			p, err := writeNew(job.OutputDir, stem, "."+a, []byte(sb.String()))
			if err != nil {
				return err
			}
			written = append(written, p)
		}
	}
	for _, p := range written {
		if err := register(job, p); err != nil {
			return err
		}
	}
	job.Progress(1, "Done")
	return job.SetResult(res)
}

func runEncode(ctx context.Context, job *core.JobContext, o Options) error {
	enc, ext := o.Encoding, ".base64.txt"
	if enc == EncodingHex {
		ext = ".hex.txt"
	}
	job.SetTitle(fmt.Sprintf("Encoding %d files", len(job.Inputs)))
	n := len(job.Inputs)
	for i, in := range job.Inputs {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("encoding cancelled: %w", err)
		}
		job.Progress(float64(i)/float64(n), fmt.Sprintf("Encoding %d of %d", i+1, n))
		data, err := os.ReadFile(in)
		if err != nil {
			return core.Errorf(core.CodeNotFound, "Can't read %s", filepath.Base(in)).WithCause(err)
		}
		if len(data) > maxBase64Bytes {
			return core.ValidationError(filepath.Base(in)+" is larger than 10 MiB", nil)
		}
		var text string
		if enc == EncodingHex {
			text = hex.EncodeToString(data)
		} else {
			text = base64.StdEncoding.EncodeToString(data)
		}
		stem := cleanStem(filepath.Base(in))
		if stem == "" {
			stem = "encoded"
		}
		p, err := writeNew(job.OutputDir, stem, ext, []byte(text))
		if err != nil {
			return err
		}
		if err := register(job, p); err != nil {
			return err
		}
	}
	job.Progress(1, "Done")
	return nil
}
