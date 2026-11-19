package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"toolbox/core"
)

// loopbackClient talks to the local llama-server and Ollama. It ignores
// proxy environment variables on purpose: these requests never leave the PC.
var loopbackClient = &http.Client{Transport: &http.Transport{Proxy: nil}}

// downloadClient fetches model files from the internet (no overall timeout:
// models are gigabytes; cancellation goes through the context).
var downloadClient = &http.Client{Transport: &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	ResponseHeaderTimeout: 30 * time.Second,
	TLSHandshakeTimeout:   15 * time.Second,
}}

var errCorrupt = "The download was corrupted — try again"

// dlFile is one file a model needs: the GGUF or its projector.
type dlFile struct {
	name   string // for logs
	url    string
	final  string
	bytes  int64
	sha256 string
}

// files lists what e needs that isn't on disk yet (GGUF first).
func (c *Chat) missingFiles(e catalogEntry) []dlFile {
	var out []dlFile
	if !c.modelPresent(e.ID) {
		out = append(out, dlFile{name: e.File, url: c.modelURL(e), final: c.modelPath(e), bytes: e.Bytes, sha256: e.SHA256})
	}
	if e.MMProj != nil && !c.projectorPresent(e) {
		url := e.MMProjURL()
		if c.mmprojURL != nil {
			url = c.mmprojURL(e)
		}
		out = append(out, dlFile{name: e.MMProj.File, url: url, final: c.mmprojPath(e), bytes: e.MMProj.Bytes, sha256: e.MMProj.SHA256})
	}
	return out
}

// downloadModel fetches e (its GGUF and, for a model that can see, its
// projector) into <ModelsDir>/llm: each streamed to <file>.part with HTTP
// Range resume, sha256-verified, then renamed. One progress bar covers both.
// A no-op when everything is present.
func (c *Chat) downloadModel(ctx context.Context, job *core.JobContext, e catalogEntry) error {
	c.dlMu.Lock() // only one download at a time
	defer c.dlMu.Unlock()
	files := c.missingFiles(e)
	if len(files) == 0 {
		job.Progress(1, "Already downloaded")
		return nil
	}
	var total int64
	for _, f := range files {
		total += f.bytes
	}
	var done int64
	for _, f := range files {
		base, size := done, f.bytes
		prog := func(frac float64, msg string) {
			job.Progress((float64(base)+frac*float64(size))/float64(total)*0.99, msg)
		}
		if err := c.downloadFile(ctx, job, f, prog); err != nil {
			return err
		}
		done += f.bytes
	}
	job.Progress(1, "Downloaded "+e.Label)
	return nil
}

// downloadFile fetches one file; prog gets fractions of that file in 0..1.
func (c *Chat) downloadFile(ctx context.Context, job *core.JobContext, f dlFile, prog func(float64, string)) error {
	part := f.final + ".part"
	if err := os.MkdirAll(filepath.Dir(f.final), 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the models folder").WithCause(err)
	}

	for attempt := 0; ; attempt++ {
		err := c.fetchPart(ctx, job, f, part, prog)
		if errors.Is(err, errRangeInvalid) && attempt == 0 {
			_ = os.Remove(part) // the partial file no longer matches: start over
			continue
		}
		if err != nil {
			return err
		}
		break
	}

	prog(1, "Verifying")
	got, err := hashFile(ctx, part)
	if err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(cerr)
		}
		return core.Errorf(core.CodeInternal, "Couldn't verify the download").WithCause(err)
	}
	if !strings.EqualFold(got, f.sha256) {
		_ = os.Remove(part)
		job.Logf("Checksum mismatch for %s: expected %s, got %s", f.name, f.sha256, got)
		return core.Errorf(core.CodeToolFailed, "%s", errCorrupt)
	}
	_ = os.Remove(f.final)
	if err := os.Rename(part, f.final); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the model").WithCause(err)
	}
	return nil
}

var errRangeInvalid = errors.New("range not satisfiable")

// fetchPart appends to part until it holds f.bytes bytes.
func (c *Chat) fetchPart(ctx context.Context, job *core.JobContext, f dlFile, part string, prog func(float64, string)) error {
	var have int64
	if fi, err := os.Stat(part); err == nil {
		have = fi.Size()
		if have > f.bytes {
			_ = os.Remove(part)
			have = 0
		}
	}
	if have == f.bytes {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.url, nil)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't start the download").WithCause(err)
	}
	if have > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(have, 10)+"-")
		job.Logf("Resuming %s at %s", f.name, formatBytes(have))
	} else {
		job.Logf("Downloading %s", f.name)
	}
	resp, err := downloadClient.Do(req)
	if err != nil {
		return downloadErr(ctx, "Couldn't reach the download server", err)
	}
	defer resp.Body.Close()

	flags := os.O_CREATE | os.O_WRONLY
	switch resp.StatusCode {
	case http.StatusPartialContent:
		flags |= os.O_APPEND
	case http.StatusOK:
		have = 0 // the server ignored Range: start from the beginning
		flags |= os.O_TRUNC
	case http.StatusRequestedRangeNotSatisfiable:
		return errRangeInvalid
	default:
		return core.Errorf(core.CodeToolFailed, "The download server answered %d", resp.StatusCode)
	}
	out, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't write the model file").WithCause(err)
	}
	defer out.Close()

	buf := make([]byte, 256<<10)
	start, lastReport := time.Now(), time.Time{}
	received := have
	startBytes := have
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				return core.Errorf(core.CodeInternal, "Couldn't write the model file").WithCause(werr)
			}
			received += int64(n)
			if time.Since(lastReport) >= 250*time.Millisecond {
				lastReport = time.Now()
				rate := float64(received-startBytes) / max(time.Since(start).Seconds(), 0.001)
				prog(0.98*float64(received)/float64(f.bytes),
					fmt.Sprintf("%s of %s · %s/s", formatBytes(received), formatBytes(f.bytes), formatBytes(int64(rate))))
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return downloadErr(ctx, "The download was interrupted", rerr)
		}
	}
	if received != f.bytes {
		return core.Errorf(core.CodeToolFailed, "The download ended early").WithHint("Try again; it will continue where it stopped")
	}
	return out.Close()
}

func downloadErr(ctx context.Context, msg string, err error) error {
	if cerr := ctx.Err(); cerr != nil {
		return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(cerr)
	}
	return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err).WithHint("Check your internet connection and try again; the download will continue where it stopped")
}

func hashFile(ctx context.Context, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 1<<20)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, rerr := f.Read(buf)
		h.Write(buf[:n])
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", rerr
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// formatBytes renders a size like "1.2 GB" (decimal units).
func formatBytes(n int64) string {
	const k = 1000.0
	f := float64(n)
	switch {
	case f >= k*k*k:
		return fmt.Sprintf("%.1f GB", f/(k*k*k))
	case f >= k*k:
		return fmt.Sprintf("%.0f MB", f/(k*k))
	case f >= k:
		return fmt.Sprintf("%.0f kB", f/k)
	}
	return fmt.Sprintf("%d B", n)
}

// deleteModel removes a catalog model (and any partial download), stopping the
// server first when it is using it.
func (c *Chat) deleteModel(id string) error {
	e, ok := c.lookup(id)
	if !ok {
		return core.Errorf(core.CodeNotFound, "Unknown chat model")
	}
	if c.downloadJob(id) != "" {
		return core.Errorf(core.CodeConflict, "This model is downloading").WithHint("Cancel the download first")
	}
	c.stopGenerationFor(func(g *generation) bool { return g.model == id })
	c.stopServerIf(func(s *server) bool { return s.model == id })
	final := c.modelPath(e)
	for _, p := range []string{final, final + ".part", c.mmprojPath(e), c.mmprojPath(e) + ".part"} {
		if p == "" || p == ".part" {
			continue
		}
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return core.Errorf(core.CodeInternal, "Couldn't delete the model").WithCause(err)
		}
	}
	return nil
}

// downloadJob returns the ID of a queued or running download job of model id.
func (c *Chat) downloadJob(id string) string {
	if c.cfg.Jobs == nil {
		return ""
	}
	jobs, err := c.cfg.Jobs.List(context.Background(), core.JobFilter{
		ModuleID: ModelModuleID, Statuses: []core.JobStatus{core.JobQueued, core.JobRunning}, Limit: 50,
	})
	if err != nil {
		return ""
	}
	for _, j := range jobs {
		if o, err := core.DecodeOptionsJSON[ModelOptions]([]byte(j.OptionsJSON)); err == nil && o.Model == id {
			return j.ID
		}
	}
	return ""
}
