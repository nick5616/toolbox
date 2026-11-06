package lanshare

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/lan"
)

// rescanTimeout bounds the one rescan a send makes for an unreachable device.
const rescanTimeout = 10 * time.Second

func offlineError(alias string) *core.AppError {
	return core.Errorf(lan.CodeOffline, "%s isn't on this network right now", alias).
		WithHint("Open Toolbox or LocalSend on it and make sure it's receiving")
}

// Run implements core.Module: send the inputs (and text) to one device.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	if m.rt == nil {
		return core.Errorf(core.CodeInternal, "Local File Transfer isn't available")
	}
	opts, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	dev, ok := m.rt.Device(opts.Device)
	if !ok {
		return core.ValidationError("That device isn't known any more. Refresh the list and pick it again", map[string]string{"device": "Pick a device"})
	}
	alias := dev.Alias
	if dev.Protocol == "http" {
		return core.Errorf(lan.CodeEncryptionOff, "Encryption is off on %s", alias).
			WithHint("Turn on Encryption in LocalSend's settings on that device")
	}

	job.SetTitle("To " + alias)
	job.Progress(core.IndeterminateProgress, "Connecting to "+alias+"…")
	dev, err = m.resolve(ctx, dev)
	if err != nil {
		return err
	}

	files, err := expandInputs(ctx, job.Inputs)
	if err != nil {
		return err
	}
	if len(files) == 0 && opts.Text == "" {
		return core.ValidationError("There are no files to send", map[string]string{"inputs": "There are no files to send"})
	}
	var total int64
	for _, f := range files {
		total += f.Size
	}
	switch {
	case len(files) == 0:
		job.SetTitle("To " + alias + " · message")
	default:
		job.SetTitle(fmt.Sprintf("To %s · %s", alias, plural(len(files), "file")))
	}

	pin := ""
	if opts.PinRef != "" {
		pin = shared.pin(opts.PinRef)
	}
	req := lan.SendRequest{Device: dev, Files: files, Text: opts.Text, PIN: pin}
	res, err := m.rt.Send(ctx, req, func(p lan.SendProgress) {
		switch p.Stage {
		case "waiting":
			job.Progress(core.IndeterminateProgress, "Waiting for "+alias+" to accept…")
		case "connecting":
			job.Progress(core.IndeterminateProgress, "Connecting to "+alias+"…")
		default:
			if p.Total <= 0 {
				job.Progress(core.IndeterminateProgress, "Sending to "+alias+"…")
				return
			}
			msg := fmt.Sprintf("Sending to %s · %s of %s", alias, formatBytes(p.Done), formatBytes(p.Total))
			if p.FileCount > 1 {
				msg = fmt.Sprintf("Sending to %s · file %d of %d · %s of %s", alias, min(p.FileIndex+1, p.FileCount), p.FileCount, formatBytes(p.Done), formatBytes(p.Total))
			}
			job.Progress(float64(p.Done)/float64(p.Total), msg)
		}
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return mapSendError(alias, err)
	}
	if opts.PinRef != "" {
		shared.dropPIN(opts.PinRef)
	}
	if res.Files == 0 && !res.AsMessage {
		res.Files = len(files)
	}
	if res.Bytes == 0 && !res.AsMessage {
		res.Bytes = total
	}
	job.Progress(1, doneMessage(alias, res))
	m.rt.AddActivity(doneMessage(alias, res))
	return job.SetResult(SendJobResult{Device: alias, Fingerprint: dev.Fingerprint, Files: res.Files, Bytes: res.Bytes, AsMessage: res.AsMessage})
}

func doneMessage(alias string, res lan.SendResult) string {
	if res.AsMessage {
		return "Delivered to " + alias + " as a message"
	}
	return fmt.Sprintf("Sent %s to %s", plural(res.Files, "file"), alias)
}

// resolve probes the device and, when it can't be reached, rescans once.
func (m *Module) resolve(ctx context.Context, dev lan.Device) (lan.Device, error) {
	probed, err := m.rt.Probe(ctx, dev.Fingerprint)
	if err == nil {
		return probed, nil
	}
	if cerr := ctx.Err(); cerr != nil {
		return dev, cerr
	}
	if ae := core.AsAppError(err); ae.Code == lan.CodeWrongDevice || ae.Code == lan.CodeEncryptionOff {
		return dev, err
	}
	sctx, cancel := context.WithTimeout(ctx, rescanTimeout)
	m.rt.Scan(sctx)
	cancel()
	if cerr := ctx.Err(); cerr != nil {
		return dev, cerr
	}
	probed, err = m.rt.Probe(ctx, dev.Fingerprint)
	if err == nil {
		return probed, nil
	}
	if cerr := ctx.Err(); cerr != nil {
		return dev, cerr
	}
	if ae := core.AsAppError(err); ae.Code == lan.CodeWrongDevice || ae.Code == lan.CodeEncryptionOff {
		return dev, err
	}
	return dev, offlineError(dev.Alias).WithCause(err)
}

// mapSendError turns what the runtime returned into a message naming the device.
func mapSendError(alias string, err error) error {
	var ae *core.AppError
	if !errors.As(err, &ae) {
		return core.Errorf(core.CodeToolFailed, "Couldn't send to %s", alias).WithCause(err)
	}
	switch ae.Code {
	case lan.CodeDeclined:
		return core.Errorf(lan.CodeDeclined, "%s declined", alias).WithCause(err)
	case lan.CodeBusy:
		return core.Errorf(lan.CodeBusy, "%s is busy with another transfer", alias).WithHint("Try again in a moment").WithCause(err)
	case lan.CodeOffline:
		return offlineError(alias).WithCause(err)
	case lan.CodePinRequired:
		out := core.Errorf(lan.CodePinRequired, "%s needs a PIN", alias).WithHint("Enter the PIN shown in that device's settings").WithCause(err)
		out.Fields = map[string]string{"pin": "Enter the PIN"}
		if ae.Message != "" && len(ae.Fields) > 0 {
			out.Fields = ae.Fields
		}
		return out
	case lan.CodeTooLarge:
		return core.Errorf(lan.CodeTooLarge, "%s doesn't have room for these files", alias).WithCause(err)
	}
	return err
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// expandInputs turns files and folders into SendFiles. A folder's files keep
// their relative paths under the folder's name; hidden and system files and
// folders and symlinks inside folders are skipped. A file named directly is
// sent even when hidden.
func expandInputs(ctx context.Context, inputs []string) ([]lan.SendFile, error) {
	var out []lan.SendFile
	add := func(f lan.SendFile) error {
		out = append(out, f)
		if len(out) > lan.MaxFilesPerSess {
			return core.ValidationError(fmt.Sprintf("That's more than %d files. Send a smaller folder at a time", lan.MaxFilesPerSess), nil)
		}
		return nil
	}
	for _, in := range inputs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		st, err := os.Stat(in)
		if err != nil {
			return nil, core.ValidationError("File or folder not found: "+filepath.Base(in), nil).WithCause(err)
		}
		if !st.IsDir() {
			if !st.Mode().IsRegular() {
				continue
			}
			if err := add(lan.SendFile{Path: filepath.Clean(in), RelPath: filepath.Base(in), Size: st.Size(), Type: mimeType(in)}); err != nil {
				return nil, err
			}
			continue
		}
		root := filepath.Clean(in)
		top := filepath.Base(root)
		var folder []lan.SendFile
		err = filepath.WalkDir(root, func(p string, d fs.DirEntry, werr error) error {
			if werr != nil {
				if p == root {
					return werr
				}
				return nil // unreadable entries are skipped
			}
			if cerr := ctx.Err(); cerr != nil {
				return cerr
			}
			if p == root {
				return nil
			}
			if skipName(d.Name()) || systemEntry(p, d) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() || !d.Type().IsRegular() {
				return nil // symlinks and special files are skipped
			}
			info, ierr := d.Info()
			if ierr != nil {
				return nil
			}
			rel, rerr := filepath.Rel(root, p)
			if rerr != nil {
				return nil
			}
			folder = append(folder, lan.SendFile{Path: p, RelPath: top + "/" + filepath.ToSlash(rel), Size: info.Size(), Type: mimeType(p)})
			return nil
		})
		if err != nil {
			return nil, err
		}
		sort.Slice(folder, func(i, j int) bool { return folder[i].RelPath < folder[j].RelPath })
		for _, f := range folder {
			if err := add(f); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

var junk = map[string]bool{"thumbs.db": true, "desktop.ini": true, ".ds_store": true, "ehthumbs.db": true}

// skipName reports whether a file or folder name is hidden or system clutter.
func skipName(name string) bool {
	return strings.HasPrefix(name, ".") || junk[strings.ToLower(name)]
}

// mimeType guesses a MIME type from the extension.
func mimeType(path string) string {
	t := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if i := strings.IndexByte(t, ';'); i >= 0 {
		t = t[:i]
	}
	if t == "" {
		return "application/octet-stream"
	}
	return t
}
