package paint

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/packs"
	"toolbox/core/sidecar"
	"toolbox/modules/upscale"
)

func (a *AIModule) validate(inputs []string, options json.RawMessage) error {
	var o aiOptions
	dec := json.NewDecoder(bytes.NewReader(options))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil || o.Token == "" {
		return core.ValidationError("Invalid Lab request", nil)
	}
	switch o.Req.Op {
	case OpFill, OpCutout, OpSegment, OpEnhance:
	default:
		return core.ValidationError("Unknown Lab tool", map[string]string{"op": string(o.Req.Op)})
	}
	return nil
}

// component names for the gates, by tool.
func needsFor(op AIOp) (component, label string) {
	switch op {
	case OpFill:
		return "inpaint", "the LaMa inpainting model"
	case OpCutout:
		return "bg-default", "the subject cut-out model"
	case OpSegment:
		return "matte-select", "the SAM 2.1 object model"
	default:
		return "upscale-photo", "the Real-ESRGAN photo model"
	}
}

func missingModel(op AIOp) error {
	id, label := needsFor(op)
	return &core.AppError{
		Code:    core.CodeDependencyMissing,
		Message: fmt.Sprintf("%s isn't downloaded", capitalize(label)),
		Hint:    "Get it from the banner at the top of Paint+, or from the Tool packs in Settings.",
		Fields:  map[string]string{"component": id},
	}
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// resolve returns the engine's model parameters for a request.
func (m *Module) resolve(req AIRequest) (map[string]any, error) {
	r := m.cfg.Models
	if r == nil {
		return nil, missingModel(req.Op)
	}
	var (
		raw json.RawMessage
		ok  bool
	)
	switch req.Op {
	case OpFill:
		raw, ok = r.Inpaint(req.Model)
	case OpCutout:
		raw, ok = r.Cutout(req.Model)
	case OpSegment:
		raw, ok = r.Segment()
	case OpEnhance:
		raw, ok = r.Enhance(req.Model)
	}
	if !ok {
		return nil, missingModel(req.Op)
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("reading the %s model: %w", req.Op, err)
	}
	return out, nil
}

func writeCrop(path string, b []byte) error {
	tmp := path + ".part"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("writing the crop: %w", err)
	}
	return os.Rename(tmp, path)
}

// run executes one perception call (see ai_request.go for the crop hand-over).
func (a *AIModule) run(ctx context.Context, job *core.JobContext) error {
	m := a.m
	o, err := core.DecodeOptions[aiOptions](job)
	if err != nil {
		return err
	}
	if m.cfg.Engine == nil {
		return core.Errorf(core.CodeInternal, "The AI engine isn't available")
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	dir, err := m.aiDir(job.ID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("creating the Lab folder: %w", err)
	}
	src, mask := filepath.Join(dir, "src.png"), filepath.Join(dir, "mask.png")
	if crops, ok := m.ai().take(o.Token); ok {
		if err := writeCrop(src, crops.source); err != nil {
			return err
		}
		if o.Req.Op == OpFill {
			if err := writeCrop(mask, crops.mask); err != nil {
				return err
			}
		}
	} else if _, err := os.Stat(src); err != nil { // a retry reuses the files
		return core.Errorf(core.CodeNotFound, "This request expired. Try the stroke again.")
	}

	params, err := m.resolve(o.Req)
	if err != nil {
		return err
	}
	out := filepath.Join(dir, "out.png")
	params["src"], params["out"] = src, out
	switch o.Req.Op {
	case OpFill:
		params["mask"] = mask
		params["passes"] = o.Req.Passes
		params["ghost"] = o.Req.Ghost
		params["drift"] = o.Req.Drift
		params["driftDir"] = o.Req.DriftDir
		params["offset"] = []int{o.Req.Offset[0], o.Req.Offset[1]}
		params["seed"] = o.Req.Seed
	case OpSegment:
		params["points"] = o.Req.Points
	case OpEnhance:
		params["scale"] = o.Req.Scale
	}

	job.Progress(core.IndeterminateProgress, "Starting the AI engine…")
	raw, err := m.cfg.Engine.Call(ctx, "paint."+string(o.Req.Op), params, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			job.Progress(ev.Pct, ev.Msg)
		case "log":
			stream := core.StreamStdout
			if ev.Level == "warning" || ev.Level == "error" {
				stream = core.StreamStderr
			}
			job.Log(stream, ev.Line)
		}
	})
	if err != nil {
		return err
	}
	var res struct {
		Passes int     `json:"passes"`
		Score  float64 `json:"score"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("reading the engine's result: %w", err)
	}
	info := AIResultInfo{Op: o.Req.Op, Score: res.Score}
	if o.Req.Op == OpFill {
		info.Passes = res.Passes
	}
	b, err := os.ReadFile(out)
	if err != nil {
		return fmt.Errorf("the engine produced no result: %w", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return fmt.Errorf("the engine's result isn't a PNG: %w", err)
	}
	info.Width, info.Height = cfg.Width, cfg.Height
	return job.SetResult(info)
}

// ---- status and warm-up ----

func (m *Module) engineReady() bool {
	if m.cfg.Resolve == nil {
		return false
	}
	_, err := m.cfg.Resolve(sidecar.DepID)
	return err == nil
}

func (m *Module) modelReady(op AIOp) bool {
	r := m.cfg.Models
	if r == nil {
		return false
	}
	switch op {
	case OpFill:
		_, a := r.Inpaint("best")
		_, b := r.Inpaint("fast")
		return a || b
	case OpCutout:
		for _, p := range []string{"balanced", "best", "fast"} {
			if _, ok := r.Cutout(p); ok {
				return true
			}
		}
		return false
	case OpSegment:
		_, ok := r.Segment()
		return ok
	default:
		_, ok := r.Enhance("")
		return ok
	}
}

// modelBytes is the download size of a tool's model on this platform.
func modelBytes(op AIOp) int64 {
	if op == OpEnhance {
		if pin, ok := upscale.CPUPin(upscale.PhotoPreset); ok {
			return pin.Bytes
		}
		return 0
	}
	id, _ := needsFor(op)
	key := packs.PlatformKey(runtime.GOOS, runtime.GOARCH)
	for _, c := range packs.Components() {
		if c.ID == id {
			return c.Sizes[key].Download
		}
	}
	return 0
}

func (m *Module) aiStatus() []AIModelInfo {
	engine := m.engineReady()
	out := make([]AIModelInfo, 0, 4)
	for _, op := range []AIOp{OpFill, OpCutout, OpSegment, OpEnhance} {
		info := AIModelInfo{Tool: string(op), Needs: []string{}}
		hasModel := m.modelReady(op)
		var reasons []string
		if !engine {
			info.Needs = append(info.Needs, "engine")
			reasons = append(reasons, "the AI engine")
		}
		if !hasModel {
			id, label := needsFor(op)
			info.Needs = append(info.Needs, id)
			reasons = append(reasons, label)
			info.ModelSize = modelBytes(op)
		}
		info.Ready = len(info.Needs) == 0
		switch len(reasons) {
		case 1:
			info.Reason = "Needs " + reasons[0]
		case 2:
			info.Reason = "Needs " + reasons[0] + " and " + reasons[1]
		}
		out = append(out, info)
	}
	return out
}

// warm starts the engine (when installed) and loads the inpainting models
// that are present. It never downloads and never fails the caller.
func (m *Module) warm(ctx context.Context) error {
	if m.cfg.Engine == nil || m.cfg.Models == nil || !m.engineReady() {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	for _, model := range []string{"fast", "best"} {
		raw, ok := m.cfg.Models.Inpaint(model)
		if !ok {
			continue
		}
		params := map[string]any{}
		if json.Unmarshal(raw, &params) != nil || params["model"] != model {
			continue // a fallback to the other model: it is loaded on its own turn
		}
		if _, err := m.cfg.Engine.Call(ctx, "paint.warm", params, nil); err != nil {
			slog.Warn("paint warm-up", "model", model, "err", err)
			return nil
		}
	}
	return nil
}
