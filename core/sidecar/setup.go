package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"toolbox/core"
	"toolbox/core/proc"
	sidecarfiles "toolbox/sidecar"
)

const (
	selftestTimeout = 180 * time.Second
	setupHint       = "Check your connection and retry; see the job log for details"
	uvProgressEnd   = 0.10
	syncProgressEnd = 0.85
	checkProgress   = 0.95
)

type setupModule struct {
	paths     core.Paths
	mgr       *Manager
	resolveUV func() (string, error)
	installUV func(ctx context.Context, job *core.JobContext) error
	detect    func(ctx context.Context)
}

// RegisterSetup registers the hidden install/update/repair module.
// resolveUV resolves the uv binary; installUV installs it into the managed
// bin dir (used when resolveUV fails); detect re-runs dependency detection.
func RegisterSetup(reg *core.Registry, p core.Paths, m *Manager, resolveUV func() (string, error), installUV func(ctx context.Context, job *core.JobContext) error, detect func(ctx context.Context)) error {
	return reg.Register(&setupModule{paths: p, mgr: m, resolveUV: resolveUV, installUV: installUV, detect: detect})
}

func (s *setupModule) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: SetupModuleID, Name: "Audio engine setup", Tagline: "Install, update or repair the audio engine",
		Icon: "audio-lines", Category: core.CategoryUtility, Status: core.StatusReady,
		Hidden: true, MaxConcurrent: 1, OutputSubdir: "",
	}
}

func (s *setupModule) Validate(inputs []string, options json.RawMessage) error {
	if len(inputs) > 0 {
		return core.ValidationError("This task takes no inputs", nil)
	}
	_, err := core.DecodeOptionsJSON[struct{}](options)
	return err
}

func (s *setupModule) uvEnv() []string {
	return []string{
		"UV_CACHE_DIR=" + filepath.Join(s.paths.CacheDir, "uv"),
		"UV_PYTHON_INSTALL_DIR=" + s.paths.PythonDir,
		"UV_PYTHON_PREFERENCE=only-managed",
		"UV_PROJECT_ENVIRONMENT=" + filepath.Join(s.paths.SidecarDir, ".venv"),
		"UV_LINK_MODE=copy",
		"UV_NO_PROGRESS=1",
	}
}

func cancelled(ctx context.Context) error {
	return core.Errorf(core.CodeCancelled, "Cancelled").WithCause(ctx.Err())
}

// scaled returns a job whose progress is mapped into [lo, hi].
func scaled(job *core.JobContext, lo, hi float64) *core.JobContext {
	return core.NewJobContext(core.JobContext{
		ID: job.ID, ModuleID: job.ModuleID, Attempt: job.Attempt, TempDir: job.TempDir,
	}, core.JobHooks{
		Progress: func(pct float64, msg string) {
			if pct >= 0 {
				pct = lo + (hi-lo)*pct
			}
			job.Progress(pct, msg)
		},
		Log: job.Log,
	})
}

func (s *setupModule) Run(ctx context.Context, job *core.JobContext) error {
	if s.mgr != nil {
		if err := s.mgr.Stop(); err != nil {
			return err
		}
	}

	// 1. uv
	job.Progress(0, "Installing uv")
	uv, err := s.resolveUV()
	if err != nil {
		if s.installUV == nil {
			return err
		}
		job.Logf("uv not found; installing it")
		if err := s.installUV(ctx, scaled(job, 0, uvProgressEnd)); err != nil {
			return err
		}
		if uv, err = s.resolveUV(); err != nil {
			return err
		}
	}
	job.Progress(uvProgressEnd, "Preparing the audio engine")
	if ctx.Err() != nil {
		return cancelled(ctx)
	}

	// 2. project files
	if err := s.writeProject(job); err != nil {
		return err
	}

	// 3. uv sync
	job.Progress(core.IndeterminateProgress, "Installing Python packages")
	if err := s.sync(ctx, job, uv); err != nil {
		return err
	}

	// 4. self-test
	job.Progress(syncProgressEnd, "Checking the audio engine")
	version, err := s.selftest(ctx, job)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(s.paths.SidecarDir, versionFile), []byte(version+"\n"), 0o644); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the audio engine version").WithCause(err)
	}

	// 5. clean up, mark done
	job.Progress(checkProgress, "Ready")
	if _, err := proc.Run(ctx, proc.Spec{
		Path: uv, Args: []string{"cache", "clean"}, Dir: s.paths.SidecarDir, Env: s.uvEnv(),
		OnStderr: func(l string) { job.Log(core.StreamStderr, l) },
	}); err != nil {
		if ctx.Err() != nil {
			return cancelled(ctx)
		}
		job.Logf("uv cache clean failed (ignored): %v", err)
	}
	if err := os.WriteFile(filepath.Join(s.paths.SidecarDir, hashFile), []byte(sidecarfiles.Hash()+"\n"), 0o644); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't save the audio engine marker").WithCause(err)
	}
	if s.detect != nil {
		s.detect(ctx)
	}
	job.Progress(1, "Audio engine ready")
	return nil
}

// writeProject replaces the embedded project files, keeping .venv.
func (s *setupModule) writeProject(job *core.JobContext) error {
	dir := s.paths.SidecarDir
	fail := func(err error) error {
		return core.Errorf(core.CodeInternal, "Couldn't write the audio engine files").WithCause(err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fail(err)
	}
	// An interrupted install must not look current.
	_ = os.Remove(filepath.Join(dir, hashFile))
	if err := os.RemoveAll(filepath.Join(dir, "toolbox_sidecar")); err != nil {
		return fail(err)
	}
	files := sidecarfiles.Files()
	for _, f := range files {
		if !strings.Contains(f, "/") {
			if err := os.Remove(filepath.Join(dir, f)); err != nil && !os.IsNotExist(err) {
				return fail(err)
			}
		}
	}
	for _, f := range files {
		b, err := sidecarfiles.FS.ReadFile(f)
		if err != nil {
			return fail(err)
		}
		dst := filepath.Join(dir, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return fail(err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			return fail(err)
		}
	}
	job.Logf("Wrote %d project files to %s", len(files), dir)
	return nil
}

func (s *setupModule) sync(ctx context.Context, job *core.JobContext, uv string) error {
	var mu sync.Mutex
	lastErr := ""
	onLine := func(l string) {
		l = strings.TrimSpace(l)
		if l == "" {
			return
		}
		job.Log(core.StreamStderr, l)
		mu.Lock()
		if strings.HasPrefix(l, "error:") {
			lastErr = l
		}
		mu.Unlock()
		job.Progress(core.IndeterminateProgress, l)
	}
	_, err := proc.Run(ctx, proc.Spec{
		Path: uv, Args: []string{"sync", "--frozen", "--no-dev", "--python", "3.12"},
		Dir: s.paths.SidecarDir, Env: s.uvEnv(),
		OnStdout: onLine, OnStderr: onLine,
	})
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return cancelled(ctx)
	}
	mu.Lock()
	defer mu.Unlock()
	msg := "Couldn't install the audio engine"
	if lastErr != "" {
		msg = strings.TrimSpace(strings.TrimPrefix(lastErr, "error:"))
		if msg != "" {
			msg = strings.ToUpper(msg[:1]) + msg[1:]
		} else {
			msg = "Couldn't install the audio engine"
		}
	}
	return core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(err).WithHint(setupHint)
}

type selftestResult struct {
	Python   string            `json:"python"`
	Version  string            `json:"version"`
	Packages map[string]string `json:"packages"`
}

func (s *setupModule) selftest(ctx context.Context, job *core.JobContext) (string, error) {
	py := PythonPath(s.paths)
	cctx, cancel := context.WithTimeout(ctx, selftestTimeout)
	defer cancel()
	var mu sync.Mutex
	var jsonLine string
	res, err := proc.Run(cctx, proc.Spec{
		Path: py, Args: []string{"-X", "utf8", "-m", "toolbox_sidecar", "--selftest"},
		Dir: s.paths.SidecarDir,
		Env: []string{
			"PYTHONUNBUFFERED=1", "PYTHONIOENCODING=utf-8", "NO_COLOR=1",
			"NUMBA_CACHE_DIR=" + filepath.Join(s.paths.CacheDir, "numba"),
			"TOOLBOX_MODELS_DIR=" + s.paths.ModelsDir,
			"HF_HOME=" + filepath.Join(s.paths.CacheDir, "py"),
			"TORCH_HOME=" + filepath.Join(s.paths.CacheDir, "py"),
			"XDG_CACHE_HOME=" + filepath.Join(s.paths.CacheDir, "py"),
		},
		OnStdout: func(l string) {
			job.Log(core.StreamStdout, l)
			if strings.HasPrefix(strings.TrimSpace(l), "{") {
				mu.Lock()
				jsonLine = strings.TrimSpace(l)
				mu.Unlock()
			}
		},
		OnStderr: func(l string) { job.Log(core.StreamStderr, l) },
	})
	if err != nil {
		if ctx.Err() != nil {
			return "", cancelled(ctx)
		}
		return "", core.Errorf(core.CodeToolFailed, "The audio engine didn't pass its self-check").
			WithHint(setupHint).
			WithCause(fmt.Errorf("%w: %s", err, strings.Join(lastLines(res.StderrTail, 10), "\n")))
	}
	mu.Lock()
	line := jsonLine
	mu.Unlock()
	var st selftestResult
	if line == "" || json.Unmarshal([]byte(line), &st) != nil {
		return "", core.Errorf(core.CodeToolFailed, "The audio engine's self-check gave no result").
			WithHint(setupHint).WithCause(errors.New(line))
	}
	ver := st.Version
	if v := st.Packages["toolbox-sidecar"]; v != "" {
		ver = v
	}
	if ver == "" {
		ver = "?"
	}
	torch := st.Packages["torch"]
	if torch == "" {
		torch = "?"
	}
	pyv := st.Python
	if pyv == "" {
		pyv = "?"
	}
	return fmt.Sprintf("toolbox-sidecar %s · py %s · torch %s", ver, pyv, torch), nil
}
