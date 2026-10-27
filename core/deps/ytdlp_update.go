package deps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
)

const (
	githubAPI      = "https://api.github.com"
	requestTimeout = 15 * time.Second
	maxDownload    = 200 << 20
	sumsAsset      = "SHA2-256SUMS"
)

// assetName returns the yt-dlp release asset for a platform, or "".
func assetName(goos, goarch string) string {
	switch goos {
	case "darwin":
		return "yt-dlp_macos"
	case "windows":
		switch goarch {
		case "amd64":
			return "yt-dlp.exe"
		case "arm64":
			return "yt-dlp_arm64.exe"
		}
	case "linux":
		switch goarch {
		case "amd64":
			return "yt-dlp_linux"
		case "arm64":
			return "yt-dlp_linux_aarch64"
		}
	}
	return ""
}

type updater struct {
	svc     *Service
	apiBase string
	client  *http.Client
	version func(ctx context.Context, path string) (string, error)
	goos    string
	goarch  string
	maxSize int64
}

// RegisterUpdater registers the hidden yt-dlp install/update module.
func RegisterUpdater(reg *core.Registry, s *Service) error {
	return reg.Register(newUpdater(s, githubAPI))
}

func newUpdater(s *Service, apiBase string) *updater {
	return &updater{
		svc: s, apiBase: apiBase, client: &http.Client{},
		goos: runtime.GOOS, goarch: runtime.GOARCH, maxSize: maxDownload,
		version: func(ctx context.Context, path string) (string, error) {
			return proc.Output(ctx, versionTimeout, path, "--version")
		},
	}
}

func (u *updater) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: UpdateModuleID, Name: "yt-dlp updater", Tagline: "Install or update yt-dlp",
		Icon: "refresh-cw", Category: core.CategoryUtility, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 1, OutputSubdir: "",
	}
}

func (u *updater) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) > 0 {
		return core.ValidationError("This task takes no inputs", nil)
	}
	_, err := core.DecodeOptionsJSON[struct{}](options)
	return err
}

type release struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r release) asset(name string) string {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL
		}
	}
	return ""
}

func (u *updater) managedPath() string {
	name := "yt-dlp"
	if u.goos == "windows" {
		name += ".exe"
	}
	return filepath.Join(u.svc.binDir, name)
}

// get performs a GET whose response headers must arrive within the request
// timeout. The returned cancel must be called when the body is done.
func (u *updater) get(ctx context.Context, url string) (*http.Response, context.CancelFunc, error) {
	rctx, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(requestTimeout, cancel)
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, url, nil)
	if err != nil {
		timer.Stop()
		cancel()
		return nil, nil, err
	}
	req.Header.Set("User-Agent", "Toolbox/"+core.Version)
	resp, err := u.client.Do(req)
	timer.Stop()
	if err != nil {
		cancel()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		return nil, nil, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	return resp, cancel, nil
}

func netErr(ctx context.Context, what string, err error) error {
	if ctx.Err() != nil {
		return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(ctx.Err())
	}
	return core.Errorf(core.CodeToolFailed, "%s", what).WithCause(err).
		WithHint("Check your internet connection and try again.")
}

func (u *updater) Run(ctx context.Context, job *core.JobContext) error {
	job.Progress(core.IndeterminateProgress, "Checking latest release")
	job.Logf("Checking the latest yt-dlp release")
	rel, err := u.fetchRelease(ctx)
	if err != nil {
		return err
	}
	tag := rel.TagName
	if tag == "" {
		return core.Errorf(core.CodeToolFailed, "Release has no version tag")
	}
	job.Logf("Latest release: %s", tag)

	dest := u.managedPath()
	if isFile(dest) {
		if cur, err := u.version(ctx, dest); err == nil && strings.TrimSpace(cur) == tag {
			job.Logf("Installed version %s is current", tag)
			job.Progress(1, "Already up to date ("+tag+")")
			return nil
		}
	}

	name := assetName(u.goos, u.goarch)
	if name == "" {
		return core.Errorf(core.CodeInternal, "Unsupported platform")
	}
	assetURL, sumsURL := rel.asset(name), rel.asset(sumsAsset)
	if assetURL == "" {
		return core.Errorf(core.CodeToolFailed, "Release has no %s download", name)
	}
	if sumsURL == "" {
		return core.Errorf(core.CodeToolFailed, "Release has no checksum file")
	}

	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}
	job.Logf("Downloading %s", sumsAsset)
	sums, err := u.fetchText(ctx, sumsURL)
	if err != nil {
		return err
	}
	want := findSum(sums, name)
	if want == "" {
		return core.Errorf(core.CodeToolFailed, "Checksum for %s not found", name)
	}

	tmp := filepath.Join(job.TempDir, name)
	defer os.Remove(tmp)
	job.Logf("Downloading %s", name)
	got, err := u.download(ctx, assetURL, tmp, job)
	if err != nil {
		return err
	}

	job.Progress(0.96, "Verifying download")
	if !strings.EqualFold(got, want) {
		job.Logf("Checksum mismatch: expected %s, got %s", want, got)
		return core.Errorf(core.CodeToolFailed, "Checksum mismatch").
			WithHint("The download was corrupted. Try again.")
	}
	job.Logf("Checksum OK")

	if err := os.Chmod(tmp, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't make yt-dlp executable").WithCause(err)
	}
	if err := os.MkdirAll(u.svc.binDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the tools folder").WithCause(err)
	}
	job.Progress(0.97, "Installing")
	if err := os.Rename(tmp, dest); err != nil {
		if u.goos == "windows" {
			return core.Errorf(core.CodeConflict, "yt-dlp is in use; wait for downloads to finish").WithCause(err)
		}
		return core.Errorf(core.CodeInternal, "Couldn't install yt-dlp").WithCause(err)
	}
	job.Logf("Installed to %s", dest)

	ver, err := u.version(ctx, dest)
	if err != nil {
		return core.Errorf(core.CodeToolFailed, "The new yt-dlp didn't run").WithCause(err)
	}
	job.Logf("yt-dlp reports version %s", strings.TrimSpace(ver))
	u.svc.Detect(ctx)
	job.Progress(1, "Installed yt-dlp "+tag)
	return nil
}

func (u *updater) fetchRelease(ctx context.Context) (release, error) {
	var rel release
	resp, cancel, err := u.get(ctx, u.apiBase+"/repos/yt-dlp/yt-dlp/releases/latest")
	if err != nil {
		return rel, netErr(ctx, "Couldn't reach GitHub", err)
	}
	defer cancel()
	defer resp.Body.Close()
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&rel); err != nil {
		return rel, netErr(ctx, "Couldn't read the release info", err)
	}
	return rel, nil
}

func (u *updater) fetchText(ctx context.Context, url string) (string, error) {
	resp, cancel, err := u.get(ctx, url)
	if err != nil {
		return "", netErr(ctx, "Couldn't download the checksum file", err)
	}
	defer cancel()
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", netErr(ctx, "Couldn't download the checksum file", err)
	}
	return string(b), nil
}

// findSum returns the hex digest listed for exactly the given asset name.
func findSum(sums, name string) string {
	for _, line := range strings.Split(sums, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return f[0]
		}
	}
	return ""
}

// download streams url to path and returns the SHA-256 hex digest.
func (u *updater) download(ctx context.Context, url, path string, job *core.JobContext) (string, error) {
	resp, cancel, err := u.get(ctx, url)
	if err != nil {
		return "", netErr(ctx, "Couldn't download yt-dlp", err)
	}
	defer cancel()
	defer resp.Body.Close()
	total := resp.ContentLength
	tooBig := func() error {
		return core.Errorf(core.CodeToolFailed, "Download is too large (over 200 MB)")
	}
	if total > u.maxSize {
		return "", tooBig()
	}
	f, err := os.Create(path)
	if err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't write the download").WithCause(err)
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 64<<10)
	var n int64
	for {
		if ctx.Err() != nil {
			return "", netErr(ctx, "", ctx.Err())
		}
		r, rerr := resp.Body.Read(buf)
		if r > 0 {
			n += int64(r)
			if n > u.maxSize {
				return "", tooBig()
			}
			h.Write(buf[:r])
			if _, werr := f.Write(buf[:r]); werr != nil {
				return "", core.Errorf(core.CodeInternal, "Couldn't write the download").WithCause(werr)
			}
			if total > 0 {
				job.Progress(0.95*float64(n)/float64(total), fmt.Sprintf("Downloading yt-dlp (%d%%)", n*100/total))
			} else {
				job.Progress(core.IndeterminateProgress, "Downloading yt-dlp")
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", netErr(ctx, "Download interrupted", rerr)
		}
	}
	if total > 0 && n != total {
		return "", core.Errorf(core.CodeToolFailed, "Download was incomplete").WithCause(errors.New("short body"))
	}
	if err := f.Close(); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't write the download").WithCause(err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
