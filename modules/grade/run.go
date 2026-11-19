package grade

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	xdraw "golang.org/x/image/draw"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/imaging"
	"toolbox/core/proc"
	"toolbox/core/viz"
	"toolbox/modules/editstudio"
)

// The grade job (SPEC §E4). A picture becomes a one-clip edit whose size is
// the picture's own (≤ 8192 px) rendered as a Still by the main window's
// RenderHost; a video becomes a one-clip edit exported by Edit Studio's
// exporter at the source size (≤ 3840 px). Either way the plan carries the
// recipe (plan.Grade) and the host compiles it with the one compiler,
// frontend/src/grade compileRecipe.
//
// How the host finds the region maps (the clip refers to them, the plan holds
// the files; the one convention of frontend/src/viz/edit/clipAux.ts, which the
// Color Grader's preview uses too): clip.Matte{ID "subject"} ↔ "m:subject" and
// clip.Depth{ID "depth"} ↔ "d:depth", in Images (the PNGs) for a picture and in
// Streams (export-tier edit streams) for a video.

// Seams for tests.
var (
	renderStillFn = func(ctx context.Context, br *viz.RenderBroker, job *core.JobContext, plan viz.RenderPlan) (viz.RenderOutput, error) {
		if br == nil {
			return viz.RenderOutput{}, core.Errorf(core.CodeInternal, "The picture renderer isn't available")
		}
		return br.Render(ctx, job, plan)
	}
	hostWaitFn = func(br *viz.RenderBroker) error { return br.WaitForHost() }
	copyMetaFn = copyMetadata
)

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error {
	o, err := decodeOptions(job.Options)
	if err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return core.ValidationError("Color Grader works on one file per job", nil)
	}
	if o.Action == ActionMaps {
		return m.runMaps(ctx, job, o)
	}
	if err := checkOptions(o); err != nil {
		return err
	}
	if strings.TrimSpace(o.Vibe) != "" {
		job.Progress(core.IndeterminateProgress, "Writing a look")
		looks, err := m.vibe(ctx, VibeRequest{Text: o.Vibe, Seed: o.VibeSeed, N: 1})
		if err != nil {
			return err
		}
		o.Recipe = looks[0]
	}
	recipe, err := Normalize(o.Recipe)
	if err != nil {
		return core.ValidationError("This look isn't valid", map[string]string{"recipe": err.Error()})
	}
	if _, err := os.Stat(job.Inputs[0]); err != nil {
		return core.Errorf(core.CodeNotFound, "This file doesn't exist any more").WithHint(filepath.Base(job.Inputs[0])).WithCause(err)
	}
	if err := hostWaitFn(m.cfg.Broker); err != nil {
		return core.Errorf(core.CodeToolFailed, "Open Toolbox's window to render").WithHint("Color Grader draws in the app's window")
	}
	job.SetTitle("Grading — " + filepath.Base(job.Inputs[0]))
	if isVideo(job.Inputs[0]) {
		return m.runVideo(ctx, job, o, recipe)
	}
	return m.runPicture(ctx, job, o, recipe)
}

// activeRecipe drops the ops that don't apply at this Wildness, so no map is
// made for them.
func activeRecipe(r Recipe, wild float64) Recipe {
	out := r
	out.Ops = nil
	for _, op := range r.Ops {
		if !op.On || (op.Chaos && wild <= ChaosAbove) {
			continue
		}
		out.Ops = append(out.Ops, op)
	}
	return out
}

// gradePlan is the plan's Grade.
func gradePlan(r Recipe, wild float64) (*viz.GradePlan, error) {
	b, err := json.Marshal(r)
	if err != nil {
		return nil, fmt.Errorf("encode look: %w", err)
	}
	return &viz.GradePlan{RecipeJSON: string(b), Wild: wild}, nil
}

// baseDoc is a one-track, one-clip edit; the caller fills the clip.
func baseDoc(w, h, fps int, clip editstudio.Clip) editstudio.EditProject {
	clip.ID, clip.FxTarget, clip.Fit, clip.Blend, clip.Slow = "c1", "clip", "fill", "normal", "blend"
	clip.Volume = 1
	return editstudio.EditProject{
		Version: 2, Aspect: "16:9", FPS: fps, Background: "#000000", ExportHeight: 1080,
		Markers: editstudio.MarkerState{Lanes: map[string]editstudio.LaneSettings{}, Hidden: []string{}, Moved: map[string]int64{}, Labels: map[string]string{}, Custom: []editstudio.CustomMarker{}},
		Sources: []editstudio.Source{},
		Tracks:  []editstudio.Track{{ID: "t1", Kind: "video", Name: "Video", Clips: []editstudio.Clip{clip}}},
		Size:    &editstudio.Size{W: w, H: h},
	}
}

func outName(input string, r Recipe) string {
	return core.StemName(input) + " (" + fileStem(r.Name, "look") + ")"
}

// -- pictures -------------------------------------------------------------------------------

// pictureExt is the output extension for the format option.
func pictureExt(input, format string) string {
	switch format {
	case "jpg":
		return ".jpg"
	case "png":
		return ".png"
	case "webp":
		return ".webp"
	}
	switch strings.ToLower(filepath.Ext(input)) {
	case ".jpg", ".jpeg":
		return ".jpg"
	case ".png", ".gif":
		return ".png"
	case ".webp":
		return ".webp"
	}
	return ".jpg" // HEIC, TIFF, BMP and the rest
}

// stagePicture writes an upright copy of the picture (long side ≤ 8192) into
// dir for the renderer and returns its path and size.
func stagePicture(ctx context.Context, input, dir string) (path string, w, h int, scaled bool, err error) {
	readable, err := imaging.ToReadable(ctx, input)
	if err != nil {
		return "", 0, 0, false, err
	}
	f, err := os.Open(readable)
	if err != nil {
		return "", 0, 0, false, core.Errorf(core.CodeNotFound, "This picture doesn't exist any more").WithCause(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return "", 0, 0, false, core.Errorf(core.CodeValidation, "Couldn't read this picture").WithHint(filepath.Base(input)).WithCause(err)
	}
	if int64(cfg.Width)*int64(cfg.Height) > imaging.MaxPixels {
		return "", 0, 0, false, core.Errorf(core.CodeValidation, "This picture is too large").WithHint(filepath.Base(input))
	}
	if _, err := f.Seek(0, 0); err != nil {
		return "", 0, 0, false, fmt.Errorf("rewinding %s: %w", filepath.Base(input), err)
	}
	src, _, err := image.Decode(f)
	if err != nil {
		return "", 0, 0, false, core.Errorf(core.CodeValidation, "Couldn't read this picture").WithHint(filepath.Base(input)).WithCause(err)
	}
	if err := ctx.Err(); err != nil {
		return "", 0, 0, false, err
	}
	img := imaging.Orient(src, imaging.Orientation(readable))
	b := img.Bounds()
	w, h = b.Dx(), b.Dy()
	if long := max(w, h); long > MaxStillLong {
		nw, nh := fitSize(w, h, MaxStillLong)
		dst := image.NewNRGBA(image.Rect(0, 0, nw, nh))
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, xdraw.Src, nil)
		img, w, h, scaled = dst, nw, nh, true
	}
	if w%2 != 0 || h%2 != 0 { // sizes are even; a 1 px loss is invisible
		w, h = w/2*2, h/2*2
	}
	if w < 64 || h < 64 {
		return "", 0, 0, false, core.ValidationError("This picture is too small to grade (under 64 px)", nil)
	}
	opaque := true
	if o, ok := img.(interface{ Opaque() bool }); ok {
		opaque = o.Opaque()
	}
	ext := ".jpg"
	if !opaque {
		ext = ".png"
	}
	path = filepath.Join(dir, "source"+ext)
	out, err := os.Create(path)
	if err != nil {
		return "", 0, 0, false, core.Errorf(core.CodeInternal, "Couldn't stage the picture").WithCause(err)
	}
	if ext == ".png" {
		err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(out, img)
	} else {
		err = jpeg.Encode(out, img, &jpeg.Options{Quality: 98})
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", 0, 0, false, core.Errorf(core.CodeInternal, "Couldn't stage the picture").WithCause(err)
	}
	return path, w, h, scaled, nil
}

func (m *Module) runPicture(ctx context.Context, job *core.JobContext, o Options, recipe Recipe) error {
	input := job.Inputs[0]
	need := MapsNeeded(activeRecipe(recipe, o.Wild))
	job.Progress(0, "Preparing the picture")
	if err := m.ensureMaps(ctx, job.Scoped(0, 0.3), input, need); err != nil {
		return err
	}
	staged, w, h, scaled, err := stagePicture(ctx, input, job.TempDir)
	if err != nil {
		return err
	}
	if scaled {
		job.Logf("The picture is over %d px on its long side, so it is graded at %d x %d", MaxStillLong, w, h)
	}

	doc := baseDoc(w, h, 30, editstudio.Clip{Kind: "image", Path: staged, EndMs: 1000})
	images := map[string]string{"p:" + staged: staged}
	dir, err := m.cacheDirFor(input)
	if err != nil {
		return err
	}
	clip := &doc.Tracks[0].Clips[0]
	for _, k := range need {
		switch k {
		case "subject":
			p := filepath.Join(dir, "subject.png")
			clip.Matte = &editstudio.Matte{Mode: editstudio.MatteImage, ID: "subject", Clicks: []editstudio.MatteClick{}, Stroke: editstudio.MatteStroke{Color: "#ffffff"}, Glow: editstudio.MatteGlow{Color: "#ffffff"}}
			images["m:subject"] = p
		case "depth":
			p := filepath.Join(dir, "depth.png")
			clip.Depth = &editstudio.DepthRef{ID: "depth"}
			images["d:depth"] = p
		}
	}
	touchDir(dir)
	pj, err := json.Marshal(doc)
	if err != nil {
		return fmt.Errorf("encode the edit: %w", err)
	}
	grade, err := gradePlan(recipe, o.Wild)
	if err != nil {
		return err
	}
	ext := pictureExt(input, o.Format)
	format, quality := strings.TrimPrefix(ext, "."), 92
	if ext == ".webp" {
		quality = 90
	}
	plan := viz.RenderPlan{
		Width: w, Height: h, FPS: 30, Mode: viz.ModeOpaque, StartMs: 0, EndMs: 1000,
		Edit:  &viz.EditPlan{ProjectJSON: string(pj), Streams: map[string]viz.EditPlanStream{}, Images: images},
		Still: &viz.StillPlan{AtMs: 0, Format: format, Quality: quality}, Grade: grade,
	}
	job.Progress(0.3, "Grading")
	res, err := renderStillFn(ctx, m.cfg.Broker, job.Scoped(0.3, 0.9), plan)
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("grading cancelled: %w", ctx.Err())
		}
		return err
	}
	if res.Path != "" {
		defer os.Remove(res.Path)
	}
	switch res.Codec {
	case "png":
		ext = ".png"
	case "jpeg", "jpg":
		ext = ".jpg"
	case "webp":
		ext = ".webp"
	}
	dst := core.UniquePath(job.OutputDir, outName(input, recipe), ext)
	if err := moveFile(res.Path, dst); err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't save the graded picture").WithCause(err)
	}
	job.Progress(0.93, "Copying the picture's details")
	if err := copyMetaFn(ctx, job, input, dst); err != nil {
		if ctx.Err() != nil {
			_ = os.Remove(dst)
			return ctx.Err()
		}
		job.Logf("Couldn't copy the picture's details (EXIF) to the graded file: %v", err)
	}
	if _, err := job.Output(dst); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	job.Progress(1, "Saved "+filepath.Base(dst))
	return nil
}

// copyMetadata copies the input's metadata to the graded file with ExifTool,
// except orientation (the pixels are upright already). GPS is copied only when
// the input has it, because only what is there can be copied. Without ExifTool
// it does nothing.
func copyMetadata(ctx context.Context, job *core.JobContext, src, dst string) error {
	exiftool, err := job.Tool(deps.ExifTool)
	if err != nil {
		job.Logf("ExifTool isn't installed, so the graded picture has no copy of the original's details")
		return nil
	}
	if _, err := imaging.ToReadable(ctx, src); err != nil {
		return err
	}
	args := []string{"-m", "-overwrite_original", "-P", "-tagsFromFile", src, "-all:all", "-Orientation#=1", "-ThumbnailImage=", "-PreviewImage="}
	argFile := filepath.Join(job.TempDir, "exif-args.txt")
	if err := os.WriteFile(argFile, []byte(strings.Join(args, "\n")+"\n"), 0o600); err != nil {
		return fmt.Errorf("write exiftool arguments: %w", err)
	}
	res, err := proc.Run(ctx, proc.Spec{
		Path: exiftool, Args: []string{"-charset", "filename=utf8", "-@", argFile, dst}, Dir: job.TempDir,
	})
	if err != nil {
		return fmt.Errorf("exiftool: %w (%s)", err, strings.Join(res.StderrTail, " "))
	}
	return nil
}

// -- videos ---------------------------------------------------------------------------------

func (m *Module) runVideo(ctx context.Context, job *core.JobContext, o Options, recipe Recipe) error {
	if m.cfg.Edit == nil {
		return core.Errorf(core.CodeInternal, "The video exporter isn't available")
	}
	input := job.Inputs[0]
	w, h, fps, dur, _, err := m.probeVideo(ctx, job, input)
	if err != nil {
		return err
	}
	if dur <= 0 {
		return core.ValidationError("This video has no length", nil)
	}
	outW, outH := fitSize(w, h, MaxVideoLong)
	need := MapsNeeded(activeRecipe(recipe, o.Wild))
	job.Progress(0, "Preparing the video")
	if err := m.ensureMaps(ctx, job.Scoped(0, 0.3), input, need); err != nil {
		return err
	}
	dir, err := m.cacheDirFor(input)
	if err != nil {
		return err
	}

	doc := baseDoc(outW, outH, pickFPS(float64(fps)), editstudio.Clip{Kind: "video", Path: input, EndMs: dur})
	clip := &doc.Tracks[0].Clips[0]
	extra := &viz.EditPlan{Streams: map[string]viz.EditPlanStream{}, Images: map[string]string{}}
	for _, k := range need {
		switch k {
		case "subject":
			exp := filepath.Join(dir, "subject-export.h264")
			clip.Matte = &editstudio.Matte{Mode: editstudio.MattePeople, ID: "subject", FromMs: 0, ToMs: dur, Clicks: []editstudio.MatteClick{}, Stroke: editstudio.MatteStroke{Color: "#ffffff"}, Glow: editstudio.MatteGlow{Color: "#ffffff"}}
			extra.Streams["m:subject"] = viz.EditPlanStream{Stream: exp, Index: editstudioIndex(exp)}
		case "depth":
			exp := filepath.Join(dir, "depth-export.h264")
			clip.Depth = &editstudio.DepthRef{ID: "depth", FromMs: 0, ToMs: dur}
			extra.Streams["d:depth"] = viz.EditPlanStream{Stream: exp, Index: editstudioIndex(exp)}
		}
	}
	touchDir(dir)

	if o.Beat.On {
		if m.cfg.Analyzer == nil {
			return core.Errorf(core.CodeInternal, "Beat sync isn't available")
		}
		song := o.Beat.Song
		if song == "" {
			song = input
		}
		job.Progress(0.3, "Listening for the beat")
		ref, err := m.cfg.Analyzer.Analyze(ctx, job.Scoped(0.3, 0.45), song, viz.AnalyzeOptions{})
		if err != nil {
			return err
		}
		doc.AnalysisKey = ref.Key
	}
	pj, err := json.Marshal(doc)
	if err != nil {
		return fmt.Errorf("encode the edit: %w", err)
	}
	grade, err := gradePlan(recipe, o.Wild)
	if err != nil {
		return err
	}
	dst := core.UniquePath(job.OutputDir, outName(input, recipe), ".mp4")
	if err := m.cfg.Edit.RenderEdit(ctx, job.Scoped(0.45, 1), filepath.Base(input), pj, grade, dst, extra); err != nil {
		_ = os.Remove(dst)
		return err
	}
	if _, err := job.Output(dst); err != nil {
		return fmt.Errorf("register output: %w", err)
	}
	job.Progress(1, "Saved "+filepath.Base(dst))
	return nil
}

// editstudioIndex is the index file next to an edit stream.
func editstudioIndex(stream string) string { return editstudio.IndexPath(stream) }

// moveFile renames, falling back to a copy across volumes.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, in, 0o644); err != nil {
		_ = os.Remove(dst)
		return err
	}
	return os.Remove(src)
}
