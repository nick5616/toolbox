package editstudio

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"toolbox/core"
	"toolbox/core/sidecar"
	"toolbox/core/viz"
)

// Exports for Color Grader (Phase 21 SPEC §E4): thin wrappers around the
// export and matte internals for edits that have no stored project. They
// register no outputs and keep no project files: the caller owns the paths.
// modules/grade's EditRenderer interface is satisfied by *Module.

// MatteModelsPresent says whether the people matte (videos) and the photo
// cut-out (pictures) models are installed.
func (m *Module) MatteModelsPresent() (people, image bool) {
	return m.ModelPresent(PresetPeople), m.imageModelPresent()
}

// PrepareStream makes (or reuses) the edit stream of a video at a short side
// and fps and returns its files and size. Color Grader's depth maps are made
// from it so they line up with the frames the editor plays.
func (m *Module) PrepareStream(ctx context.Context, job *core.JobContext, path string, short, fps int, onProgress func(float64)) (stream, index string, width, height, frames int, err error) {
	st, err := m.EnsureStream(ctx, job, path, short, fps, onProgress)
	if err != nil {
		return "", "", 0, 0, 0, err
	}
	return st.Stream, st.Index, st.Width, st.Height, st.Frames, nil
}

// WriteStreamIndex writes the .idx.json next to an Annex-B edit stream a
// handler produced (the matte handlers' streams get theirs the same way).
func (m *Module) WriteStreamIndex(stream string, width, height, fps int) error {
	_, err := writeIndexFn(stream, width, height, fps)
	return err
}

// RunImageMatte makes a picture's subject alpha with Background Remover's
// balanced model and writes it to dst (a .png whose base name is a valid
// matte ID). It holds the module's matte slot.
func (m *Module) RunImageMatte(ctx context.Context, job *core.JobContext, path, dst string) error {
	release, err := m.acquireMatte(ctx, job)
	if err != nil {
		return err
	}
	defer release()
	if m.cfg.Engine == nil {
		return core.Errorf(core.CodeInternal, "The AI engine isn't available")
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	if err := m.requireMatteModel(MatteImage); err != nil {
		return err
	}
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating the maps folder: %w", err)
	}
	id := filepath.Base(dst)
	id = id[:len(id)-len(filepath.Ext(id))]
	if !validMatteID(id) {
		return core.Errorf(core.CodeInternal, "Bad matte name")
	}
	return m.runImageMatte(ctx, job, dir, MatteRequest{MatteID: id, Mode: MatteImage, Path: path})
}

// RunMatte makes a video's people matte for source range fromMs..toMs (padded
// like a clip matte) as dir/<name>-export.h264 and dir/<name>-preview.h264 with
// their .idx.json files. exportShort caps the stream the matte is made from.
func (m *Module) RunMatte(ctx context.Context, job *core.JobContext, path, dir, name string, fromMs, toMs int64, fps, exportShort int) (export, preview viz.EditPlanStream, err error) {
	none := viz.EditPlanStream{}
	if !validMatteID(name) {
		return none, none, core.Errorf(core.CodeInternal, "Bad matte name")
	}
	release, err := m.acquireMatte(ctx, job)
	if err != nil {
		return none, none, err
	}
	defer release()
	if m.cfg.Engine == nil {
		return none, none, core.Errorf(core.CodeInternal, "The AI engine isn't available")
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return none, none, err
	}
	if err := m.requireMatteModel(MattePeople); err != nil {
		return none, none, err
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return none, none, err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return none, none, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return none, none, fmt.Errorf("creating the maps folder: %w", err)
	}
	if fps <= 0 {
		fps = 30
	}
	info, err := probeFn(ctx, ffprobe, path)
	if err != nil {
		return none, none, err
	}
	if info.Video == nil {
		return none, none, core.ValidationError("This clip has no video", map[string]string{"path": "This clip has no video"})
	}
	sw, sh := info.Video.Width, info.Video.Height
	job.Progress(0, "Preparing the clip")
	stream, err := ensureStream(m, ctx, job, path, min(min(sw, sh), orDefault(exportShort, defaultExportHeight)), fps, func(p float64) {
		job.Progress(0.05*p, "Preparing the clip")
	})
	if err != nil {
		return none, none, err
	}
	mw, mh := matteSize(stream.Width, stream.Height, matteMaxShort)
	if toMs <= fromMs {
		toMs = info.DurationMs
	}
	from, to := padRange(fromMs, toMs, info.DurationMs)
	fromFrame := min(frameOf(from, fps), max(stream.Frames-1, 0))
	toFrame := min(frameOf(to, fps)+1, stream.Frames)
	if toFrame <= fromFrame {
		return none, none, core.ValidationError("The range is outside the video", nil)
	}
	spec := matteModelPins[PresetPeople]
	exportPath := filepath.Join(dir, name+"-export.h264")
	sink := &matteSink{job: job, base: 0.05, span: 0.85}
	if _, err := m.cfg.Engine.Call(ctx, "matte.people", map[string]any{
		"ffmpeg": ffmpeg, "stream": stream.Stream, "index": stream.Index, "fromFrame": fromFrame, "toFrame": toFrame,
		"fps": fps, "width": mw, "height": mh, "workDir": job.TempDir, "modelDir": m.matteModelDir(),
		"model": map[string]any{"file": spec.File, "sha256": spec.SHA256}, "outPath": exportPath,
	}, sink.onEvent); err != nil {
		return none, none, err
	}
	if _, err := writeIndexFn(exportPath, mw, mh, fps); err != nil {
		return none, none, err
	}
	job.Progress(0.9, "Making the preview copy")
	previewPath := filepath.Join(dir, name+"-preview.h264")
	pw, ph := matteSize(mw, mh, previewMatteShort)
	if err := previewCopyFn(ctx, ffmpeg, exportPath, previewPath, mw, mh, pw, ph, fps); err != nil {
		return none, none, err
	}
	if _, err := writeIndexFn(previewPath, pw, ph, fps); err != nil {
		return none, none, err
	}
	exp, ok1 := streamOf(exportPath)
	prev, ok2 := streamOf(previewPath)
	if !ok1 || !ok2 {
		return none, none, core.Errorf(core.CodeInternal, "The people map wasn't written")
	}
	job.Progress(1, "People map ready")
	return viz.EditPlanStream{Stream: exp.Stream, Index: exp.Index}, viz.EditPlanStream{Stream: prev.Stream, Index: prev.Index}, nil
}

// RenderEdit exports an in-memory edit (a stored project isn't involved) as an
// .mp4 at outPath. grade, when set, is put in the render plan so the host
// compiles a Color Grader look into the first clip. extra adds the files the
// clips' Matte and Depth refer to: EditFiles keys "m:<id>" and "d:<id>" (the
// matting and depth files are not looked up in a project folder).
func (m *Module) RenderEdit(ctx context.Context, job *core.JobContext, name string, docJSON json.RawMessage, grade *viz.GradePlan, outPath string, extra *viz.EditPlan) error {
	start := exportNowFn()
	var doc EditProject
	if err := json.Unmarshal(docJSON, &doc); err != nil {
		return core.ValidationError("This edit is damaged", nil).WithCause(err)
	}
	job.SetTitle("Exporting — " + name)
	if err := validateShape(doc); err != nil {
		return err
	}
	if doc.Song != nil && !fileExists(doc.Song.Path) {
		return vErr("song.path", "The song "+baseName(doc.Song.Path)+" is missing")
	}
	for _, t := range doc.Tracks {
		for _, c := range t.Clips {
			if c.Path != "" && !fileExists(c.Path) {
				return core.Errorf(core.CodeNotFound, "%s is missing", baseName(c.Path))
			}
		}
	}
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := job.Tool("ffprobe")
	if err != nil {
		return err
	}
	var ref viz.AnalysisRef
	if doc.AnalysisKey != "" {
		if m.cfg.Analyzer == nil {
			return core.ValidationError("Beat sync isn't available", nil)
		}
		var ok bool
		if ref, ok = m.cfg.Analyzer.Lookup(doc.AnalysisKey); !ok {
			return core.ValidationError("The song's analysis isn't cached any more. Analyze it again", nil)
		}
	}
	cancelled := func(err error) error {
		if ctx.Err() != nil {
			return fmt.Errorf("export cancelled: %w", ctx.Err())
		}
		return err
	}
	outW, outH := exportSize(doc.Aspect, doc.ExportHeight)
	if doc.Size != nil {
		outW, outH = doc.Size.W, doc.Size.H
	}
	// The files the clips' own mattes would need are the caller's (extra); the
	// source preparation must not look in a project folder for them.
	bare := withoutMattes(doc)
	streams, images, err := m.ensureExportFiles(ctx, job.Scoped(0, exportSourcesTo), "", bare, ffprobe, outW, outH)
	if err != nil {
		return cancelled(err)
	}
	if extra != nil {
		for k, s := range extra.Streams {
			streams[k] = s
		}
		for k, p := range extra.Images {
			images[k] = p
		}
	}
	pj, err := json.Marshal(normalize(doc))
	if err != nil {
		return fmt.Errorf("encode project: %w", err)
	}
	if len(pj) > maxProjectJSON {
		return core.ValidationError("This edit is too large to export", nil)
	}
	plan := newRenderPlan(doc, ref, outW, outH, string(pj), streams, images)
	plan.Grade = grade
	enc, err := exportRenderFn(ctx, m.cfg.Broker, job.Scoped(exportSourcesTo, exportRenderTo), plan)
	if err != nil {
		return cancelled(err)
	}
	if enc.Path != "" {
		defer os.Remove(enc.Path)
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("export cancelled: %w", err)
	}
	job.Progress(exportRenderTo, "Mixing the audio…")
	mixPath := filepath.Join(job.TempDir, "mix.wav")
	if err := exportMixFn(m, ctx, job.Scoped(exportRenderTo, exportAudioTo), doc, ffmpeg, mixPath); err != nil {
		return cancelled(err)
	}
	job.Progress(exportAudioTo, "Finishing the video…")
	tmp := filepath.Join(job.TempDir, "edit.mp4")
	err = exportMuxFn(ctx, ffmpeg, enc, mixPath, 0, 0, doc.FPS, "", tmp, func(p float64) {
		job.Progress(exportAudioTo+p*(1-exportAudioTo), "Finishing the video…")
	})
	if err != nil {
		_ = os.Remove(tmp)
		return cancelled(err)
	}
	if err := exportMove(tmp, outPath); err != nil {
		return cancelled(core.Errorf(core.CodeToolFailed, "Couldn't save the video").WithCause(err))
	}
	if wall := exportNowFn().Sub(start).Seconds(); wall > 0 {
		job.Logf("Rendered %.1fs of video in %.1fs (%s)", float64(editLen(doc))/1000, wall, enc.Encoder)
	}
	return nil
}

// withoutMattes copies doc with every clip's Matte cleared.
func withoutMattes(doc EditProject) EditProject {
	out := doc
	out.Tracks = make([]Track, len(doc.Tracks))
	for i, t := range doc.Tracks {
		t.Clips = append([]Clip(nil), t.Clips...)
		for j := range t.Clips {
			t.Clips[j].Matte = nil
		}
		out.Tracks[i] = t
	}
	return out
}
