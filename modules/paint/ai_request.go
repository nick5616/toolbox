package paint

// Perception tool requests: validation, the crop hand-over and the result
// files (SPEC.md §2.5).
//
// Crop passing. A job's options are persisted, so they never carry image
// bytes. submitAI validates the request, parks the decoded crops in a
// per-module in-memory map under a random token and submits a paint-ai job
// whose options hold the request without images plus that token. Run takes
// the crops out of the map and writes them to <TmpDir>/paint/<jobID>/
// (src.png, mask.png); the engine writes out.png and pass-<n>.png next to
// them and AIResult reads them back. Nothing but the job ID reaches the
// disk before Run, a retried job reuses the files already in its directory,
// and a job that failed or was cancelled drops its directory and its parked
// crops. Directories older than aiKeep are pruned at every submit and
// <TmpDir>/paint is emptied at start (PruneTmp).

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"toolbox/core"
)

// Limits specific to perception requests.
const (
	maxAIPoints      = 64
	maxAIPasses      = 12
	maxEnhancePixels = 1_500_000 // input pixels; the result is up to 4x per side
	maxAIResultBytes = 96 << 20  // one result PNG read back as a data URL
	aiKeep           = time.Hour // finished jobs' files are kept this long
	aiPendingTTL     = 10 * time.Minute
	dataURLPrefix    = "data:image/png;base64,"
)

// aiOptions is a paint-ai job's options: the request without its images.
type aiOptions struct {
	Token     string    `json:"token"`
	ProjectID string    `json:"projectId"`
	Req       AIRequest `json:"req"`
}

type pendingCrops struct {
	source, mask []byte
	at           time.Time
}

// aiState is the per-module crop hand-over state. Module itself is frozen,
// so it lives in a registry keyed by the module.
type aiState struct {
	mu      sync.Mutex
	pending map[string]pendingCrops
	observe sync.Once
}

var aiStates sync.Map // *Module -> *aiState

func (m *Module) ai() *aiState {
	if s, ok := aiStates.Load(m); ok {
		return s.(*aiState)
	}
	s, _ := aiStates.LoadOrStore(m, &aiState{pending: map[string]pendingCrops{}})
	return s.(*aiState)
}

func (s *aiState) park(token string, c pendingCrops) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.pending {
		if time.Since(v.at) > aiPendingTTL {
			delete(s.pending, k)
		}
	}
	s.pending[token] = c
}

func (s *aiState) take(token string) (pendingCrops, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.pending[token]
	delete(s.pending, token)
	return c, ok
}

var jobIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// aiRoot is <TmpDir>/paint.
func (m *Module) aiRoot() string { return filepath.Join(m.cfg.TmpDir, "paint") }

// aiDir is one job's directory; the ID is checked first.
func (m *Module) aiDir(jobID string) (string, error) {
	if m.cfg.TmpDir == "" || !jobIDPattern.MatchString(jobID) {
		return "", core.ValidationError("Unknown job", nil)
	}
	return filepath.Join(m.aiRoot(), jobID), nil
}

// PruneTmp empties <support>/tmp/paint (called once at start, before any job).
func (m *Module) PruneTmp() {
	if m.cfg.TmpDir == "" {
		return
	}
	_ = os.RemoveAll(m.aiRoot())
}

func (m *Module) pruneOld() {
	entries, err := os.ReadDir(m.aiRoot())
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > aiKeep {
			_ = os.RemoveAll(filepath.Join(m.aiRoot(), e.Name()))
		}
	}
}

// watch drops the files and parked crops of jobs that fail or are cancelled.
func (m *Module) watch(jobs *core.Jobs) {
	st := m.ai()
	st.observe.Do(func() {
		jobs.Observe(func(j core.Job) {
			if j.ModuleID != AIModuleID || (j.Status != core.JobFailed && j.Status != core.JobCancelled) {
				return
			}
			var o aiOptions
			if json.Unmarshal([]byte(j.OptionsJSON), &o) == nil && o.Token != "" {
				st.take(o.Token)
			}
			if dir, err := m.aiDir(j.ID); err == nil {
				_ = os.RemoveAll(dir)
			}
		})
	})
}

// decodePNGDataURL returns the PNG bytes and size of a data URL.
func decodePNGDataURL(field, s string) ([]byte, int, int, error) {
	if !strings.HasPrefix(s, dataURLPrefix) {
		return nil, 0, 0, core.ValidationError("The image must be a PNG data URL", map[string]string{field: "not a PNG data URL"})
	}
	if len(s) > MaxAICropBytes*4/3+64 {
		return nil, 0, 0, core.ValidationError("The image is too large", map[string]string{field: "too large"})
	}
	b, err := base64.StdEncoding.DecodeString(s[len(dataURLPrefix):])
	if err != nil || len(b) > MaxAICropBytes {
		return nil, 0, 0, core.ValidationError("The image data is not valid", map[string]string{field: "invalid image data"})
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return nil, 0, 0, core.ValidationError("The image isn't a PNG", map[string]string{field: "not a PNG"})
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > MaxSide || cfg.Height > MaxSide || cfg.Width*cfg.Height > MaxPixels {
		return nil, 0, 0, core.ValidationError("The image is too large", map[string]string{field: "too large"})
	}
	return b, cfg.Width, cfg.Height, nil
}

func unit(v float64) bool { return !math.IsNaN(v) && v >= 0 && v <= 1 }

// normalizeAI checks req (and fills the defaults) and returns the decoded
// crops. Options for the job are req with its images removed.
func normalizeAI(req AIRequest) (AIRequest, pendingCrops, error) {
	bad := func(field, msg string) (AIRequest, pendingCrops, error) {
		return req, pendingCrops{}, core.ValidationError(msg, map[string]string{field: msg})
	}
	switch req.Op {
	case OpFill, OpCutout, OpSegment, OpEnhance:
	default:
		return bad("op", "Unknown tool")
	}
	src, w, h, err := decodePNGDataURL("source", req.Source)
	if err != nil {
		return req, pendingCrops{}, err
	}
	crops := pendingCrops{source: src, at: time.Now()}
	if req.Op == OpFill {
		mask, mw, mh, err := decodePNGDataURL("mask", req.Mask)
		if err != nil {
			return req, pendingCrops{}, err
		}
		if mw != w || mh != h {
			return bad("mask", "The mask must be the same size as the picture")
		}
		crops.mask = mask
	} else if req.Mask != "" {
		return bad("mask", "This tool takes no mask")
	}

	switch req.Op {
	case OpFill:
		switch req.Model {
		case "":
			req.Model = "best"
		case "best", "fast":
		default:
			return bad("model", "The fill model must be best or fast")
		}
		if req.Passes < 1 || req.Passes > maxAIPasses {
			return bad("passes", fmt.Sprintf("Passes must be 1 to %d", maxAIPasses))
		}
		if !unit(req.Ghost) {
			return bad("ghost", "Ghost must be between 0 and 1")
		}
		if !unit(req.Drift) {
			return bad("drift", "Drift must be between 0 and 1")
		}
		switch req.DriftDir {
		case "", "up", "down", "left", "right":
		default:
			return bad("driftDir", "Direction must be up, down, left or right")
		}
		for _, v := range req.Offset {
			if v < -MaxSide || v > MaxSide {
				return bad("offset", "The offset is out of range")
			}
		}
	case OpCutout:
		switch req.Model {
		case "":
			req.Model = "balanced"
		case "fast", "balanced", "best":
		default:
			return bad("model", "The cut-out model must be fast, balanced or best")
		}
	case OpSegment:
		if n := len(req.Points); n < 1 || n > maxAIPoints {
			return bad("points", fmt.Sprintf("Give 1 to %d points", maxAIPoints))
		}
		positive := false
		for _, p := range req.Points {
			if math.IsNaN(p.X) || math.IsNaN(p.Y) || p.X < 0 || p.Y < 0 || p.X > float64(w) || p.Y > float64(h) {
				return bad("points", "A point is outside the picture")
			}
			positive = positive || p.Positive
		}
		if !positive {
			return bad("points", "Add at least one positive point")
		}
	case OpEnhance:
		if req.Model != "" && req.Model != "photo" {
			return bad("model", "Enhance only uses the photo model")
		}
		req.Model = "photo"
		if req.Scale != 2 && req.Scale != 4 {
			return bad("scale", "Scale must be 2 or 4")
		}
		if w*h > maxEnhancePixels {
			return bad("source", "This area is too large to enhance")
		}
	}
	req.Source, req.Mask = "", ""
	return req, crops, nil
}

func newToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// submitAI validates the request and queues a quiet paint-ai job.
func (m *Module) submitAI(jobs *core.Jobs, projectID string, req AIRequest) (core.Job, error) {
	if jobs == nil || m.cfg.TmpDir == "" {
		return core.Job{}, core.Errorf(core.CodeInternal, "The Lab isn't available")
	}
	clean, crops, err := normalizeAI(req)
	if err != nil {
		return core.Job{}, err
	}
	o := aiOptions{Token: newToken(), ProjectID: projectID, Req: clean}
	opts, err := json.Marshal(o)
	if err != nil {
		return core.Job{}, fmt.Errorf("encoding the request: %w", err)
	}
	m.watch(jobs)
	m.pruneOld()
	st := m.ai()
	st.park(o.Token, crops)
	list, err := jobs.Submit(context.Background(), AIModuleID, []string{}, string(opts))
	if err != nil {
		st.take(o.Token)
		return core.Job{}, err
	}
	if len(list) == 0 {
		st.take(o.Token)
		return core.Job{}, core.Errorf(core.CodeInternal, "The request wasn't queued")
	}
	return list[0], nil
}

// aiResult reads a finished job's result PNG: index 0 is the final result,
// 1..Passes the fill passes. Files stay until the job fails, is pruned (an
// hour after its last write) or the app restarts.
func (m *Module) aiResult(jobID string, index int) (string, error) {
	dir, err := m.aiDir(jobID)
	if err != nil {
		return "", err
	}
	if index < 0 || index > maxAIPasses {
		return "", core.ValidationError("Unknown result", map[string]string{"index": "out of range"})
	}
	name := "out.png"
	if index > 0 {
		name = fmt.Sprintf("pass-%d.png", index)
	}
	path := filepath.Join(dir, name)
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return "", core.Errorf(core.CodeNotFound, "That result is gone")
	}
	if fi.Size() > maxAIResultBytes {
		return "", core.Errorf(core.CodeInternal, "The result is too large to show")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading the result: %w", err)
	}
	return dataURLPrefix + base64.StdEncoding.EncodeToString(b), nil
}
