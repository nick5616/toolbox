package posts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"unicode"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	_ "image/gif" // decoders registered for image.Decode

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/media"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
	"toolbox/modules/videoeditor"
)

const jpegQuality = 92

// Run implements core.Module: the export job (SPEC.md §B7.3).
func (m *Module) Run(ctx context.Context, job *core.JobContext) (retErr error) {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	var stored core.StoredProject
	if o.Action == ActionMake {
		made, err := m.makePost(ctx, job, o)
		if err != nil {
			return err
		}
		stored = made
		// A post that couldn't be exported is not left behind: the step runs again.
		defer func() {
			if retErr != nil {
				if err := m.docs.Delete(context.Background(), made.ID); err != nil {
					slog.Warn("posts: removing an unfinished post", "err", err)
				}
			}
		}()
	} else {
		stored, err = m.docs.Load(ctx, o.ProjectID)
		if err != nil {
			return err
		}
	}
	var doc Post
	if err := json.Unmarshal([]byte(stored.Data), &doc); err != nil {
		return core.Errorf(core.CodeInternal, "This post couldn't be read").WithCause(err)
	}
	job.SetTitle(stored.Name)

	job.Progress(core.IndeterminateProgress, "Checking the post…")
	if bad, ok := firstError(m.Check(ctx, doc)); ok {
		return core.ValidationError(bad.Message, nil)
	}

	folder, err := m.makeFolder(job.OutputDir, stored.Name)
	if err != nil {
		return err
	}
	defer func() {
		if retErr != nil {
			os.RemoveAll(folder)
		}
	}()

	fw, fh := FrameSize(doc.Aspect)
	weights, total := m.weights(ctx, doc)
	const slideShare = 0.97
	done := 0.0
	var files []string
	for i, s := range doc.Slides {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("export cancelled: %w", err)
		}
		from := slideShare * done / total
		done += weights[i]
		scoped := job.Scoped(from, slideShare*done/total)
		scoped.Progress(0, fmt.Sprintf("Slide %d of %d…", i+1, len(doc.Slides)))
		base := filepath.Join(folder, fmt.Sprintf("%02d", i+1))
		var out string
		switch s.Kind {
		case "photo":
			out, err = m.exportPhoto(ctx, job, s, doc, base, fw, fh)
		case "clip":
			out, err = m.exportClip(ctx, job, scoped, s, doc, base+".mp4", fw, fh)
		case "composition":
			out, err = m.exportComposition(ctx, s, doc, base, fw, fh)
		case "video":
			out, err = m.exportVideo(ctx, job, scoped, s, doc, base+".mp4", fw, fh)
		default:
			err = core.ValidationError(fmt.Sprintf("Unknown slide type %q", s.Kind), nil)
		}
		if err != nil {
			return err
		}
		files = append(files, out)
	}

	job.Progress(slideShare, "Writing the caption…")
	extra, err := writeTexts(folder, doc, stored.Data)
	if err != nil {
		return err
	}
	files = append(files, extra.registered...)
	for _, f := range files { // post.json is not a Library output
		if _, err := job.Output(f); err != nil {
			return fmt.Errorf("register %s: %w", filepath.Base(f), err)
		}
	}
	job.Progress(1, "Done")
	return job.SetResult(ExportResult{Folder: folder, Files: append(files, extra.reference...), ProjectID: stored.ID})
}

// makePost creates the post of a make job from its input files.
func (m *Module) makePost(ctx context.Context, job *core.JobContext, o Options) (core.StoredProject, error) {
	job.Progress(core.IndeterminateProgress, "Making the post…")
	doc, err := m.newPost(ctx, o.Format, o.Aspect, job.Inputs)
	if err != nil {
		return core.StoredProject{}, err
	}
	if len(doc.Slides) == 0 {
		return core.StoredProject{}, core.ValidationError("None of these files can go in a post", nil).
			WithHint("Posts take photos and videos")
	}
	doc.Caption, doc.KeepLocation = o.Caption, o.KeepLocation
	if err := validateShape(doc); err != nil {
		return core.StoredProject{}, err
	}
	name := strings.TrimSpace(o.Name)
	if name == "" {
		name = core.StemName(job.Inputs[0])
	}
	info, err := m.docs.Create(ctx, name, doc)
	if err != nil {
		return core.StoredProject{}, err
	}
	return m.docs.Load(ctx, info.ID)
}

type textFiles struct {
	registered []string // caption.txt, alt-text.txt
	reference  []string // post.json: written but not registered
}

// writeTexts writes caption.txt, alt-text.txt (when any) and post.json.
func writeTexts(folder string, doc Post, raw string) (textFiles, error) {
	var t textFiles
	write := func(name string, data []byte, register bool) error {
		p := filepath.Join(folder, name)
		if err := os.WriteFile(p, data, 0o644); err != nil {
			return core.Errorf(core.CodeInternal, "Couldn't write %s", name).WithCause(err)
		}
		if register {
			t.registered = append(t.registered, p)
		} else {
			t.reference = append(t.reference, p)
		}
		return nil
	}
	if err := write("caption.txt", []byte(doc.Caption), true); err != nil {
		return t, err
	}
	var alt strings.Builder
	for i, s := range doc.Slides {
		if strings.TrimSpace(s.AltText) != "" {
			fmt.Fprintf(&alt, "%02d: %s\n", i+1, strings.TrimSpace(s.AltText))
		}
	}
	if alt.Len() > 0 {
		if err := write("alt-text.txt", []byte(alt.String()), true); err != nil {
			return t, err
		}
	}
	var pretty bytes.Buffer
	if json.Indent(&pretty, []byte(raw), "", "  ") != nil {
		pretty.Reset()
		pretty.WriteString(raw)
	}
	return t, write("post.json", pretty.Bytes(), false)
}

// weights returns each slide's progress weight (SPEC §B7.3) and their sum.
func (m *Module) weights(ctx context.Context, doc Post) ([]float64, float64) {
	w := make([]float64, len(doc.Slides))
	total := 0.0
	limit := maxClipMs(DefaultLimits(), doc.Format)
	for i, s := range doc.Slides {
		w[i] = 1
		switch s.Kind {
		case "clip":
			w[i] = max(float64(s.OutMs-s.InMs)/1000/4, 0.25)
		case "video":
			if m.videos != nil {
				if v, err := m.videos.Get(ctx, s.ProjectID); err == nil {
					w[i] = max(float64(min(videoeditor.DurationMs(v), limit))/1000/2, 0.25)
				}
			}
		}
		total += w[i]
	}
	if total <= 0 {
		total = 1
	}
	return w, total
}

var unsafeName = strings.NewReplacer("<", " ", ">", " ", ":", " ", "\"", " ", "/", " ", "\\", " ", "|", " ", "?", " ", "*", " ")

// cleanFolderName makes a post name safe as a folder name.
func cleanFolderName(name string) string {
	name = unsafeName.Replace(name)
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.Trim(strings.Join(strings.Fields(name), " "), ". ")
	if name == "" {
		name = "Post"
	}
	return name
}

// makeFolder creates <dir>/<name> <date> (or " (2)", " (3)" … if it exists).
func (m *Module) makeFolder(dir, name string) (string, error) {
	base := cleanFolderName(name) + " " + m.now().Format("2006-01-02")
	for n := 1; n < 1000; n++ {
		p := filepath.Join(dir, base)
		if n > 1 {
			p = fmt.Sprintf("%s (%d)", filepath.Join(dir, base), n)
		}
		err := os.Mkdir(p, 0o755)
		if err == nil {
			return p, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", core.Errorf(core.CodeInternal, "Couldn't create the export folder").WithCause(err)
		}
	}
	return "", core.Errorf(core.CodeInternal, "Couldn't find a free export folder name")
}

// decodeImage decodes a photo; HEIC goes through the engine into the TempDir.
func (m *Module) decodeImage(ctx context.Context, job *core.JobContext, path string) (image.Image, int, error) {
	src, orient := path, 1
	if imaging.IsHEIC(path) {
		conv, err := m.convertHEIC(ctx, job, path)
		if err != nil {
			return nil, 0, err
		}
		src = conv // the engine applies the orientation
	} else {
		orient = imaging.Orientation(path)
	}
	f, err := os.Open(src)
	if err != nil {
		return nil, 0, core.Errorf(core.CodeNotFound, "Couldn't open %s", filepath.Base(path)).WithCause(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return nil, 0, core.Errorf(core.CodeValidation, "Couldn't read %s as a picture", filepath.Base(path)).WithCause(err)
	}
	if cfg.Width*cfg.Height > imaging.MaxPixels {
		return nil, 0, core.ValidationError(filepath.Base(path)+" is too large", nil)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, 0, err
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, 0, core.Errorf(core.CodeValidation, "Couldn't read %s as a picture", filepath.Base(path)).WithCause(err)
	}
	return img, orient, nil
}

func (m *Module) convertHEIC(ctx context.Context, job *core.JobContext, input string) (string, error) {
	if imaging.HEICAvailable() { // FFmpeg first, the engine as its fallback (core/heic)
		return imaging.ToReadable(ctx, input)
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return "", err
	}
	if m.cfg.Engine == nil {
		return "", core.ErrDependencyMissing(sidecar.DepID, "")
	}
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}
	out := filepath.Join(job.TempDir, core.NewID()+".png")
	if _, err := m.cfg.Engine.Call(ctx, "image.convert", map[string]any{"input": input, "output": out}, nil); err != nil {
		return "", err
	}
	if fi, err := os.Stat(out); err != nil || fi.Size() == 0 {
		return "", core.Errorf(core.CodeToolFailed, "Couldn't read this HEIC photo")
	}
	return out, nil
}

// exportPhoto writes <base>.jpg.
func (m *Module) exportPhoto(ctx context.Context, job *core.JobContext, s Slide, doc Post, base string, fw, fh int) (string, error) {
	img, orient, err := m.decodeImage(ctx, job, s.Path)
	if err != nil {
		return "", err
	}
	img = imaging.Orient(img, orient)
	framed := frameStill(img, s.Rotation, s.PanX, s.PanY, s.Zoom, fw, fh, true)
	out := base + ".jpg"
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, framed, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return "", fmt.Errorf("encode jpeg: %w", err)
	}
	data := buf.Bytes()
	if doc.KeepLocation && isJPEG(s.Path) {
		if seg, ok := readExifSegment(s.Path); ok {
			data = spliceExif(data, resetOrientation(seg))
		}
	}
	return out, os.WriteFile(out, data, 0o644)
}

// exportComposition frames the composition's stored render like a photo.
func (m *Module) exportComposition(ctx context.Context, s Slide, doc Post, base string, fw, fh int) (string, error) {
	if m.comps == nil {
		return "", core.Errorf(core.CodeInternal, "The Photo Composer isn't available")
	}
	c, err := m.comps.Get(ctx, s.ProjectID)
	if err != nil {
		return "", err
	}
	p, err := m.comps.RenderPath(s.ProjectID)
	if err != nil {
		return "", err
	}
	f, err := os.Open(p)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "This composition has no saved picture yet").WithCause(err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return "", core.Errorf(core.CodeValidation, "Couldn't read the composition's picture").WithCause(err)
	}
	if strings.EqualFold(c.Format, "png") && doc.Format == "story" {
		framed := frameStill(img, s.Rotation, s.PanX, s.PanY, s.Zoom, fw, fh, false)
		out := base + ".png"
		var buf bytes.Buffer
		if err := png.Encode(&buf, framed); err != nil {
			return "", fmt.Errorf("encode png: %w", err)
		}
		return out, os.WriteFile(out, buf.Bytes(), 0o644)
	}
	framed := frameStill(img, s.Rotation, s.PanX, s.PanY, s.Zoom, fw, fh, true)
	out := base + ".jpg"
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, framed, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return "", fmt.Errorf("encode jpeg: %w", err)
	}
	return out, os.WriteFile(out, buf.Bytes(), 0o644)
}

// exportClip runs FFmpeg for one clip slide.
func (m *Module) exportClip(ctx context.Context, job, scoped *core.JobContext, s Slide, doc Post, out string, fw, fh int) (string, error) {
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return "", err
	}
	args := clipArgs(s.Path, out, s.InMs, s.OutMs, s.Rotation, s.PanX, s.PanY, s.Zoom, s.Mute, doc.KeepLocation, fw, fh)
	tracker := &media.ProgressTracker{Duration: float64(s.OutMs-s.InMs) / 1000, Label: "Encoding"}
	var (
		mu         sync.Mutex
		lastStderr string
	)
	_, runErr := proc.Run(ctx, proc.Spec{
		Path: ffmpeg, Args: args,
		OnStdout: func(l string) {
			mu.Lock()
			pct, msg, changed := tracker.Apply(l)
			mu.Unlock()
			if changed {
				scoped.Progress(pct, msg)
			}
		},
		OnStderr: func(l string) {
			job.Log(core.StreamStderr, l)
			mu.Lock()
			lastStderr = l
			mu.Unlock()
		},
	})
	if ctxErr := ctx.Err(); ctxErr != nil {
		return "", fmt.Errorf("export cancelled: %w", ctxErr)
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			return "", fmt.Errorf("run ffmpeg: %w", runErr)
		}
		mu.Lock()
		msg := lastStderr
		mu.Unlock()
		if msg == "" {
			msg = "FFmpeg failed"
		}
		return "", core.Errorf(core.CodeToolFailed, "%s", msg).WithCause(runErr)
	}
	return out, nil
}

// exportVideo renders a Video Editor project into the TempDir and moves it.
func (m *Module) exportVideo(ctx context.Context, job, scoped *core.JobContext, s Slide, doc Post, out string, fw, fh int) (string, error) {
	if m.videos == nil {
		return "", core.Errorf(core.CodeInternal, "The Video Editor isn't available")
	}
	v, err := m.videos.Get(ctx, s.ProjectID)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(job.TempDir, 0o755); err != nil {
		return "", core.Errorf(core.CodeInternal, "Couldn't create a temporary folder").WithCause(err)
	}
	tmp := filepath.Join(job.TempDir, core.NewID()+".mp4")
	maxSec := maxClipMs(DefaultLimits(), doc.Format) / 1000
	if err := m.videos.RenderProject(ctx, scoped, v, tmp, videoeditor.RenderOptions{Width: fw, Height: fh, MaxSeconds: maxSec}); err != nil {
		return "", err
	}
	return out, moveFile(tmp, out)
}

// moveFile renames, falling back to copy+remove across volumes.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't read the rendered video").WithCause(err)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return core.Errorf(core.CodeInternal, "Couldn't write %s", filepath.Base(dst)).WithCause(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return core.Errorf(core.CodeInternal, "Couldn't write %s", filepath.Base(dst)).WithCause(err)
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Remove(src)
}
