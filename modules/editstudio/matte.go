package editstudio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
	"toolbox/modules/bgremove"
)

// Matte jobs and state (SPEC.md §10.2, §10.5). WP-ES7.
//
// Files, all in <ProjectsDir>/<project>/mattes/:
//
//	<id>-export.h264 + .idx.json   grey Y = alpha, the export stream's size (short side ≤ 1080)
//	<id>-preview.h264 + .idx.json  the same at a short side of 540
//	<id>.json                      what the files cover (matteMeta)
//	<id>.png                       image mattes
//	<id>-try.png                   the one-frame preview of a select job

const (
	// mattePadMs pads a matte's range on both sides so small trims don't invalidate it (§10.5).
	mattePadMs = 500
	// matteMaxShort caps a video matte's short side (§10.2).
	matteMaxShort = 1080
	// previewMatteShort is the preview copy's short side.
	previewMatteShort = 540
	// tryKeep is how long Save keeps a preview PNG nobody references.
	tryKeep = time.Hour
	// defaultExportHeight is used when a project has none.
	defaultExportHeight = 1080
)

// matteMeta is <id>.json: the range a video matte covers.
type matteMeta struct {
	Mode   string `json:"mode"`
	FromMs int64  `json:"fromMs"` // padded source range the files cover
	ToMs   int64  `json:"toMs"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	FPS    int    `json:"fps"`
}

// Seams: tests replace these (the real ones need FFmpeg, ffprobe and the engine).
var (
	probeFn = func(ctx context.Context, ffprobe, path string) (media.Info, error) {
		return media.Probe(ctx, ffprobe, path)
	}
	ensureStream = func(m *Module, ctx context.Context, job *core.JobContext, path string, short, fps int, on func(float64)) (EditStream, error) {
		return m.EnsureStream(ctx, job, path, short, fps, on)
	}
	writeIndexFn  = WriteIndex
	previewCopyFn = makePreviewCopy
)

func (m *Module) mattesDir(projectID string) string {
	return filepath.Join(m.docs.Dir(projectID), "mattes")
}

// outputSize is the project's export size (viz/edit/types.ts sizeFor): short side = ExportHeight.
func outputSize(aspect string, short int) (w, h int) {
	even := func(v float64) int { return int(math.Round(v/2)) * 2 }
	switch aspect {
	case "9:16":
		return short, even(float64(short) * 16 / 9)
	case "4:5":
		return short, even(float64(short) * 5 / 4)
	case "16:9":
		return even(float64(short) * 16 / 9), short
	}
	return short, short
}

// matteSize caps a stream's size at a short side of limit (even sizes; never enlarged).
func matteSize(w, h, limit int) (int, int) {
	short := min(w, h)
	if short <= limit {
		return w, h
	}
	s := float64(limit) / float64(short)
	even := func(v float64) int { return max(2, int(math.Round(v/2))*2) }
	return even(float64(w) * s), even(float64(h) * s)
}

// frameOf is the frame number of source ms at fps (§7.1).
func frameOf(ms int64, fps int) int { return int(math.Round(float64(ms) * float64(fps) / 1000)) }

// padRange pads [from, to] by mattePadMs, clamped to [0, durationMs] (durationMs 0 = unknown, no upper clamp).
func padRange(from, to, durationMs int64) (int64, int64) {
	from = max(0, from-mattePadMs)
	to += mattePadMs
	if durationMs > 0 {
		to = min(to, durationMs)
	}
	return from, to
}

// matteSink maps engine events onto a job, scaling progress into [base, base+span].
// Matte files are project data: outputs are not registered in the Library.
type matteSink struct {
	job        *core.JobContext
	base, span float64
}

func (s *matteSink) onEvent(ev sidecar.Event) {
	switch ev.Kind {
	case "progress":
		pct := ev.Pct
		if pct >= 0 {
			pct = s.base + pct*s.span
		}
		s.job.Progress(pct, ev.Msg)
	case "log":
		stream := core.StreamStdout
		if ev.Level == "warning" || ev.Level == "error" {
			stream = core.StreamStderr
		}
		s.job.Log(stream, ev.Line)
	}
}

// requireMatteModel reports a missing model with the install hint of its pack.
func (m *Module) requireMatteModel(mode string) error {
	switch mode {
	case MatteImage:
		if !m.imageModelPresent() {
			return core.ErrDependencyMissing("Photo cut-out model", "Install the Image tool pack in Settings")
		}
	case MattePeople:
		if !m.ModelPresent(PresetPeople) {
			return core.ErrDependencyMissing(matteModelPins[PresetPeople].Label, "Install the Music edits tool pack in Settings")
		}
	default:
		if !m.ModelPresent(PresetSelect) {
			return core.ErrDependencyMissing(matteModelPins[PresetSelect].Label, "Install the Music edits tool pack in Settings")
		}
	}
	return nil
}

// runMatte is the matte action (it holds the module's matte slot, §10.5).
func (m *Module) runMatte(ctx context.Context, job *core.JobContext, projectID string, req MatteRequest) error {
	release, err := m.acquireMatte(ctx, job)
	if err != nil {
		return err
	}
	defer release()
	job.SetTitle("Cut-out — " + filepath.Base(req.Path))
	if m.cfg.Engine == nil {
		return core.Errorf(core.CodeInternal, "The AI engine isn't available")
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	if err := m.requireMatteModel(req.Mode); err != nil {
		return err
	}
	dir := m.mattesDir(projectID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating the cut-outs folder: %w", err)
	}
	if req.Mode == MatteImage {
		return m.runImageMatte(ctx, job, dir, req)
	}
	return m.runVideoMatte(ctx, job, projectID, dir, req)
}

// runImageMatte makes a photo's matte with Background Remover's balanced model (mask output).
func (m *Module) runImageMatte(ctx context.Context, job *core.JobContext, dir string, req MatteRequest) error {
	spec, ok := bgremove.SpecFor("balanced")
	if !ok {
		return core.Errorf(core.CodeInternal, "The photo cut-out model isn't known")
	}
	job.Progress(core.IndeterminateProgress, "Cutting out the subject")
	sink := &matteSink{job: job, span: 1}
	raw, err := m.cfg.Engine.Call(ctx, "bgremove.run", map[string]any{
		"input": req.Path, "outputDir": job.TempDir, "baseName": req.MatteID,
		"model":    map[string]any{"file": spec.File, "sha256": spec.SHA256, "url": spec.URL, "kind": spec.Kind},
		"modelDir": bgremove.ModelDir(m.cfg.ModelsDir),
		"output":   "mask", "color": "#ffffff", "crop": false, "padding": 0, "cleanEdges": true, "refine": false,
	}, sink.onEvent)
	if err != nil {
		return err
	}
	var res struct {
		Output string `json:"output"`
	}
	if err := json.Unmarshal(raw, &res); err != nil || res.Output == "" {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	dst := filepath.Join(dir, req.MatteID+".png")
	if err := moveFile(res.Output, dst); err != nil {
		return err
	}
	job.Progress(1, "Cut-out ready")
	return job.SetResult(Result{Action: ActionMatte, Matte: &MatteState{ID: req.MatteID, Ready: true, Image: dst}})
}

// runVideoMatte makes a video matte (people or select) or a select preview.
func (m *Module) runVideoMatte(ctx context.Context, job *core.JobContext, projectID, dir string, req MatteRequest) error {
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	doc, err := m.Get(ctx, projectID)
	if err != nil {
		return err
	}
	fps := doc.FPS
	if fps <= 0 {
		fps = 30
	}
	info, err := probeFn(ctx, ffprobe, req.Path)
	if err != nil {
		return err
	}
	if info.Video == nil {
		return core.ValidationError("This clip has no video", map[string]string{"path": "This clip has no video"})
	}
	outW, outH := outputSize(doc.Aspect, orDefault(doc.ExportHeight, defaultExportHeight))
	sw, sh := info.Video.Width, info.Video.Height

	if req.Preview {
		return m.runSelectPreview(ctx, job, dir, req, fps, ffmpeg, sw, sh)
	}

	job.Progress(0, "Preparing the clip")
	stream, err := ensureStream(m, ctx, job, req.Path, ExportShort(sw, sh, outW, outH), fps, func(p float64) {
		job.Progress(0.05*p, "Preparing the clip")
	})
	if err != nil {
		return err
	}
	mw, mh := matteSize(stream.Width, stream.Height, matteMaxShort)
	from, to := padRange(req.FromMs, req.ToMs, info.DurationMs)
	fromFrame := min(frameOf(from, fps), max(stream.Frames-1, 0))
	toFrame := min(frameOf(to, fps)+1, stream.Frames)
	if toFrame <= fromFrame {
		return core.ValidationError("The clip's range is outside its video", map[string]string{"toMs": "The clip's range is outside its video"})
	}

	method := "matte.people"
	spec := matteModelPins[PresetPeople]
	params := map[string]any{
		"ffmpeg": ffmpeg, "stream": stream.Stream, "index": stream.Index, "fromFrame": fromFrame, "toFrame": toFrame,
		"fps": fps, "width": mw, "height": mh, "workDir": job.TempDir,
		"modelDir": m.matteModelDir(),
	}
	if req.Mode == MatteSelect {
		method, spec = "matte.select", matteModelPins[PresetSelect]
		clicks, err := engineClicks(req.Clicks, req.FromMs, req.ToMs, fps, fromFrame, toFrame, mw, mh)
		if err != nil {
			return err
		}
		params["clicks"] = clicks
	}
	params["model"] = map[string]any{"file": spec.File, "sha256": spec.SHA256}
	exportPath := filepath.Join(dir, req.MatteID+"-export.h264")
	params["outPath"] = exportPath

	sink := &matteSink{job: job, base: 0.05, span: 0.85}
	if _, err := m.cfg.Engine.Call(ctx, method, params, sink.onEvent); err != nil {
		return err
	}
	if _, err := writeIndexFn(exportPath, mw, mh, fps); err != nil {
		return err
	}

	job.Progress(0.9, "Making the preview copy")
	previewPath := filepath.Join(dir, req.MatteID+"-preview.h264")
	pw, ph := matteSize(mw, mh, previewMatteShort)
	if err := previewCopyFn(ctx, ffmpeg, exportPath, previewPath, mw, mh, pw, ph, fps); err != nil {
		return err
	}
	if _, err := writeIndexFn(previewPath, pw, ph, fps); err != nil {
		return err
	}
	meta := matteMeta{Mode: req.Mode, FromMs: from, ToMs: to, Width: mw, Height: mh, FPS: fps}
	if err := writeJSON(filepath.Join(dir, req.MatteID+".json"), meta); err != nil {
		return err
	}
	state, err := m.stateOf(dir, req.MatteID)
	if err != nil {
		return err
	}
	job.Progress(1, "Cut-out ready")
	return job.SetResult(Result{Action: ActionMatte, Matte: &state})
}

// runSelectPreview runs SAM on one frame (the first click's) and returns the PNG mask.
func (m *Module) runSelectPreview(ctx context.Context, job *core.JobContext, dir string, req MatteRequest, fps int, ffmpeg string, sw, sh int) error {
	if len(req.Clicks) == 0 {
		return core.ValidationError("Click the subject first", map[string]string{"clicks": "Click the subject first"})
	}
	// The preview tier is enough for a try and is usually made already.
	short := PreviewShort(sw, sh)
	stream, err := ensureStream(m, ctx, job, req.Path, short, fps, func(p float64) { job.Progress(0.5*p, "Preparing the clip") })
	if err != nil {
		return err
	}
	frame := min(frameOf(req.Clicks[0].Ms, fps), max(stream.Frames-1, 0))
	pw, ph := matteSize(stream.Width, stream.Height, matteMaxShort)
	var clicks []map[string]any
	for _, k := range req.Clicks {
		if min(frameOf(k.Ms, fps), max(stream.Frames-1, 0)) == frame {
			clicks = append(clicks, map[string]any{"frame": frame, "x": k.X * float64(pw), "y": k.Y * float64(ph), "positive": k.Positive})
		}
	}
	out := filepath.Join(dir, req.MatteID+"-try.png")
	spec := matteModelPins[PresetSelect]
	sink := &matteSink{job: job, base: 0.5, span: 0.5}
	_, err = m.cfg.Engine.Call(ctx, "matte.select_preview", map[string]any{
		"ffmpeg": ffmpeg, "stream": stream.Stream, "index": stream.Index, "fromFrame": frame, "toFrame": frame + 1,
		"fps": fps, "width": pw, "height": ph, "workDir": job.TempDir, "clicks": clicks, "outPath": out,
		"model": map[string]any{"file": spec.File, "sha256": spec.SHA256}, "modelDir": m.matteModelDir(),
	}, sink.onEvent)
	if err != nil {
		return err
	}
	job.Progress(1, "Preview ready")
	return job.SetResult(Result{Action: ActionMatte, TryPath: out})
}

// engineClicks converts the request's clicks (source ms, 0..1) to the engine's (absolute frame, matte pixels).
func engineClicks(in []MatteClick, fromMs, toMs int64, fps, fromFrame, toFrame, mw, mh int) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(in))
	for _, k := range in {
		if k.Ms < fromMs-mattePadMs || k.Ms > toMs+mattePadMs {
			return nil, core.ValidationError("A click is outside the clip's range", map[string]string{"clicks": "A click is outside the clip's range"})
		}
		f := min(max(frameOf(k.Ms, fps), fromFrame), toFrame-1)
		out = append(out, map[string]any{"frame": f, "x": k.X * float64(mw), "y": k.Y * float64(mh), "positive": k.Positive})
	}
	return out, nil
}

// makePreviewCopy transcodes the export matte to the preview size (same encoder settings, §7.1).
func makePreviewCopy(ctx context.Context, ffmpeg, src, dst string, w, h, pw, ph, fps int) error {
	if pw == w && ph == h {
		return copyFile(src, dst)
	}
	part := dst + ".part"
	args := []string{
		"-hide_banner", "-nostdin", "-y", "-v", "error", "-f", "h264", "-framerate", strconv.Itoa(fps), "-i", src,
		"-an", "-sn", "-fps_mode", "passthrough", "-vf", fmt.Sprintf("scale=%d:%d:flags=bilinear,format=yuv420p", pw, ph),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-bf", "0", "-g", "10",
		"-keyint_min", "10", "-sc_threshold", "0", "-x264-params", "aud=1:repeat-headers=1", "-f", "h264", part,
	}
	res, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: args})
	if err != nil {
		_ = os.Remove(part)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return core.Errorf(core.CodeToolFailed, "FFmpeg couldn't make the cut-out's preview copy").
			WithHint(strings.Join(res.StderrTail, "\n")).WithCause(err)
	}
	return os.Rename(part, dst)
}

// -- state ------------------------------------------------------------------------------

func validMatteID(id string) bool { return idRe.MatchString(id) }

func readMeta(path string) (matteMeta, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return matteMeta{}, false
	}
	var meta matteMeta
	if json.Unmarshal(b, &meta) != nil || meta.ToMs <= meta.FromMs {
		return matteMeta{}, false
	}
	return meta, true
}

func streamOf(stream string) (*EditStream, bool) {
	b, err := os.ReadFile(IndexPath(stream))
	if err != nil {
		return nil, false
	}
	var idx StreamIndex
	if json.Unmarshal(b, &idx) != nil || idx.Frames < 1 {
		return nil, false
	}
	if fi, err := os.Stat(stream); err != nil || !fi.Mode().IsRegular() {
		return nil, false
	}
	return &EditStream{Stream: stream, Index: IndexPath(stream), Width: idx.Width, Height: idx.Height, FPS: idx.FPS, Frames: idx.Frames}, true
}

// stateOf reads one matte's files; Ready is false when any is missing.
func (m *Module) stateOf(dir, id string) (MatteState, error) {
	st := MatteState{ID: id}
	if !validMatteID(id) {
		return st, nil
	}
	if png := filepath.Join(dir, id+".png"); fileExists(png) {
		st.Ready, st.Image = true, png
		return st, nil
	}
	meta, ok := readMeta(filepath.Join(dir, id+".json"))
	if !ok {
		return st, nil
	}
	exp, ok1 := streamOf(filepath.Join(dir, id+"-export.h264"))
	prev, ok2 := streamOf(filepath.Join(dir, id+"-preview.h264"))
	if !ok1 || !ok2 {
		return st, nil
	}
	st.Ready, st.FromMs, st.ToMs, st.Export, st.Preview = true, meta.FromMs, meta.ToMs, exp, prev
	return st, nil
}

// matteStates reports the files of a project's mattes.
func (m *Module) matteStates(projectID string, ids []string) ([]MatteState, error) {
	dir := m.mattesDir(projectID)
	out := make([]MatteState, 0, len(ids))
	for _, id := range ids {
		st, err := m.stateOf(dir, id)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, nil
}

// clipSourceSpan is the source range [InMs, end] a video clip can show. Go can't evaluate speed keys
// exactly, so the end assumes the clip runs at its fastest speed the whole time (the keys' maximum, or the
// base without keys; "" = 1). That over-estimates for curves: a matte may be called out of date a little early,
// never too late.
func clipSourceSpan(c Clip) (from, to int64) {
	return c.InMs, c.InMs + int64(math.Ceil(float64(c.EndMs-c.StartMs)*maxSpeed(c.Speed)))
}

// maxSpeed reads an EditParam JSON ({"base":1,"keys":[{"t":0,"v":1,...}]}); "" or unreadable = 1.
func maxSpeed(speed string) float64 {
	if strings.TrimSpace(speed) == "" {
		return 1
	}
	var p struct {
		Base *float64 `json:"base"`
		Keys []struct {
			V float64 `json:"v"`
		} `json:"keys"`
	}
	if json.Unmarshal([]byte(speed), &p) != nil {
		return 1
	}
	if len(p.Keys) > 0 {
		best := 0.0
		for _, k := range p.Keys {
			best = math.Max(best, k.V)
		}
		return best
	}
	if p.Base != nil {
		return *p.Base
	}
	return 1
}

// matteReady is true when a clip's matte files exist and cover its source range.
func (m *Module) matteReady(projectID string, c Clip) (bool, error) {
	if c.Matte == nil || !validMatteID(c.Matte.ID) {
		return false, nil
	}
	st, err := m.stateOf(m.mattesDir(projectID), c.Matte.ID)
	if err != nil || !st.Ready {
		return false, err
	}
	if st.Image != "" {
		return true, nil
	}
	from, to := clipSourceSpan(c)
	return from >= st.FromMs && to <= st.ToMs, nil
}

var matteFileRe = regexp.MustCompile(`^(.+?)(-export\.|-preview\.|-try\.png|\.png|\.json)`)

// matteIDsInJobs are the matte IDs of a project's queued or running matte jobs.
func matteIDsInJobs(projectID string, jobs []core.Job) map[string]bool {
	out := map[string]bool{}
	for _, j := range jobs {
		var o Options
		if json.Unmarshal([]byte(j.OptionsJSON), &o) != nil {
			continue
		}
		if o.Action == ActionMatte && o.ProjectID == projectID && o.Matte != nil {
			out[o.Matte.MatteID] = true
		}
	}
	return out
}

// pruneMattes deletes matte files no clip of doc uses and no running job is making.
func (m *Module) pruneMattes(projectID string, doc EditProject) {
	dir := m.mattesDir(projectID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	keep := map[string]bool{}
	for _, t := range doc.Tracks {
		for _, c := range t.Clips {
			if c.Matte != nil {
				keep[c.Matte.ID] = true
			}
		}
	}
	if m.cfg.Jobs != nil {
		jobs, err := m.cfg.Jobs.List(context.Background(), core.JobFilter{
			ModuleID: ModuleID, Statuses: []core.JobStatus{core.JobQueued, core.JobRunning}, Limit: 500,
		})
		if err != nil {
			return // can't tell what is being made: delete nothing
		}
		for id := range matteIDsInJobs(projectID, jobs) {
			keep[id] = true
		}
	}
	for _, e := range entries {
		sub := matteFileRe.FindStringSubmatch(e.Name())
		if sub == nil || keep[sub[1]] {
			continue
		}
		if strings.HasSuffix(e.Name(), "-try.png") {
			if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) < tryKeep {
				continue
			}
		}
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
}

// -- small file helpers -----------------------------------------------------------------

func orDefault(v, d int) int {
	if v <= 0 {
		return d
	}
	return v
}

func writeJSON(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	part := path + ".part"
	if err := os.WriteFile(part, b, 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", filepath.Base(path), err)
	}
	return os.Rename(part, path)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("opening %s: %w", filepath.Base(src), err)
	}
	defer in.Close()
	part := dst + ".part"
	out, err := os.Create(part)
	if err != nil {
		return fmt.Errorf("creating %s: %w", filepath.Base(dst), err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(part)
		return fmt.Errorf("copying %s: %w", filepath.Base(src), err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(part)
		return err
	}
	return os.Rename(part, dst)
}

// moveFile renames, falling back to copy + delete across volumes.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyFile(src, dst); err != nil {
		return err
	}
	if err := os.Remove(src); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
