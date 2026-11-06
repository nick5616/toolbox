package lanshare

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/lan"
)

func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < 4; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTP"[exp])
}

// Run implements core.Module: drain an accepted session into the library, or
// save a received text.
func (r *Receiver) Run(ctx context.Context, job *core.JobContext) error {
	opts, err := core.DecodeOptions[ReceiveOptions](job)
	if err != nil {
		return err
	}
	if opts.Message != "" {
		return saveMessage(job, opts.Message)
	}
	sess, ok := shared.takeSession(opts.Session)
	if !ok {
		return core.Errorf(core.CodeNotFound, "That transfer isn't available any more").
			WithHint("Ask the other device to send again")
	}
	err = r.receive(ctx, job, sess)
	sess.Finished(err)
	return err
}

func (r *Receiver) receive(ctx context.Context, job *core.JobContext, sess lan.IncomingSession) (err error) {
	from := sess.From()
	alias := safeComponent(from.Alias)
	if alias == "" || alias == "file" {
		alias = "Unknown device"
	}
	total := sess.TotalBytes()
	count := len(sess.Files())
	job.SetTitle(fmt.Sprintf("From %s · %s", from.Alias, plural(count, "file")))
	job.Progress(core.IndeterminateProgress, "Waiting for files from "+from.Alias+"…")

	// Cancelling the job cancels the session so the sender's next request fails.
	stop := make(chan struct{})
	defer close(stop)
	defer func() {
		if ctx.Err() != nil {
			sess.Cancel() // the watcher below may not have run yet
		}
	}()
	go func() {
		select {
		case <-ctx.Done():
			sess.Cancel()
		case <-stop:
		}
	}()

	var done int64
	var files int
	defer func() {
		if r.rt == nil {
			return
		}
		switch {
		case err == nil:
			r.rt.AddActivity(fmt.Sprintf("Received %s from %s (%s)", plural(files, "file"), from.Alias, formatBytes(done)))
		case ctx.Err() != nil:
			r.rt.AddActivity("Transfer from " + from.Alias + " cancelled")
		default:
			r.rt.AddActivity("Transfer from " + from.Alias + " didn't finish")
		}
	}()

	root := filepath.Join(job.OutputDir, alias)
	for n := 0; ; n++ {
		fsr, nerr := sess.Next(ctx)
		if errors.Is(nerr, io.EOF) {
			break
		}
		if nerr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("waiting for the next file: %w", nerr)
		}
		size, ferr := storeFile(ctx, job, root, n, fsr, func(delta int64) {
			done += delta
			if total > 0 {
				job.Progress(min(float64(done)/float64(total), 1), fmt.Sprintf("Receiving from %s · %s of %s", from.Alias, formatBytes(done), formatBytes(total)))
			}
		})
		if ferr != nil {
			fsr.Done(ferr)
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return ferr
		}
		_ = size
		fsr.Done(nil)
		files++
	}
	job.Progress(1, fmt.Sprintf("Received %s from %s", plural(files, "file"), from.Alias))
	return job.SetResult(ReceiveJobResult{From: from.Alias, Files: files, Bytes: done})
}

// storeFile writes one incoming file to the job's TempDir and moves it to its
// unique place under root; it registers the result as an output.
func storeFile(ctx context.Context, job *core.JobContext, root string, n int, fsr lan.FileStream, progress func(int64)) (int64, error) {
	comps := splitRel(fsr.File.RelPath)
	dest := root
	for _, c := range comps {
		dest = filepath.Join(dest, c)
	}
	if !withinDir(root, dest) {
		return 0, core.Errorf(core.CodeValidation, "A file name wasn't safe to use")
	}

	part := filepath.Join(job.TempDir, fmt.Sprintf("%d.part", n))
	f, err := os.Create(part)
	if err != nil {
		return 0, fmt.Errorf("create temporary file: %w", err)
	}
	size, cerr := copyBody(ctx, f, fsr.Body, progress)
	if clerr := f.Close(); cerr == nil {
		cerr = clerr
	}
	if cerr != nil {
		_ = os.Remove(part)
		return size, fmt.Errorf("receive %s: %w", comps[len(comps)-1], cerr)
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return size, fmt.Errorf("create folder: %w", err)
	}
	final, err := reserveUnique(dest)
	if err != nil {
		return size, err
	}
	if err := moveFile(part, final); err != nil {
		_ = os.Remove(final)
		return size, fmt.Errorf("move received file into place: %w", err)
	}
	if fsr.File.Modified > 0 {
		_ = os.Chtimes(final, time.Time{}, time.UnixMilli(fsr.File.Modified))
	}
	if _, err := job.Output(final); err != nil {
		return size, fmt.Errorf("register received file: %w", err)
	}
	return size, nil
}

func copyBody(ctx context.Context, dst io.Writer, src io.Reader, progress func(int64)) (int64, error) {
	buf := make([]byte, 256<<10)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		nr, rerr := src.Read(buf)
		if nr > 0 {
			nw, werr := dst.Write(buf[:nr])
			written += int64(nw)
			progress(int64(nw))
			if werr != nil {
				return written, werr
			}
		}
		if rerr == io.EOF {
			return written, nil
		}
		if rerr != nil {
			return written, rerr
		}
	}
}

// moveFile renames, falling back to copy+remove across volumes.
func moveFile(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = os.Remove(from)
	return nil
}

// reserveUnique creates an empty file at path, or at "name (2).ext", "name
// (3).ext"… when taken, and returns the path. It never overwrites.
func reserveUnique(path string) (string, error) {
	dir, base := filepath.Split(path)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 1; i < 10000; i++ {
		cand := path
		if i > 1 {
			cand = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		}
		f, err := os.OpenFile(cand, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			_ = f.Close()
			return cand, nil
		}
		if !os.IsExist(err) {
			return "", fmt.Errorf("create %s: %w", filepath.Base(cand), err)
		}
	}
	return "", core.Errorf(core.CodeConflict, "Too many files named %s", base)
}

// splitRel splits a "/"-separated relative path into safe components (never empty).
func splitRel(rel string) []string {
	var comps []string
	for _, c := range strings.Split(strings.ReplaceAll(rel, "\\", "/"), "/") {
		if c == "" || c == "." || c == ".." {
			continue
		}
		comps = append(comps, safeComponent(c))
	}
	if len(comps) == 0 {
		return []string{"file"}
	}
	return comps
}

var reserved = map[string]bool{"con": true, "prn": true, "aux": true, "nul": true}

// safeComponent makes one path component safe on Windows, macOS and Linux.
func safeComponent(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x20 || r == 0x7f, strings.ContainsRune(`<>:"|?*\/`, r):
		case r == utf8.RuneError:
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), " .")
	if out == "" {
		return "file"
	}
	// Windows reserves a name by what comes before its first dot.
	head, tail := out, ""
	if i := strings.IndexByte(out, '.'); i >= 0 {
		head, tail = out[:i], out[i:]
	}
	stem := strings.ToLower(head)
	isReserved := reserved[stem]
	if len(stem) == 4 && (strings.HasPrefix(stem, "com") || strings.HasPrefix(stem, "lpt")) && stem[3] >= '1' && stem[3] <= '9' {
		isReserved = true
	}
	if isReserved {
		out = head + "_" + tail
	}
	if len(out) > 255 {
		out = out[:255]
		for !utf8.ValidString(out) {
			out = out[:len(out)-1]
		}
	}
	return out
}

func withinDir(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..")
}

// saveMessage writes a received text to <OutputDir>/<alias>/Message <date>.txt.
func saveMessage(job *core.JobContext, id string) error {
	msg, ok := shared.takeMessage(id)
	if !ok {
		return core.Errorf(core.CodeNotFound, "That message isn't available any more")
	}
	alias := safeComponent(msg.Alias)
	if alias == "file" {
		alias = "Unknown device"
	}
	at := time.UnixMilli(msg.At)
	if msg.At == 0 {
		at = time.Now()
	}
	dir := filepath.Join(job.OutputDir, alias)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create folder: %w", err)
	}
	path, err := reserveUnique(filepath.Join(dir, "Message "+at.Format("2006-01-02 15-04")+".txt"))
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(msg.Text), 0o644); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("write message: %w", err)
	}
	job.SetTitle("Message from " + msg.Alias)
	if _, err := job.Output(path); err != nil {
		return fmt.Errorf("register message: %w", err)
	}
	return nil
}
