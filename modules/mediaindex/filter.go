package mediaindex

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf8"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/doctext"
	"toolbox/core/imaging"
	"toolbox/core/media"
	ix "toolbox/core/mediaindex"
	"toolbox/core/proc"
	"toolbox/core/sidecar"
)

// "Keep files that show…" job (SPEC.md §3.9): sorts its inputs into the ones
// that match a description and the others. It never copies, writes or
// modifies a file, and never adds anything to the index.

// Picture cut-offs: probabilities p = sigmoid(scale·cos + bias). These are
// the documented Smart search strengths (core/mediaindex labels.go: Strong
// 0.3, Good 0.1, Maybe 0.03); the index and this step must agree.
const (
	probStrong = 0.30
	probGood   = 0.10
	probMaybe  = 0.03
)

// MaxQueryChars is the longest description the step takes.
const MaxQueryChars = 200

const (
	filterFrames   = 8   // video frames embedded per file
	filterEdge     = 224 // picture edge, as the index prepares them
	filterPDFDPI   = 40
	filterPDFBytes = 200 << 20
)

// filterResult is the job's result JSON.
type filterResult struct {
	Kept    []string `json:"kept"`
	Other   []string `json:"other,omitempty"`
	Matched int      `json:"matched"`
	Best    string   `json:"best"`
}

// strengthRank orders strengths; unknown ones (and "") don't count.
func strengthRank(s string) int {
	switch s {
	case core.StrengthLabel, core.StrengthStrong:
		return 3
	case core.StrengthGood:
		return 2
	case core.StrengthMaybe:
		return 1
	}
	return 0
}

func (s FilterStrength) rank() int {
	switch s {
	case FilterStrong:
		return 3
	case FilterMaybe:
		return 1
	}
	return 2
}

func probStrength(p float64) string {
	switch {
	case p >= probStrong:
		return core.StrengthStrong
	case p >= probGood:
		return core.StrengthGood
	case p >= probMaybe:
		return core.StrengthMaybe
	}
	return ""
}

// filterOptions decodes strictly; an empty match or strength means the
// default, anything else must be valid.
func filterOptions(raw json.RawMessage) (FilterOptions, error) {
	o, err := core.DecodeOptionsJSON[FilterOptions](raw)
	if err != nil {
		return o, err
	}
	d := DefaultFilterOptions()
	if o.Match == "" {
		o.Match = d.Match
	}
	if o.Strength == "" {
		o.Strength = d.Strength
	}
	switch o.Match {
	case MatchPicture, MatchText, MatchBoth:
	default:
		return o, core.ValidationError("Choose how to match", map[string]string{"match": "Choose picture, text or both"})
	}
	switch o.Strength {
	case FilterStrong, FilterGood, FilterMaybe:
	default:
		return o, core.ValidationError("Choose how sure a match must be", map[string]string{"strength": "Choose strong, good or maybe"})
	}
	return o, nil
}

func (m *FilterModule) validate(inputs []string, options json.RawMessage) error {
	o, err := filterOptions(options)
	if err != nil {
		return err
	}
	q := strings.TrimSpace(o.Query)
	if q == "" {
		return core.ValidationError("Describe what to keep", map[string]string{"query": "Describe what to keep"})
	}
	if utf8.RuneCountInString(q) > MaxQueryChars {
		return core.ValidationError("Keep the description under 200 characters", map[string]string{"query": "Keep it under 200 characters"})
	}
	if len(inputs) == 0 {
		return core.ValidationError("There's no file to check", nil)
	}
	return nil
}

// Optional index accessors (*core/mediaindex.Index has both).
type textLister interface {
	Texts(ctx context.Context, path string) ([]core.MediaText, error)
}
type labelLister interface {
	Labels(ctx context.Context, path string) ([]core.MediaLabel, error)
}

func (m *FilterModule) run(ctx context.Context, job *core.JobContext) error {
	o, err := filterOptions(job.Options)
	if err != nil {
		return err
	}
	if err := m.validate(job.Inputs, job.Options); err != nil {
		return err
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	w := m.d.Writer
	if w == nil {
		return core.Errorf(core.CodeNotImplemented, "Smart search isn't available")
	}
	query := strings.TrimSpace(o.Query)
	wantPicture := o.Match != MatchText
	wantText := o.Match != MatchPicture

	picture := make([]string, len(job.Inputs)) // strength by picture
	if wantPicture {
		job.Progress(core.IndeterminateProgress, "Looking at the pictures")
		picture, err = m.pictureStrengths(ctx, job, w, query)
		if err != nil {
			return err
		}
	}
	text := make([]string, len(job.Inputs))
	if wantText {
		job.Progress(core.IndeterminateProgress, "Reading the text")
		for i, p := range job.Inputs {
			if err := ctx.Err(); err != nil {
				return err
			}
			text[i] = w.TextMatch(query, m.textsOf(ctx, w, p))
		}
	}

	res := filterResult{Kept: []string{}, Other: []string{}}
	need := o.Strength.rank()
	firstKept := ""
	for i, p := range job.Inputs {
		matched := max(strengthRank(picture[i]), strengthRank(text[i])) >= need
		if matched != o.Invert {
			res.Kept = append(res.Kept, p)
			if firstKept == "" {
				firstKept = p
			}
		} else {
			res.Other = append(res.Other, p)
		}
	}
	res.Matched = len(res.Kept)
	if !o.Invert && firstKept != "" {
		res.Best = m.bestLabel(ctx, w, firstKept)
	}
	job.Progress(1, fmt.Sprintf("%d of %d kept", res.Matched, len(job.Inputs)))
	if err := job.SetResult(res); err != nil {
		// A huge batch can overflow the result size; StepOutputs derives
		// "other" from the inputs when it's missing.
		res.Other = nil
		return job.SetResult(res)
	}
	return nil
}

// textsOf is a file's text: the index's chunks when it has any, else (for
// documents) the file's own text.
func (m *FilterModule) textsOf(ctx context.Context, w ix.Writer, path string) []core.MediaText {
	if l, ok := w.(textLister); ok {
		if texts, err := l.Texts(ctx, path); err == nil && len(texts) > 0 {
			return texts
		}
	}
	if !doctext.Supported(path) {
		return nil
	}
	chunks, err := doctext.Extract(path, 0)
	if err != nil {
		return nil
	}
	texts := make([]core.MediaText, 0, len(chunks))
	for _, c := range chunks {
		texts = append(texts, core.MediaText{Source: core.TextSourceDoc, Pos: c.Pos, EndPos: c.EndPos, Text: c.Text})
	}
	return texts
}

// bestLabel is the top visible label of a file ("" when unknown).
func (m *FilterModule) bestLabel(ctx context.Context, w ix.Writer, path string) string {
	l, ok := w.(labelLister)
	if !ok {
		return ""
	}
	labels, err := l.Labels(ctx, path)
	if err != nil {
		return ""
	}
	best, score := "", -1.0
	for _, lb := range labels {
		if lb.Source == core.LabelHidden {
			continue
		}
		if lb.Score > score {
			best, score = lb.Display, lb.Score
			if best == "" {
				best = lb.Label
			}
		}
	}
	return best
}

// pictureStrengths scores every input's pictures against the query.
func (m *FilterModule) pictureStrengths(ctx context.Context, job *core.JobContext, w ix.Writer, query string) ([]string, error) {
	out := make([]string, len(job.Inputs))
	textVec, err := w.TextVector(ctx, query)
	if err != nil {
		return nil, err
	}
	score := func(vecs []ix.VectorAt) string {
		best := 0.0
		for _, v := range vecs {
			best = math.Max(best, w.Prob(textVec, v.Vec))
		}
		return probStrength(best)
	}

	// Indexed and current files use their stored vectors; the rest are
	// prepared and embedded here (nothing is stored).
	var prep []filterPic
	for i, p := range job.Inputs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if vecs, ok := w.Current(ctx, p); ok {
			out[i] = score(vecs)
			continue
		}
		files, perr := m.preparePictures(ctx, job, p, i)
		if perr != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			job.Logf("%s: no picture score (%v)", filepath.Base(p), perr)
			continue
		}
		prep = append(prep, files...)
	}
	if len(prep) == 0 {
		return out, nil
	}
	vecs, err := m.embed(ctx, w, prep)
	if err != nil {
		return nil, err
	}
	byFile := map[int][]ix.VectorAt{}
	for k, pr := range prep {
		if vecs[k] != nil {
			byFile[pr.owner] = append(byFile[pr.owner], ix.VectorAt{Pos: pr.pos, Vec: vecs[k]})
		}
	}
	for i, v := range byFile {
		out[i] = score(v)
	}
	return out, nil
}

// filterPic is one 224 px picture written to TempDir.
type filterPic struct {
	owner int // index into job.Inputs
	pos   int64
	path  string
}

var filterVideoExts = map[string]bool{".mp4": true, ".mov": true, ".m4v": true, ".mkv": true, ".webm": true, ".avi": true}

func (m *FilterModule) preparePictures(ctx context.Context, job *core.JobContext, path string, owner int) ([]filterPic, error) {
	ext := strings.ToLower(filepath.Ext(path))
	dir := job.TempDir
	if dir == "" {
		return nil, fmt.Errorf("no temporary folder")
	}
	switch {
	case ext == ".pdf":
		return m.preparePDF(ctx, dir, path, owner)
	case filterVideoExts[ext]:
		return m.prepareVideo(ctx, job, path, owner)
	case imaging.Supported(path) || imaging.IsHEIC(path):
		url, err := imaging.ThumbUncached(path, filterEdge)
		if err != nil {
			return nil, err
		}
		file, err := writeDataURL(dir, fmt.Sprintf("f%d", owner), url)
		if err != nil {
			return nil, err
		}
		return []filterPic{{owner: owner, pos: -1, path: file}}, nil
	}
	return nil, fmt.Errorf("not a picture")
}

func writeDataURL(dir, stem, url string) (string, error) {
	head, b64, ok := strings.Cut(url, ",")
	if !ok {
		return "", fmt.Errorf("bad preview")
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("decode preview: %w", err)
	}
	ext := ".jpg"
	if strings.Contains(head, "image/png") {
		ext = ".png"
	}
	p := filepath.Join(dir, stem+ext)
	if err := os.WriteFile(p, raw, 0o600); err != nil {
		return "", fmt.Errorf("write preview: %w", err)
	}
	return p, nil
}

// preparePDF renders page 1. Without a renderer (or for a locked PDF) the
// file gets no picture score.
func (m *FilterModule) preparePDF(ctx context.Context, dir, path string, owner int) ([]filterPic, error) {
	if m.d.PDF == nil {
		return nil, fmt.Errorf("no PDF renderer")
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Size() > filterPDFBytes {
		return nil, fmt.Errorf("PDF is unreadable or too large")
	}
	doc, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read PDF: %w", err)
	}
	img, err := m.d.PDF.Render(ctx, doc, "", 0, filterPDFDPI)
	if err != nil {
		return nil, fmt.Errorf("render PDF: %w", err)
	}
	file := filepath.Join(dir, fmt.Sprintf("f%d-p0.png", owner))
	if err := writePNG(file, img); err != nil {
		return nil, err
	}
	return []filterPic{{owner: owner, pos: 0, path: file}}, nil
}

// prepareVideo grabs up to 8 evenly spaced frames with FFmpeg run in TempDir.
func (m *FilterModule) prepareVideo(ctx context.Context, job *core.JobContext, path string, owner int) ([]filterPic, error) {
	ffmpeg, err := job.Tool(deps.FFmpeg)
	if err != nil {
		return nil, err
	}
	var durMs int64
	if ffprobe, perr := job.Tool(deps.FFprobe); perr == nil {
		if info, perr := media.Probe(ctx, ffprobe, path); perr == nil {
			durMs = info.DurationMs
		}
	}
	n := filterFrames
	if durMs > 0 && durMs < int64(filterFrames)*1000 {
		n = max(1, int(durMs/1000))
	}
	if durMs <= 0 {
		n = 1
	}
	var out []filterPic
	for k := range n {
		var at int64
		if durMs > 0 {
			at = durMs * int64(2*k+1) / int64(2*n)
		}
		name := fmt.Sprintf("f%d-v%d.jpg", owner, k)
		args := []string{"-hide_banner", "-nostdin", "-y", "-v", "error",
			"-ss", strconv.FormatFloat(float64(at)/1000, 'f', 3, 64), "-i", path,
			"-frames:v", "1", "-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", filterEdge, filterEdge),
			"-q:v", "3", name}
		if _, err := proc.Run(ctx, proc.Spec{Path: ffmpeg, Args: args, Dir: job.TempDir}); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		file := filepath.Join(job.TempDir, name)
		if _, err := os.Stat(file); err == nil {
			out = append(out, filterPic{owner: owner, pos: at, path: file})
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no frames could be read")
	}
	return out, nil
}

// embed asks the engine for the vectors of every prepared picture (nil for
// one it couldn't read).
func (m *FilterModule) embed(ctx context.Context, w ix.Writer, prep []filterPic) ([][]float32, error) {
	if m.d.Caller == nil {
		return nil, core.Errorf(core.CodeNotImplemented, "The AI engine isn't available")
	}
	paths := make([]string, len(prep))
	for i, p := range prep {
		paths[i] = p.path
	}
	raw, err := m.d.Caller.Call(ctx, "search.embed_images", map[string]any{
		"modelDir": w.Model().Dir,
		"paths":    paths,
		"threads":  max(1, runtime.NumCPU()/2),
	}, func(sidecar.Event) {})
	if err != nil {
		return nil, err
	}
	var res struct {
		Dim     int      `json:"dim"`
		Vectors []string `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("reading the engine's answer: %w", err)
	}
	if len(res.Vectors) != len(prep) {
		return nil, fmt.Errorf("the engine returned %d vectors for %d pictures", len(res.Vectors), len(prep))
	}
	out := make([][]float32, len(prep))
	for i, s := range res.Vectors {
		if s == "" {
			continue
		}
		v, err := decodeHalf(s, res.Dim)
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

// decodeHalf reads base64 little-endian float16 values.
func decodeHalf(s string, dim int) ([]float32, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b)%2 != 0 || (dim > 0 && len(b)/2 != dim) {
		return nil, fmt.Errorf("the engine returned a bad vector")
	}
	v := make([]float32, len(b)/2)
	for i := range v {
		v[i] = halfToFloat(binary.LittleEndian.Uint16(b[2*i:]))
	}
	return v, nil
}

func halfToFloat(h uint16) float32 {
	sign := uint32(h>>15) << 31
	exp := uint32(h>>10) & 0x1f
	frac := uint32(h) & 0x3ff
	switch {
	case exp == 0 && frac == 0:
		return math.Float32frombits(sign)
	case exp == 0: // subnormal
		f := float32(frac) / 1024 * float32(math.Pow(2, -14))
		if sign != 0 {
			f = -f
		}
		return f
	case exp == 0x1f:
		return math.Float32frombits(sign | 0x7f800000 | frac<<13)
	}
	return math.Float32frombits(sign | (exp+112)<<23 | frac<<13)
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("write page: %w", err)
	}
	err = png.Encode(f, img)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("write page: %w", err)
	}
	return nil
}
