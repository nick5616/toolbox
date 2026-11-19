package editstudio

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/viz"
)

// The render actions: the video export, the audio-only export and the still
// frame (SPEC.md §12.1; Phase 21 §B6, §E3.5).

// cancelledOr is "<what> cancelled" when ctx is done, else err.
func cancelledOr(ctx context.Context, what string, err error) error {
	if ctx.Err() != nil {
		return fmt.Errorf("%s cancelled: %w", what, ctx.Err())
	}
	return err
}

// runRender is the render action.
func (m *Module) runRender(ctx context.Context, job *core.JobContext, projectID string) error {
	stored, err := m.docs.Load(ctx, projectID)
	if err != nil {
		return err
	}
	doc, err := m.Get(ctx, projectID)
	if err != nil {
		return err
	}
	return m.renderDoc(ctx, job, projectID, stored.Name, doc)
}

// runRenderAudio is the audio-only action: the mix as <library>/Edits/<name>.m4a.
func (m *Module) runRenderAudio(ctx context.Context, job *core.JobContext, projectID string) error {
	stored, err := m.docs.Load(ctx, projectID)
	if err != nil {
		return err
	}
	doc, err := m.Get(ctx, projectID)
	if err != nil {
		return err
	}
	return m.renderAudioDoc(ctx, job, stored.Name, doc)
}

// runRenderStill is the still action: one frame as <library>/Edits/<name>.png.
func (m *Module) runRenderStill(ctx context.Context, job *core.JobContext, projectID string, req StillRequest) error {
	stored, err := m.docs.Load(ctx, projectID)
	if err != nil {
		return err
	}
	doc, err := m.Get(ctx, projectID)
	if err != nil {
		return err
	}
	return m.renderStillDoc(ctx, job, projectID, stored.Name, doc, req.AtMs)
}

// buildPlan makes every file the render reads (progress through sources) and
// the broker's plan at the document's output size.
func (m *Module) buildPlan(ctx context.Context, sources *core.JobContext, projectID string, doc EditProject, ffprobe string) (viz.RenderPlan, error) {
	// Without an analysis (a Video Editor project) the plan carries the zero ref
	// and the worker renders against an empty analysis.
	var ref viz.AnalysisRef
	if doc.AnalysisKey != "" {
		var ok bool
		ref, ok = m.cfg.Analyzer.Lookup(doc.AnalysisKey)
		if !ok {
			return viz.RenderPlan{}, core.ValidationError("The song's analysis isn't cached any more. Analyze it again", map[string]string{"analysisKey": "Analyze the song again"})
		}
	}
	outW, outH := docOutputSize(doc)
	streams, images, err := m.ensureExportFiles(ctx, sources, projectID, doc, ffprobe, outW, outH)
	if err != nil {
		return viz.RenderPlan{}, err
	}
	pj, err := json.Marshal(normalize(doc))
	if err != nil {
		return viz.RenderPlan{}, fmt.Errorf("encode project: %w", err)
	}
	if len(pj) > maxProjectJSON {
		return viz.RenderPlan{}, core.ValidationError("This edit is too large to export", nil)
	}
	return newRenderPlan(doc, ref, outW, outH, string(pj), streams, images), nil
}

// renderDoc exports doc as <library>/Edits/<name>.mp4. projectID names the
// stored project whose mattes the clips use ("" = none, e.g. an edit a
// pipeline step built in memory). doc.Export picks the rate, codec, quality,
// audio rate and range.
func (m *Module) renderDoc(ctx context.Context, job *core.JobContext, projectID, name string, doc EditProject) error {
	start := exportNowFn()
	job.SetTitle("Exporting — " + name)
	if err := m.validateDoc(ctx, projectID, doc); err != nil {
		return err
	}
	if err := validateVideoSize(docOutputSize(doc)); err != nil {
		return err
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	ex := resolveExport(doc)
	if ex.Codec == CodecH265 && !exportEncoderFn(ctx, ffmpeg, "libx265") {
		job.Logf("This FFmpeg has no H.265 encoder (libx265); exporting H.264 instead")
		ex = ex.withH264()
	}

	plan, err := m.buildPlan(ctx, job.Scoped(0, exportSourcesTo), projectID, doc, ffprobe)
	if err != nil {
		return cancelledOr(ctx, "export", err)
	}
	ex.applyTo(&plan)
	enc, err := exportRenderFn(ctx, m.cfg.Broker, job.Scoped(exportSourcesTo, exportRenderTo), plan)
	if err != nil {
		return cancelledOr(ctx, "export", err)
	}
	if enc.Path != "" {
		defer os.Remove(enc.Path) // the stream is large; the TempDir goes later anyway
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("export cancelled: %w", err)
	}

	job.Progress(exportRenderTo, "Mixing the audio…")
	mixPath := filepath.Join(job.TempDir, "mix.wav")
	if err := exportMixFn(m, ctx, job.Scoped(exportRenderTo, exportAudioTo), doc, ffmpeg, mixPath); err != nil {
		return cancelledOr(ctx, "export", err)
	}

	job.Progress(exportAudioTo, "Finishing the video…")
	tmp := filepath.Join(job.TempDir, "edit.mp4")
	spec := muxSpec{
		FPS: ex.FPS, Codec: ex.Codec, CRF: ex.CRF, Preset: ex.Preset, AudioKbps: ex.AudioKbps,
		Reencode: ex.Custom,
	}
	if ex.Ranged {
		spec.AudioStartMs, spec.AudioLenMs = ex.InMs, ex.OutMs-ex.InMs
	}
	err = exportMuxFn(ctx, ffmpeg, enc, mixPath, spec, tmp, func(p float64) {
		job.Progress(exportAudioTo+p*(1-exportAudioTo), "Finishing the video…")
	})
	if err != nil {
		_ = os.Remove(tmp)
		return cancelledOr(ctx, "export", err)
	}
	// The mux writes into the TempDir and the finished file is moved into the
	// Library, so a cancel never leaves a half file there.
	dst := core.UniquePath(job.OutputDir, fileStem(name, "Edit"), ".mp4")
	if err := exportMove(tmp, dst); err != nil {
		return cancelledOr(ctx, "export", core.Errorf(core.CodeToolFailed, "Couldn't save the video").WithCause(err))
	}
	if _, err := job.Output(dst); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	res := Result{Action: ActionRender, Outputs: []string{dst}, Encoder: enc.Encoder}
	if wall := exportNowFn().Sub(start).Seconds(); wall > 0 {
		res.Speed = float64(ex.lengthMs(editLen(doc))) / 1000 / wall
	}
	job.Progress(1, "Saved "+filepath.Base(dst))
	return job.SetResult(res)
}

// validateAudioDoc checks what an audio-only export needs: the shape, the
// files, and something to hear (a song or an audible clip).
func (m *Module) validateAudioDoc(ctx context.Context, doc EditProject) error {
	if err := validateShape(doc); err != nil {
		return err
	}
	heard := false
	if doc.Song != nil {
		if !fileExists(doc.Song.Path) {
			return vErr("song.path", "The song "+baseName(doc.Song.Path)+" is missing")
		}
		heard = true
	}
	for _, c := range audibleClips(doc) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !fileExists(c.Path) {
			return vErr("tracks", baseName(c.Path)+" is missing")
		}
		heard = true
	}
	if !heard {
		return vErr("tracks", "There's no sound in this edit yet")
	}
	return nil
}

// renderAudioDoc writes the edit's mix as <library>/Edits/<name>.m4a.
func (m *Module) renderAudioDoc(ctx context.Context, job *core.JobContext, name string, doc EditProject) error {
	job.SetTitle("Exporting audio — " + name)
	if err := m.validateAudioDoc(ctx, doc); err != nil {
		return err
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ex := resolveExport(doc)
	const mixTo = 0.7
	job.Progress(0, "Mixing the audio…")
	mixPath := filepath.Join(job.TempDir, "mix.wav")
	if err := exportMixFn(m, ctx, job.Scoped(0, mixTo), doc, ffmpeg, mixPath); err != nil {
		return cancelledOr(ctx, "export", err)
	}
	var startMs, lenMs int64
	if ex.Ranged {
		startMs, lenMs = ex.InMs, ex.OutMs-ex.InMs
	}
	tmp := filepath.Join(job.TempDir, "edit.m4a")
	err = exportAudioFn(ctx, ffmpeg, mixPath, ex.AudioKbps, startMs, lenMs, ex.lengthMs(editLen(doc)), tmp, func(p float64) {
		job.Progress(mixTo+p*(1-mixTo), "Saving the audio…")
	})
	if err != nil {
		_ = os.Remove(tmp)
		return cancelledOr(ctx, "export", err)
	}
	dst := core.UniquePath(job.OutputDir, fileStem(name, "Edit"), ".m4a")
	if err := exportMove(tmp, dst); err != nil {
		return cancelledOr(ctx, "export", core.Errorf(core.CodeToolFailed, "Couldn't save the audio").WithCause(err))
	}
	if _, err := job.Output(dst); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	job.Progress(1, "Saved "+filepath.Base(dst))
	return job.SetResult(Result{Action: ActionRenderAudio, Outputs: []string{dst}})
}

// renderStillDoc renders one frame of the edit at atMs (timeline ms) as
// <library>/Edits/<name>.png, at the export size (or doc.Size). The host
// draws it (RenderPlan.Still); this builds the plan and saves the file.
func (m *Module) renderStillDoc(ctx context.Context, job *core.JobContext, projectID, name string, doc EditProject, atMs int64) error {
	job.SetTitle("Saving a frame — " + name)
	if err := m.validateDoc(ctx, projectID, doc); err != nil {
		return err
	}
	if atMs < 0 || atMs >= editLen(doc) {
		return vErr("still.atMs", "Pick a frame inside the edit")
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	const sourcesTo = 0.6
	plan, err := m.buildPlan(ctx, job.Scoped(0, sourcesTo), projectID, doc, ffprobe)
	if err != nil {
		return cancelledOr(ctx, "export", err)
	}
	plan.Still = &viz.StillPlan{AtMs: atMs, Format: "png"}
	enc, err := exportRenderFn(ctx, m.cfg.Broker, job.Scoped(sourcesTo, 0.95), plan)
	if err != nil {
		return cancelledOr(ctx, "export", err)
	}
	if enc.Path == "" {
		return core.Errorf(core.CodeInternal, "The renderer returned no picture")
	}
	dst := core.UniquePath(job.OutputDir, fileStem(name, "Edit"), ".png")
	if err := exportMove(enc.Path, dst); err != nil {
		return cancelledOr(ctx, "export", core.Errorf(core.CodeToolFailed, "Couldn't save the picture").WithCause(err))
	}
	if _, err := job.Output(dst); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	job.Progress(1, "Saved "+filepath.Base(dst))
	return job.SetResult(Result{Action: ActionRenderStill, Outputs: []string{dst}, Encoder: enc.Encoder})
}
