package mediaindex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // decoders for the frames and pictures read here
	_ "image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/doctext"
	"toolbox/core/imaging"
	"toolbox/core/media"
	ix "toolbox/core/mediaindex"
	"toolbox/core/par"
	"toolbox/core/sidecar"
)

// The media-index job (SPEC.md §3.3): prepare → embed → text gate → OCR →
// one StoreBatch.

const (
	prepareBound  = 6
	maxPDFBytes   = 200 << 20
	maxPDFTextPgs = 500
	maxPDFOCRPgs  = 50
	maxPDFPicPgs  = 4
	minPageChars  = 20
)

// Seams for tests (the real ones probe with ffprobe and run FFmpeg).
var (
	probeMedia = func(ctx context.Context, ffprobe, path string) (media.Info, error) {
		return media.Probe(ctx, ffprobe, path)
	}
	extractVideoFrames = extractFrames
)

var (
	imageExts = extSet(append(append([]string{}, core.ImageExtensions...), ".heif"))
	videoExts = extSet(core.VideoExtensions)
	audioExts = extSet(core.AudioExtensions)
)

func extSet(list []string) map[string]bool {
	m := make(map[string]bool, len(list))
	for _, e := range list {
		m[e] = true
	}
	return m
}

// skipError marks a file that is left out with a reason, not failed.
type skipError string

func (s skipError) Error() string { return string(s) }

// pic is one prepared picture of a file.
type pic struct {
	pos   int64     // -1 whole image, a video frame's ms, a PDF page index
	small string    // the 224 px JPEG to embed ("" = not embedded)
	ocr   string    // the ≤ 1600 px JPEG for text reading ("" = none)
	force bool      // read its text whatever the gate says (a PDF page with no text layer)
	vec   []float32 // set after embedding
}

// prepared is one file after the prepare step.
type prepared struct {
	res  ix.ItemResult
	pics []*pic
}

// env is what preparing a batch needs.
type env struct {
	job      *core.JobContext
	d        Deps
	readText bool
	dir      string

	ffOnce          sync.Once
	ffmpeg, ffprobe string
	ffErr           error
}

func (e *env) tools() (ffmpeg, ffprobe string, err error) {
	e.ffOnce.Do(func() {
		e.ffmpeg, e.ffErr = e.job.Tool(deps.FFmpeg)
		if e.ffErr == nil {
			e.ffprobe, e.ffErr = e.job.Tool(deps.FFprobe)
		}
	})
	return e.ffmpeg, e.ffprobe, e.ffErr
}

// reason turns an error into the one line shown to the user.
func reason(err error) string {
	var ae *core.AppError
	msg := err.Error()
	if errors.As(err, &ae) && ae.Message != "" {
		msg = ae.Message
	}
	msg = strings.Join(strings.Fields(msg), " ")
	if r := []rune(msg); len(r) > 160 {
		msg = string(r[:160]) + "…"
	}
	return msg
}

func (m *IndexModule) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[ix.BatchOptions](job)
	if err != nil {
		return err
	}
	if len(job.Inputs) == 0 || len(job.Inputs) > ix.BatchMaxFiles {
		return core.ValidationError(fmt.Sprintf("A batch is 1 to %d files", ix.BatchMaxFiles), nil)
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	w := m.d.Writer
	if w == nil {
		return core.Errorf(core.CodeInternal, "Smart search isn't set up")
	}
	job.SetTitle(fmt.Sprintf("Indexing %d files", len(job.Inputs)))
	e := &env{job: job, d: m.d, readText: o.ReadText, dir: job.TempDir}

	// 1. Prepare (0 – 30 %).
	items := make([]*prepared, len(job.Inputs))
	var mu sync.Mutex
	done := 0
	job.Progress(0, "Reading files")
	if err := par.ForEach(ctx, len(items), prepareBound, func(ctx context.Context, i int) error {
		items[i] = e.prepare(ctx, i, job.Inputs[i])
		mu.Lock()
		done++
		n := done
		mu.Unlock()
		job.Progress(0.3*float64(n)/float64(len(items)), fmt.Sprintf("Reading files · %d/%d", n, len(items)))
		return nil
	}); err != nil {
		return err
	}

	// 2. Embed (30 – 70 %).
	var embed []*pic
	for _, it := range items {
		for _, p := range it.pics {
			if p.small != "" {
				embed = append(embed, p)
			}
		}
	}
	if len(embed) > 0 {
		if err := m.embed(ctx, job.Scoped(0.3, 0.7), w.Model(), embed); err != nil {
			return err
		}
	}
	for _, it := range items {
		it.finish()
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	// 3. Text gate + OCR (70 – 95 %).
	if o.ReadText {
		if err := m.readText(ctx, job.Scoped(0.7, 0.95), w, items); err != nil {
			return err
		}
	}

	// 4. Store.
	job.Progress(0.95, "Saving")
	results := make([]ix.ItemResult, len(items))
	for i, it := range items {
		results[i] = it.res
	}
	if err := w.StoreBatch(ctx, results); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("Indexed %d files", len(items)))
	return nil
}

// finish turns embedded pictures into the item's vectors and decides whether
// a picture-only file failed.
func (it *prepared) finish() {
	embedded := 0
	for _, p := range it.pics {
		if p.small == "" {
			continue
		}
		embedded++
		if len(p.vec) > 0 {
			it.res.Vectors = append(it.res.Vectors, ix.VectorAt{Pos: p.pos, Vec: p.vec})
		}
	}
	if embedded > 0 && len(it.res.Vectors) == 0 && it.res.Failed == "" &&
		(it.res.Kind == core.MediaKindImage || it.res.Kind == core.MediaKindVideo) {
		it.res.Failed = "Couldn't read this picture"
	}
}

// prepare reads one file into pictures and text. It never returns an error:
// a problem becomes the item's Failed or Skipped line.
func (e *env) prepare(ctx context.Context, n int, path string) *prepared {
	p := &prepared{res: ix.ItemResult{Path: path, Vectors: []ix.VectorAt{}, Texts: []core.MediaText{}}}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		p.res.Failed = "The file isn't there any more"
		return p
	}
	p.res.Size, p.res.ModMs = fi.Size(), fi.ModTime().UnixMilli()
	ext := strings.ToLower(filepath.Ext(path))
	switch {
	case videoExts[ext]:
		p.res.Kind = core.MediaKindVideo
		err = e.prepVideo(ctx, p, n, path)
	case imageExts[ext]:
		p.res.Kind = core.MediaKindImage
		err = e.prepImage(ctx, p, n, path, ext)
	case ext == ".pdf":
		p.res.Kind = core.MediaKindPDF
		err = e.prepPDF(ctx, p, n, path)
	case audioExts[ext]:
		p.res.Kind = core.MediaKindAudio
	case doctext.Supported(path):
		p.res.Kind = core.MediaKindDoc
		err = prepDoc(p, path)
	default:
		p.res.Failed = "This kind of file isn't indexed"
		return p
	}
	if err != nil {
		if ctx.Err() != nil {
			return p
		}
		p.pics = nil
		p.res.Texts = []core.MediaText{}
		var sk skipError
		if errors.As(err, &sk) {
			p.res.Skipped = string(sk)
		} else {
			p.res.Failed = reason(err)
		}
	}
	return p
}

// addStill saves img's embedded (224 px short side) and, when reading text,
// OCR (≤ 1600 px) JPEGs and records the picture.
func (e *env) addStill(p *prepared, n int, tag string, img image.Image, pos int64) error {
	big := fitLong(img, ocrLong)
	pc := &pic{pos: pos, small: filepath.Join(e.dir, fmt.Sprintf("%d-%s-224.jpg", n, tag))}
	if err := writeJPEG(pc.small, fitShort(big, embedShort)); err != nil {
		return err
	}
	if e.readText {
		pc.ocr = filepath.Join(e.dir, fmt.Sprintf("%d-%s-ocr.jpg", n, tag))
		if err := writeJPEG(pc.ocr, big); err != nil {
			return err
		}
	}
	p.pics = append(p.pics, pc)
	return nil
}

func (e *env) prepImage(ctx context.Context, p *prepared, n int, path, ext string) error {
	switch {
	case ext == ".gif":
		first, mid, midMs, err := gifFrames(path)
		if err != nil {
			return err
		}
		if err := e.addStill(p, n, "a", first, -1); err != nil {
			return err
		}
		if mid != nil {
			return e.addStill(p, n, "b", mid, midMs)
		}
		return nil
	case ext == ".webp" && isAnimatedWebP(path):
		if ok := e.animatedWebP(ctx, p, n, path); ok {
			return nil
		}
	}
	img, err := loadOriented(ctx, path)
	if err != nil {
		return err
	}
	return e.addStill(p, n, "a", img, -1)
}

// animatedWebP takes the first and middle frames with FFmpeg; false means it
// couldn't (the caller falls back to the still first frame).
func (e *env) animatedWebP(ctx context.Context, p *prepared, n int, path string) bool {
	ffmpeg, ffprobe, err := e.tools()
	if err != nil {
		return false
	}
	info, err := probeMedia(ctx, ffprobe, path)
	if err != nil {
		return false
	}
	s := middleSchedule(info.DurationMs)
	files, err := extractVideoFrames(ctx, ffmpeg, path, filepath.Join(e.dir, fmt.Sprintf("w%d", n)), s)
	if err != nil || len(files) == 0 {
		return false
	}
	times := s.Times()
	before := len(p.pics)
	for i, f := range files {
		img, err := readImage(f)
		if err != nil {
			p.pics = p.pics[:before]
			return false
		}
		pos := int64(-1)
		if i > 0 && i < len(times) {
			pos = times[i]
		}
		if err := e.addStill(p, n, fmt.Sprintf("w%d", i), img, pos); err != nil {
			p.pics = p.pics[:before]
			return false
		}
	}
	return true
}

func readImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

func (e *env) prepVideo(ctx context.Context, p *prepared, n int, path string) error {
	ffmpeg, ffprobe, err := e.tools()
	if err != nil {
		return skipError("needs FFmpeg")
	}
	info, err := probeMedia(ctx, ffprobe, path)
	if err != nil {
		return fmt.Errorf("couldn't read this video: %w", err)
	}
	if info.Video == nil {
		return nil // nothing to see; speech and text are separate
	}
	s := videoSchedule(info.DurationMs)
	files, err := extractVideoFrames(ctx, ffmpeg, path, filepath.Join(e.dir, fmt.Sprintf("v%d", n)), s)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return core.Errorf(core.CodeToolFailed, "Couldn't read any frames of this video")
	}
	imgs := make([]image.Image, len(files))
	hashes := make([]imaging.DHash, len(files))
	for i, f := range files {
		img, err := readImage(f)
		if err != nil {
			return fmt.Errorf("couldn't read a frame: %w", err)
		}
		imgs[i], hashes[i] = img, imaging.DHashImage(img)
	}
	times := s.Times()
	for _, i := range dedupeHashes(hashes, dedupeBits) {
		pos := times[len(times)-1]
		if i < len(times) {
			pos = times[i]
		}
		if err := e.addStill(p, n, fmt.Sprintf("v%d", i), imgs[i], pos); err != nil {
			return err
		}
	}
	return nil
}

// embed makes one search.embed_images call for every 224 px picture and
// stores the vectors on the pics (a picture the engine couldn't read keeps
// none).
func (m *IndexModule) embed(ctx context.Context, job *core.JobContext, model ix.Model, pics []*pic) error {
	paths := make([]string, len(pics))
	for i, p := range pics {
		paths[i] = p.small
	}
	job.Progress(0, "Looking at pictures")
	raw, err := m.d.Caller.Call(ctx, "search.embed_images", map[string]any{
		"modelDir": model.Dir,
		"paths":    paths,
		"threads":  max(1, runtime.NumCPU()/2),
	}, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			job.Progress(ev.Pct, "Looking at pictures")
		case "log":
			job.Log(core.StreamStdout, ev.Line)
		}
	})
	if err != nil {
		return err
	}
	var res struct {
		Dim     int      `json:"dim"`
		Vectors []string `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	if len(res.Vectors) != len(pics) || (model.Dim > 0 && res.Dim != model.Dim) {
		return core.Errorf(core.CodeInternal, "The AI engine returned vectors that don't fit the model")
	}
	for i, p := range pics {
		v, err := decodeVector(res.Vectors[i], res.Dim)
		if err != nil {
			job.Logf("picture %d: %v", i, err)
			continue
		}
		p.vec = v
	}
	return nil
}
