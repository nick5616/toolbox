package videoeditor

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"

	// Photo decoders (image.Decode).
	_ "image/jpeg"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

const (
	graphName = "graph.txt"
	assName   = "titles.ass"
)

// ffmpegReads are the photo types FFmpeg reads directly (when upright).
var ffmpegReads = []string{".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}

// RenderProject renders doc into outPath inside an existing job (the Video
// Editor's own render job, or Post Builder's export). Progress is reported
// to job over the whole call.
func (m *Module) RenderProject(ctx context.Context, job *core.JobContext, doc VideoProject, outPath string, o RenderOptions) error {
	doc = normalize(doc)
	if err := validateDoc(doc); err != nil {
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
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}

	job.Progress(core.IndeterminateProgress, "Reading the clips…")
	infos, err := probeAll(ctx, ffprobe, doc)
	if err != nil {
		return err
	}
	images, err := m.prepareImages(ctx, job, doc)
	if err != nil {
		return err
	}

	w, h := frameSize(doc.Aspect, false)
	if o.Width > 0 && o.Height > 0 {
		w, h = even(o.Width), even(o.Height)
	}
	if o.Preview {
		w, h = previewSize(w, h)
	}
	part := outPath + ".part"
	plan, err := buildPlan(graphIn{
		Doc: doc, Infos: infos, Images: images, W: w, H: h, Preview: o.Preview, MaxMs: o.MaxSeconds * 1000,
		GraphFile: graphName, ASSName: assName, OutputPath: part,
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(job.TempDir, graphName), []byte(plan.Graph), 0o644); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't write the render plan").WithCause(err)
	}
	if plan.ASS != "" {
		if err := os.WriteFile(filepath.Join(job.TempDir, assName), []byte(plan.ASS), 0o644); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't write the titles").WithCause(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't create the output folder").WithCause(err)
	}

	tracker := media.ProgressTracker{Duration: float64(plan.OutMs) / 1000, Label: "Rendering"}
	res, err := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: plan.Args, Dir: job.TempDir,
		OnStdout: func(line string) {
			if pct, msg, ok := tracker.Apply(line); ok {
				job.Progress(pct, msg)
			}
		},
		OnStderr: func(line string) { job.Log(core.StreamStderr, line) },
	})
	if err != nil {
		_ = os.Remove(part)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		hint := ""
		if n := len(res.StderrTail); n > 0 {
			hint = res.StderrTail[n-1]
		}
		return core.Errorf(core.CodeToolFailed, "FFmpeg couldn't render this video").WithHint(hint).WithCause(err)
	}
	if fi, err := os.Stat(part); err != nil || fi.Size() == 0 {
		return core.Errorf(core.CodeToolFailed, "FFmpeg didn't write a video")
	}
	if err := os.Rename(part, outPath); err != nil {
		_ = os.Remove(part)
		return core.Errorf(core.CodeInternal, "Couldn't save the video").WithCause(err)
	}
	job.Progress(1, "Done")
	return nil
}

// probeAll probes every video clip and the song.
func probeAll(ctx context.Context, ffprobe string, doc VideoProject) (map[string]ClipInfo, error) {
	infos := map[string]ClipInfo{}
	probe := func(path string) (ClipInfo, error) {
		if ci, ok := infos[path]; ok {
			return ci, nil
		}
		ci := probeFile(ctx, ffprobe, path)
		if ctx.Err() != nil {
			return ci, ctx.Err()
		}
		infos[path] = ci
		return ci, nil
	}
	for i, c := range doc.Clips {
		if c.Kind != "video" {
			continue
		}
		ci, err := probe(c.Path)
		if err != nil {
			return nil, err
		}
		if ci.Error != "" || ci.Kind != "video" {
			msg := ci.Error
			if msg == "" {
				msg = "This isn't a video"
			}
			e := core.Errorf(core.CodeValidation, "Clip %d: %s", i+1, msg).WithHint(c.Path)
			e.Fields = map[string]string{fmt.Sprintf("clips[%d].path", i): msg}
			return nil, e
		}
		if c.OutMs > ci.DurationMs+500 && ci.DurationMs > 0 {
			e := core.Errorf(core.CodeValidation, "Clip %d ends after the end of its file", i+1)
			e.Fields = map[string]string{fmt.Sprintf("clips[%d].outMs", i): "Past the end of the file"}
			return nil, e
		}
	}
	if mu := doc.Music; mu != nil {
		ci, err := probe(mu.Path)
		if err != nil {
			return nil, err
		}
		if ci.Error != "" || !ci.HasAudio {
			e := core.Errorf(core.CodeValidation, "The song can't be read").WithHint(mu.Path)
			e.Fields = map[string]string{"music.path": "Pick an audio file"}
			return nil, e
		}
		if mu.OffsetMs >= ci.DurationMs {
			e := core.Errorf(core.CodeValidation, "The song starts after its end")
			e.Fields = map[string]string{"music.offsetMs": "Start earlier in the song"}
			return nil, e
		}
	}
	return infos, nil
}

// prepareImages returns the file FFmpeg reads for each photo clip (by clip
// index): the original when it is upright and FFmpeg-readable, else an
// oriented PNG in the TempDir (HEIC via the AI engine).
func (m *Module) prepareImages(ctx context.Context, job *core.JobContext, doc VideoProject) (map[int]string, error) {
	out := map[int]string{}
	done := map[string]string{}
	n := 0
	for i, c := range doc.Clips {
		if c.Kind != "image" {
			continue
		}
		if f, ok := done[c.Path]; ok {
			out[i] = f
			continue
		}
		n++
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		f, err := m.preparePhoto(ctx, job, c.Path, n)
		if err != nil {
			return nil, err
		}
		done[c.Path], out[i] = f, f
	}
	return out, nil
}

func (m *Module) preparePhoto(ctx context.Context, job *core.JobContext, path string, n int) (string, error) {
	dst := filepath.Join(job.TempDir, fmt.Sprintf("photo-%d.png", n))
	if imaging.IsHEIC(path) && imaging.HEICAvailable() { // FFmpeg first, the engine as its fallback (core/heic)
		job.Progress(core.IndeterminateProgress, "Reading a HEIC photo…")
		return imaging.ToReadable(ctx, path)
	}
	if imaging.IsHEIC(path) {
		if _, err := job.Tool(sidecar.DepID); err != nil {
			var ae *core.AppError
			if errors.As(err, &ae) && ae.Code == core.CodeDependencyMissing {
				return "", (&core.AppError{Code: core.CodeDependencyMissing, Message: "HEIC photos need the AI engine", Hint: ae.Hint}).WithCause(err)
			}
			return "", err
		}
		if m.cfg.Engine == nil {
			return "", core.Errorf(core.CodeInternal, "HEIC photos aren't available")
		}
		job.Progress(core.IndeterminateProgress, "Reading a HEIC photo…")
		if _, err := m.cfg.Engine.Call(ctx, "image.convert", map[string]any{"input": path, "output": dst}, nil); err != nil {
			return "", err
		}
		if fi, err := os.Stat(dst); err != nil || fi.Size() == 0 {
			return "", core.Errorf(core.CodeToolFailed, "Couldn't read this HEIC photo").WithHint(path)
		}
		return dst, nil
	}
	o := imaging.Orientation(path)
	if o <= 1 && slices.Contains(ffmpegReads, strings.ToLower(filepath.Ext(path))) {
		return path, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "A photo is missing").WithHint(path)
	}
	img, _, err := image.Decode(f)
	f.Close()
	if err != nil {
		return "", core.Errorf(core.CodeValidation, "Couldn't read this photo").WithHint(path)
	}
	img = imaging.Orient(img, o)
	w, err := os.Create(dst)
	if err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create a temporary file").WithCause(err)
	}
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(w, img); err != nil {
		w.Close()
		return "", fmt.Errorf("write oriented photo: %w", err)
	}
	if err := w.Close(); err != nil {
		return "", fmt.Errorf("write oriented photo: %w", err)
	}
	return dst, nil
}
