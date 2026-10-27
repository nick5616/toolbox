package deps

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
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

// updater is the hidden install/update module for one managed binary
// (yt-dlp by default, uv via RegisterUVUpdater) and the engine behind
// Service.InstallManagedBinary.
type updater struct {
	svc     *Service
	spec    BinarySpec
	apiBase string
	client  *http.Client
	version func(ctx context.Context, path string) (string, error)
	goos    string
	goarch  string
	maxSize int64 // 0 = spec.MaxBytes
}

// RegisterUpdater registers the hidden yt-dlp install/update module.
func RegisterUpdater(reg *core.Registry, s *Service) error {
	return reg.Register(newUpdater(s, githubAPI))
}

func newUpdater(s *Service, apiBase string) *updater {
	return &updater{
		svc: s, spec: YtDlpBinary(), apiBase: apiBase, client: &http.Client{},
		goos: runtime.GOOS, goarch: runtime.GOARCH,
		version: func(ctx context.Context, path string) (string, error) {
			return proc.Output(ctx, versionTimeout, path, "--version")
		},
	}
}

func (u *updater) Descriptor() core.Descriptor {
	d := core.Descriptor{
		ID: UpdateModuleID, Name: "yt-dlp updater", Tagline: "Install or update yt-dlp",
		Icon: "refresh-cw", Category: core.CategoryUtility, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 1, OutputSubdir: "",
	}
	if u.spec.DepID == UV {
		d.ID, d.Name, d.Tagline = UVUpdateModuleID, "uv updater", "Install or update uv"
	}
	return d
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

func (u *updater) managedPath(b BinarySpec) string {
	return filepath.Join(u.svc.binDir, u.exe(b.DepID))
}

func (u *updater) exe(name string) string {
	if u.goos == "windows" {
		return name + ".exe"
	}
	return name
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
	return u.install(ctx, job, u.spec)
}

func (u *updater) limit(b BinarySpec) int64 {
	switch {
	case u.maxSize > 0:
		return u.maxSize
	case b.MaxBytes > 0:
		return b.MaxBytes
	}
	return maxDownload
}

func sizeText(n int64) string {
	if n >= 1<<20 {
		return fmt.Sprintf("%d MB", n>>20)
	}
	return fmt.Sprintf("%d bytes", n)
}

// versionMatches reports whether a --version output names the release tag
// (yt-dlp prints just the tag; uv prints "uv 0.13.6 (…)").
func versionMatches(out, tag string) bool {
	tag = strings.TrimPrefix(strings.TrimSpace(tag), "v")
	for _, f := range strings.Fields(out) {
		if strings.TrimPrefix(f, "v") == tag {
			return true
		}
	}
	return false
}

func (u *updater) install(ctx context.Context, job *core.JobContext, b BinarySpec) error {
	label := b.DepID
	job.Progress(core.IndeterminateProgress, "Checking latest release")
	job.Logf("Checking the latest %s release", label)
	rel, err := u.fetchRelease(ctx, b)
	if err != nil {
		return err
	}
	tag := rel.TagName
	if tag == "" {
		return core.Errorf(core.CodeToolFailed, "Release has no version tag")
	}
	job.Logf("Latest release: %s", tag)

	dest := u.managedPath(b)
	if isFile(dest) {
		if cur, err := u.version(ctx, dest); err == nil && versionMatches(cur, tag) {
			job.Logf("Installed version %s is current", tag)
			job.Progress(1, "Already up to date ("+tag+")")
			return nil
		}
	}

	if b.Asset == nil {
		return core.Errorf(core.CodeInternal, "Unsupported platform")
	}
	name, err := b.Asset(u.goos, u.goarch)
	if err != nil || name == "" {
		return core.Errorf(core.CodeInternal, "Unsupported platform")
	}
	assetURL := rel.asset(name)
	if assetURL == "" {
		return core.Errorf(core.CodeToolFailed, "Release has no %s download", name)
	}
	var sumsName string
	switch b.Checksum {
	case ChecksumPerAsset:
		sumsName = name + ".sha256"
	default:
		sumsName = b.SumsFile
		if sumsName == "" {
			sumsName = sumsAsset
		}
	}
	sumsURL := rel.asset(sumsName)
	if sumsURL == "" {
		return core.Errorf(core.CodeToolFailed, "Release has no checksum file")
	}

	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}
	job.Logf("Downloading %s", sumsName)
	sums, err := u.fetchText(ctx, sumsURL)
	if err != nil {
		return err
	}
	var want string
	if b.Checksum == ChecksumPerAsset {
		want = singleSum(sums)
	} else {
		want = findSum(sums, name)
	}
	if want == "" {
		return core.Errorf(core.CodeToolFailed, "Checksum for %s not found", name)
	}

	tmp := filepath.Join(job.TempDir, name)
	defer os.Remove(tmp)
	job.Logf("Downloading %s", name)
	got, err := u.download(ctx, assetURL, tmp, job, label, u.limit(b))
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

	src := tmp
	if b.ArchiveEntry != "" {
		src = filepath.Join(job.TempDir, u.exe(b.DepID)+".extracted")
		defer os.Remove(src)
		if err := u.extract(tmp, name, b.ArchiveEntry, src, u.limit(b)); err != nil {
			return err
		}
		job.Logf("Extracted %s", b.ArchiveEntry)
	}

	if err := os.Chmod(src, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't make %s executable", label).WithCause(err)
	}
	if err := os.MkdirAll(u.svc.binDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the tools folder").WithCause(err)
	}
	job.Progress(0.97, "Installing")
	if err := os.Rename(src, dest); err != nil {
		if u.goos == "windows" {
			return core.Errorf(core.CodeConflict, "%s is in use; wait for running tasks to finish", label).WithCause(err)
		}
		return core.Errorf(core.CodeInternal, "Couldn't install %s", label).WithCause(err)
	}
	job.Logf("Installed to %s", dest)

	ver, err := u.version(ctx, dest)
	if err != nil {
		return core.Errorf(core.CodeToolFailed, "The new %s didn't run", label).WithCause(err)
	}
	job.Logf("%s reports version %s", label, firstLine(ver))
	u.svc.Detect(ctx)
	job.Progress(1, "Installed "+label+" "+tag)
	return nil
}

func (u *updater) fetchRelease(ctx context.Context, b BinarySpec) (release, error) {
	var rel release
	resp, cancel, err := u.get(ctx, u.apiBase+"/repos/"+b.Repo+"/releases/latest")
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

// singleSum parses a per-asset .sha256 file: "<hex>  <name>" or just "<hex>".
func singleSum(text string) string {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if _, err := hex.DecodeString(f[0]); err != nil || len(f[0]) != 64 {
			return ""
		}
		return f[0]
	}
	return ""
}

// download streams url to path and returns the SHA-256 hex digest.
func (u *updater) download(ctx context.Context, url, path string, job *core.JobContext, label string, limit int64) (string, error) {
	resp, cancel, err := u.get(ctx, url)
	if err != nil {
		return "", netErr(ctx, "Couldn't download "+label, err)
	}
	defer cancel()
	defer resp.Body.Close()
	total := resp.ContentLength
	tooBig := func() error {
		return core.Errorf(core.CodeToolFailed, "Download is too large (over %s)", sizeText(limit))
	}
	if total > limit {
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
			if n > limit {
				return "", tooBig()
			}
			h.Write(buf[:r])
			if _, werr := f.Write(buf[:r]); werr != nil {
				return "", core.Errorf(core.CodeInternal, "Couldn't write the download").WithCause(werr)
			}
			if total > 0 {
				job.Progress(0.95*float64(n)/float64(total), fmt.Sprintf("Downloading %s (%d%%)", label, n*100/total))
			} else {
				job.Progress(core.IndeterminateProgress, "Downloading "+label)
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

// memberMatches reports whether an archive member name is the wanted binary
// (at the top level or inside a top-level folder).
func (u *updater) memberMatches(member, entry string) bool {
	base := path.Base(strings.ReplaceAll(member, `\`, "/"))
	return base == entry || base == entry+".exe"
}

// extract copies the named member of a .zip or .tar.gz archive to dest.
func (u *updater) extract(archive, assetName, entry, dest string, limit int64) error {
	notFound := core.Errorf(core.CodeToolFailed, "The download didn't contain %s", entry)
	bad := func(err error) error {
		return core.Errorf(core.CodeToolFailed, "Couldn't unpack the download").WithCause(err)
	}
	write := func(r io.Reader) error {
		out, err := os.Create(dest)
		if err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't write the download").WithCause(err)
		}
		n, err := io.Copy(out, io.LimitReader(r, limit+1))
		cerr := out.Close()
		if err != nil {
			return bad(err)
		}
		if cerr != nil {
			return core.Errorf(core.CodeInternal, "Couldn't write the download").WithCause(cerr)
		}
		if n > limit {
			os.Remove(dest)
			return core.Errorf(core.CodeToolFailed, "Download is too large (over %s)", sizeText(limit))
		}
		return nil
	}
	switch {
	case strings.HasSuffix(assetName, ".zip"):
		zr, err := zip.OpenReader(archive)
		if err != nil {
			return bad(err)
		}
		defer zr.Close()
		for _, f := range zr.File {
			if f.FileInfo().IsDir() || !u.memberMatches(f.Name, entry) {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return bad(err)
			}
			defer rc.Close()
			return write(rc)
		}
		return notFound
	case strings.HasSuffix(assetName, ".tar.gz"), strings.HasSuffix(assetName, ".tgz"):
		f, err := os.Open(archive)
		if err != nil {
			return bad(err)
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return bad(err)
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err == io.EOF {
				return notFound
			}
			if err != nil {
				return bad(err)
			}
			if h.Typeflag != tar.TypeReg || !u.memberMatches(h.Name, entry) {
				continue
			}
			return write(tr)
		}
	}
	return bad(fmt.Errorf("unknown archive type %q", assetName))
}
