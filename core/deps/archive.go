package deps

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"toolbox/core"
	"toolbox/core/proc"
)

// Managed archive tools (Phase 3 SPEC.md §3.5).

// ExifToolUpdateModuleID is the hidden ExifTool install/update module.
const ExifToolUpdateModuleID = "system-exiftool-update"

// ArchivePart is one downloadable archive of an ArchiveSpec.
type ArchivePart struct {
	Name   string                                             // "main", "models", …
	Asset  func(goos, goarch, version string) (string, error) // asset file name
	URL    func(asset string) string                          // download URL (may redirect)
	SHA256 func(asset string) string                          // pinned hex; nil or "" → look up in ArchiveSpec.ChecksumsURL
	Size   int64                                              // approximate bytes; weights the progress (0 = unknown, even split)
}

// ArchiveSpec describes an app-managed tool installed from one or more
// versioned archives (a folder, not a single binary). SPEC §3.3.
type ArchiveSpec struct {
	DepID        string
	InstallDir   string // relative to BinDir, e.g. "exiftool"
	VersionURL   string // latest version as plain text; "" when Version is pinned
	Version      string // pinned version (no network version check)
	ChecksumsURL string // "SHA2-256(<asset>)= <hex>" lines, for parts without a pinned SHA256
	Parts        []ArchivePart
	// Layout builds installDir (which does not exist yet) from the extracted
	// parts: roots maps part name → extracted root (top folder unwrapped), so
	// that the tool's executable ends up where detection looks for it.
	Layout   func(roots map[string]string, installDir string) error
	MaxBytes int64 // per part

	// The hidden installer module.
	ModuleID, ModuleName, Tagline string
}

// ExifToolArchive is the ExifTool archive spec.
func ExifToolArchive() ArchiveSpec {
	return ArchiveSpec{
		DepID:        ExifTool,
		InstallDir:   "exiftool",
		VersionURL:   "https://exiftool.org/ver.txt",
		ChecksumsURL: "https://exiftool.org/checksums.txt",
		Parts: []ArchivePart{{
			Name:  "main",
			Asset: exifToolAsset,
			URL: func(asset string) string {
				return "https://sourceforge.net/projects/exiftool/files/" + asset + "/download"
			},
		}},
		Layout: func(roots map[string]string, dir string) error {
			return exifToolLayout(runtime.GOOS, roots["main"], dir)
		},
		MaxBytes:   maxDownload,
		ModuleID:   ExifToolUpdateModuleID,
		ModuleName: "ExifTool updater",
		Tagline:    "Install or update ExifTool",
	}
}

// exifToolAsset names the release archive. Windows arm64 uses the 64-bit
// build (it runs under x64 emulation; ExifTool publishes no native arm64).
func exifToolAsset(goos, goarch, version string) (string, error) {
	if version == "" {
		return "", errUnsupportedPlatform
	}
	switch goos {
	case "windows":
		if goarch == "amd64" || goarch == "arm64" {
			return "exiftool-" + version + "_64.zip", nil
		}
	case "darwin", "linux":
		return "Image-ExifTool-" + version + ".tar.gz", nil
	}
	return "", errUnsupportedPlatform
}

// archiveRoot descends into the single top-level folder most archives have.
func archiveRoot(extracted string) string {
	ents, err := os.ReadDir(extracted)
	if err == nil && len(ents) == 1 && ents[0].IsDir() {
		return filepath.Join(extracted, ents[0].Name())
	}
	return extracted
}

// exifToolLayout arranges the extracted release in installDir.
//   - windows: exiftool(-k).exe → exiftool.exe, exiftool_files/ kept beside it.
//   - unix: the Perl script exiftool (0755) + lib/.
func exifToolLayout(goos, extractedRoot, installDir string) error {
	root := archiveRoot(extractedRoot)
	bad := func(msg string, err error) error {
		return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err)
	}
	if goos == "windows" {
		src := filepath.Join(root, "exiftool(-k).exe")
		if !isFile(src) {
			return bad("The download didn't contain exiftool.exe", errors.New("exiftool(-k).exe missing"))
		}
		if fi, err := os.Stat(filepath.Join(root, "exiftool_files")); err != nil || !fi.IsDir() {
			return bad("The download didn't contain exiftool_files", errors.New("exiftool_files missing"))
		}
		if err := os.Rename(src, filepath.Join(root, "exiftool.exe")); err != nil {
			return bad("Couldn't set up ExifTool", err)
		}
	} else {
		script := filepath.Join(root, "exiftool")
		if !isFile(script) {
			return bad("The download didn't contain exiftool", errors.New("exiftool script missing"))
		}
		if fi, err := os.Stat(filepath.Join(root, "lib")); err != nil || !fi.IsDir() {
			return bad("The download didn't contain the ExifTool libraries", errors.New("lib missing"))
		}
		if err := os.Chmod(script, 0o755); err != nil {
			return bad("Couldn't make ExifTool executable", err)
		}
	}
	if err := os.Rename(root, installDir); err != nil {
		return bad("Couldn't set up ExifTool", err)
	}
	return nil
}

// archiveInstaller carries the test seams of InstallManagedArchive.
type archiveInstaller struct {
	*updater
	// verify runs the tool's version check and returns the version text.
	verify func(ctx context.Context, exe string) (string, error)
	// havePerl reports whether the Perl interpreter ExifTool needs exists.
	havePerl func() bool
}

func newArchiveInstaller(s *Service) *archiveInstaller {
	u := newUpdater(s, "")
	if s.goos != "" {
		u.goos = s.goos
	}
	return &archiveInstaller{
		updater: u,
		verify: func(ctx context.Context, exe string) (string, error) {
			return proc.Output(ctx, versionTimeout, exe, "-ver")
		},
		havePerl: func() bool { return isFile("/usr/bin/perl") },
	}
}

// InstallManagedArchive downloads the latest version of a with checksum
// verification, lays it out in <bin>/<InstallDir> (atomic swap; the old
// install survives a failure), verifies it and re-detects. A no-op when the
// installed version is current.
func (s *Service) InstallManagedArchive(ctx context.Context, job *core.JobContext, a ArchiveSpec) error {
	return newArchiveInstaller(s).install(ctx, job, a)
}

func cancelled(ctx context.Context) error {
	if ctx.Err() != nil {
		return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(ctx.Err())
	}
	return nil
}

// findChecksum finds "SHA2-256(<asset>)= <hex>" in a checksums.txt.
func findChecksum(text, asset string) string {
	prefix := "SHA2-256(" + asset + ")"
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(line, prefix))
		rest = strings.TrimSpace(strings.TrimPrefix(rest, "="))
		if f := strings.Fields(rest); len(f) == 1 {
			return f[0]
		}
	}
	return ""
}

const versionFileName = "VERSION"

// readVersionFile returns the trimmed content of <dir>/VERSION ("" if absent).
func readVersionFile(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, versionFileName))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (i *archiveInstaller) install(ctx context.Context, job *core.JobContext, a ArchiveSpec) error {
	s := i.svc
	sp, ok := s.spec(a.DepID)
	if !ok {
		return core.Errorf(core.CodeInternal, "Unknown dependency %s", a.DepID)
	}
	label := sp.Name
	if len(a.Parts) == 0 || a.Layout == nil || a.InstallDir == "" {
		return core.Errorf(core.CodeInternal, "Incomplete install spec for %s", label)
	}
	for _, p := range a.Parts {
		if p.Name == "" || p.Asset == nil || p.URL == nil {
			return core.Errorf(core.CodeInternal, "Incomplete install spec for %s", label)
		}
	}
	limit := a.MaxBytes
	if i.maxSize > 0 {
		limit = i.maxSize
	}
	if limit <= 0 {
		limit = maxDownload
	}

	version := strings.TrimSpace(a.Version)
	if version == "" {
		if a.VersionURL == "" {
			return core.Errorf(core.CodeInternal, "Incomplete install spec for %s", label)
		}
		job.Progress(core.IndeterminateProgress, "Checking latest version")
		job.Logf("Checking the latest %s version", label)
		verText, err := i.fetchText(ctx, a.VersionURL)
		if err != nil {
			return err
		}
		version = strings.TrimSpace(verText)
		if version == "" || strings.ContainsAny(version, " \t\r\n/\\") {
			return core.Errorf(core.CodeToolFailed, "Couldn't read the latest %s version", label)
		}
		job.Logf("Latest version: %s", version)
	}

	installDir := filepath.Join(s.binDir, a.InstallDir)
	exe := filepath.Join(installDir, i.exe(sp.Binary))
	current := func() bool {
		if !isFile(exe) {
			return false
		}
		if readVersionFile(installDir) == version {
			return true
		}
		// Installs from before VERSION files: ask the tool itself.
		if sp.VersionFile == "" && i.verify != nil {
			cur, err := i.verify(ctx, exe)
			return err == nil && strings.TrimSpace(cur) == version
		}
		return false
	}
	if current() {
		job.Logf("Installed version %s is current", version)
		job.Progress(1, "Already up to date ("+version+")")
		return nil
	}

	if a.DepID == ExifTool && i.goos != "windows" && !i.havePerl() {
		return core.Errorf(core.CodeToolFailed, "ExifTool needs Perl, which isn't installed").
			WithHint("Install ExifTool with Homebrew: brew install exiftool")
	}
	assets := make([]string, len(a.Parts))
	for n, p := range a.Parts {
		asset, err := p.Asset(i.goos, i.goarch, version)
		if err != nil || asset == "" {
			return core.Errorf(core.CodeInternal, "Unsupported platform").WithHint(s.hint(sp))
		}
		assets[n] = asset
	}

	// Expected checksums: pinned, else from checksums.txt (fetched once).
	wants := make([]string, len(a.Parts))
	var sums string
	for n, p := range a.Parts {
		if p.SHA256 != nil {
			wants[n] = p.SHA256(assets[n])
		}
		if wants[n] != "" {
			continue
		}
		if a.ChecksumsURL == "" {
			return core.Errorf(core.CodeToolFailed, "Checksum for %s not found", assets[n])
		}
		if sums == "" {
			t, err := i.fetchText(ctx, a.ChecksumsURL)
			if err != nil {
				return err
			}
			sums = t
		}
		if wants[n] = findChecksum(sums, assets[n]); wants[n] == "" {
			return core.Errorf(core.CodeToolFailed, "Checksum for %s not found", assets[n])
		}
	}

	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}
	if err := os.MkdirAll(s.binDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the tools folder").WithCause(err)
	}

	newDir, oldDir, extractDir := installDir+".new", installDir+".old", installDir+".extract"
	// Recover from an interrupted earlier swap, then clear leftovers.
	if _, err := os.Stat(installDir); os.IsNotExist(err) {
		if _, err := os.Stat(oldDir); err == nil {
			_ = os.Rename(oldDir, installDir)
		}
	}
	for _, d := range []string{newDir, oldDir, extractDir} {
		_ = os.RemoveAll(d)
	}
	defer os.RemoveAll(extractDir)
	defer os.RemoveAll(newDir)

	// Progress weights: by size, or evenly when any size is unknown.
	weights := make([]float64, len(a.Parts))
	var wsum float64
	known := true
	for _, p := range a.Parts {
		if p.Size <= 0 {
			known = false
		}
	}
	for n, p := range a.Parts {
		weights[n] = 1
		if known {
			weights[n] = float64(p.Size)
		}
		wsum += weights[n]
	}

	// Download and verify every part before anything is unpacked.
	archives := make([]string, len(a.Parts))
	var done float64
	for n, p := range a.Parts {
		lo := 0.95 * done / wsum
		done += weights[n]
		hi := 0.95 * done / wsum
		tmp := filepath.Join(job.TempDir, assets[n])
		defer os.Remove(tmp)
		job.Logf("Downloading %s", assets[n])
		got, err := i.downloadRange(ctx, p.URL(assets[n]), tmp, job, label, limit, lo, hi)
		if err != nil {
			return err
		}
		if !strings.EqualFold(got, wants[n]) {
			job.Logf("Checksum mismatch for %s: expected %s, got %s", assets[n], wants[n], got)
			return core.Errorf(core.CodeToolFailed, "Checksum mismatch").
				WithHint("The download was corrupted. Try again.")
		}
		archives[n] = tmp
	}
	job.Progress(0.96, "Verifying download")
	job.Logf("Checksum OK")

	job.Progress(0.97, "Unpacking")
	roots := map[string]string{}
	for n, p := range a.Parts {
		dest := filepath.Join(extractDir, p.Name)
		if err := extractArchive(ctx, archives[n], assets[n], dest, limit); err != nil {
			return err
		}
		roots[p.Name] = archiveRoot(dest)
	}
	if err := cancelled(ctx); err != nil {
		return err
	}
	if err := a.Layout(roots, newDir); err != nil {
		return err
	}
	// Verify the new install before it replaces the old one.
	newExe := filepath.Join(newDir, i.exe(sp.Binary))
	if sp.VersionFile != "" {
		if !isFile(newExe) {
			return core.Errorf(core.CodeToolFailed, "The new %s is incomplete", label)
		}
	} else {
		out, err := i.verify(ctx, newExe)
		if err != nil {
			if cerr := cancelled(ctx); cerr != nil {
				return cerr
			}
			return core.Errorf(core.CodeToolFailed, "The new %s didn't run", label).WithCause(err)
		}
		if v := strings.TrimSpace(out); v != version {
			return core.Errorf(core.CodeToolFailed, "The new %s reports version %q, expected %s", label, v, version)
		}
	}
	if err := os.WriteFile(filepath.Join(newDir, versionFileName), []byte(version+"\n"), 0o644); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't set up %s", label).WithCause(err)
	}
	if err := cancelled(ctx); err != nil {
		return err
	}

	job.Progress(0.99, "Installing")
	hadOld := false
	if _, err := os.Stat(installDir); err == nil {
		hadOld = true
		if err := os.Rename(installDir, oldDir); err != nil {
			return i.swapErr(label, err)
		}
	}
	if err := os.Rename(newDir, installDir); err != nil {
		if hadOld {
			_ = os.Rename(oldDir, installDir)
		}
		return i.swapErr(label, err)
	}
	_ = os.RemoveAll(oldDir)
	job.Logf("Installed to %s", installDir)
	s.Detect(ctx)
	job.Progress(1, "Installed "+label+" "+version)
	return nil
}

func (i *archiveInstaller) swapErr(label string, err error) error {
	if i.goos == "windows" {
		return core.Errorf(core.CodeConflict, "%s is in use; wait for running tasks to finish and try again", label).WithCause(err)
	}
	return core.Errorf(core.CodeInternal, "Couldn't install %s", label).WithCause(err)
}

// safeJoin joins an archive member name under dest, rejecting absolute
// paths, drive letters and ".." segments. It returns "" for the root entry.
func safeJoin(dest, name string) (string, error) {
	name = strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(name, "/") || (len(name) > 1 && name[1] == ':') {
		return "", fmt.Errorf("unsafe path %q", name)
	}
	for _, p := range strings.Split(name, "/") {
		if p == ".." {
			return "", fmt.Errorf("unsafe path %q", name)
		}
	}
	clean := path.Clean(name)
	if clean == "." {
		return "", nil
	}
	return filepath.Join(dest, filepath.FromSlash(clean)), nil
}

// extractArchive unpacks a .zip or .tar.gz into dest, rejecting path
// traversal and capping the total unpacked size at limit.
func extractArchive(ctx context.Context, archive, assetName, dest string, limit int64) error {
	bad := func(err error) error {
		return core.Errorf(core.CodeToolFailed, "Couldn't unpack the download").WithCause(err)
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}
	var total int64
	writeFile := func(target string, mode os.FileMode, r io.Reader) error {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't unpack the download").WithCause(err)
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode|0o600)
		if err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't unpack the download").WithCause(err)
		}
		n, err := io.Copy(out, io.LimitReader(r, limit-total+1))
		cerr := out.Close()
		total += n
		if total > limit {
			return core.Errorf(core.CodeToolFailed, "Download is too large (over %s)", sizeText(limit))
		}
		if err != nil {
			return bad(err)
		}
		if cerr != nil {
			return core.Errorf(core.CodeInternal, "Couldn't unpack the download").WithCause(cerr)
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
			if err := cancelled(ctx); err != nil {
				return err
			}
			target, err := safeJoin(dest, f.Name)
			if err != nil {
				return bad(err)
			}
			if target == "" {
				continue
			}
			if f.FileInfo().IsDir() {
				if err := os.MkdirAll(target, 0o755); err != nil {
					return bad(err)
				}
				continue
			}
			if !f.FileInfo().Mode().IsRegular() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return bad(err)
			}
			err = writeFile(target, f.Mode().Perm(), rc)
			rc.Close()
			if err != nil {
				return err
			}
		}
		return nil
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
			if err := cancelled(ctx); err != nil {
				return err
			}
			h, err := tr.Next()
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return bad(err)
			}
			target, err := safeJoin(dest, h.Name)
			if err != nil {
				return bad(err)
			}
			if target == "" {
				continue
			}
			switch h.Typeflag {
			case tar.TypeDir:
				if err := os.MkdirAll(target, 0o755); err != nil {
					return bad(err)
				}
			case tar.TypeReg:
				if err := writeFile(target, os.FileMode(h.Mode).Perm(), tr); err != nil {
					return err
				}
			}
		}
	}
	return bad(fmt.Errorf("unknown archive type %q", assetName))
}

// RegisterExifToolUpdater registers the hidden ExifTool install/update module.
func RegisterExifToolUpdater(reg *core.Registry, s *Service) error {
	return reg.Register(&archiveUpdater{svc: s, spec: ExifToolArchive()})
}

// archiveUpdater is the hidden install/update module of one ArchiveSpec.
type archiveUpdater struct {
	svc  *Service
	spec ArchiveSpec
}

func (u *archiveUpdater) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: u.spec.ModuleID, Name: u.spec.ModuleName, Tagline: u.spec.Tagline,
		Icon: "refresh-cw", Category: core.CategoryUtility, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 1,
	}
}

func (u *archiveUpdater) Validate(inputs []string, _ json.RawMessage) error {
	if len(inputs) > 0 {
		return core.ValidationError("This task takes no inputs", nil)
	}
	return nil
}

func (u *archiveUpdater) Run(ctx context.Context, job *core.JobContext) error {
	return u.svc.InstallManagedArchive(ctx, job, u.spec)
}
