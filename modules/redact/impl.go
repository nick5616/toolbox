package redact

// Validate, Run and the cache prune (SPEC.md §8). The engine does the work;
// this file decides what to ask it and registers what comes back.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/sidecar"
)

const cacheMaxAge = 7 * 24 * time.Hour

func isVideo(path string) bool {
	return slices.Contains(media.VideoExtensions(), strings.ToLower(filepath.Ext(path)))
}

// split separates the inputs into images and videos.
func split(inputs []string) (images, videos []string) {
	for _, in := range inputs {
		if isVideo(in) {
			videos = append(videos, in)
		} else {
			images = append(images, in)
		}
	}
	return images, videos
}

// outputExt is the extension of the redacted copy: TIFF becomes PNG, HEIC
// becomes JPEG, everything else keeps its format.
func outputExt(input string) string {
	switch ext := strings.ToLower(filepath.Ext(input)); ext {
	case ".tif", ".tiff":
		return ".png"
	case ".heic", ".heif", ".jpeg":
		return ".jpg"
	default:
		return ext
	}
}

func inside(dir, path string) bool {
	if dir == "" || path == "" {
		return false
	}
	d, err1 := filepath.Abs(dir)
	p, err2 := filepath.Abs(path)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(d, p)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

func checkBox(b Box, field string, fields map[string]string) {
	for _, v := range []float64{b.X, b.Y, b.W, b.H} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			fields[field] = "A box has an invalid position"
			return
		}
	}
	if b.W <= 0 || b.H <= 0 {
		fields[field] = "A box needs a size"
	}
}

func validateOptions(o Options) *core.AppError {
	fields := map[string]string{}
	switch o.Action {
	case ActionDetect, ActionApply, ActionAuto:
	default:
		fields["action"] = "Choose detect, apply or auto"
	}
	switch o.Style {
	case StyleBlur, StylePixelate, StyleSolid:
	default:
		fields["style"] = "Choose blur, pixelate or solid"
	}
	switch o.Sensitivity {
	case SensitivityNormal, SensitivityHigh:
	default:
		fields["sensitivity"] = "Choose normal or high"
	}
	if o.Strength < 1 || o.Strength > 10 {
		fields["strength"] = "Strength must be between 1 and 10"
	}
	if o.Padding < 0 || o.Padding > 50 {
		fields["padding"] = "Padding must be between 0 and 50%"
	}
	if (o.Action == ActionDetect || o.Action == ActionAuto) && !o.Faces && !o.Plates {
		fields["faces"] = "Choose faces, number plates or both"
	}
	for _, boxes := range o.ImageBoxes {
		for _, b := range boxes {
			checkBox(b, "imageBoxes", fields)
		}
	}
	for _, b := range o.ManualBoxes {
		checkBox(b.Box, "manualBoxes", fields)
		if b.EndMs <= b.StartMs || b.StartMs < 0 {
			fields["manualBoxes"] = "A manual box needs a start before its end"
		}
	}
	if len(fields) > 0 {
		return core.ValidationError("Some options are invalid", fields)
	}
	return nil
}

func (m *Module) validate(inputs []string, options json.RawMessage) error {
	if err := core.ValidateFileInputs(inputs, Accepts()); err != nil {
		return err
	}
	o, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	if ve := validateOptions(o); ve != nil {
		return ve
	}
	images, videos := split(inputs)
	switch {
	case len(images) > 0 && len(videos) > 0:
		return core.ValidationError("Redact images and videos separately", map[string]string{"inputs": "Redact images and videos separately"})
	case len(videos) > 1:
		return core.ValidationError("Redact one video at a time", map[string]string{"inputs": "Redact one video at a time"})
	}
	if o.Action != ActionApply {
		return nil
	}
	if len(videos) == 1 {
		if !inside(m.cacheDir, o.DetectionsPath) || !strings.EqualFold(filepath.Ext(o.DetectionsPath), ".json") {
			return core.ValidationError("The video's detections are missing", map[string]string{"detectionsPath": "Run the detection again"})
		}
		return nil
	}
	for _, in := range images {
		if _, ok := boxesFor(o.ImageBoxes, in); !ok {
			return core.ValidationError("Every image needs its boxes", map[string]string{"imageBoxes": "Missing boxes for " + filepath.Base(in)})
		}
	}
	return nil
}

// boxesFor finds an image's boxes by its path, tolerating a differently
// written but equal path.
func boxesFor(m map[string][]Box, path string) ([]Box, bool) {
	if b, ok := m[path]; ok {
		return b, true
	}
	clean := filepath.Clean(path)
	for k, b := range m {
		if filepath.Clean(k) == clean {
			return b, true
		}
	}
	return nil, false
}

// eventSink maps engine events onto a job, scaling progress into
// [base, base+span] and registering each output once.
type eventSink struct {
	job        *core.JobContext
	seen       map[string]bool
	err        error
	base, span float64
}

func (s *eventSink) register(path string) {
	if path == "" || s.seen[path] {
		return
	}
	s.seen[path] = true
	if _, err := s.job.Output(path); err != nil && s.err == nil {
		s.err = err
	}
}

func (s *eventSink) onEvent(ev sidecar.Event) {
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
	case "output":
		s.register(ev.Path)
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func countKinds(boxes []Box) (faces, plates int) {
	for _, b := range boxes {
		if !b.Enabled {
			continue
		}
		switch b.Kind {
		case "face":
			faces++
		case "plate":
			plates++
		}
	}
	return faces, plates
}

func foundSummary(faces, plates int) string {
	if faces == 0 && plates == 0 {
		return "No faces or number plates found"
	}
	return plural(faces, "face", "faces") + " · " + plural(plates, "plate", "plates")
}

// engineParams are the model paths (only for what is wanted).
func (m *Module) detectParams(o Options) map[string]any {
	p := map[string]any{"faces": o.Faces, "plates": o.Plates, "sensitivity": string(o.Sensitivity)}
	if o.Faces {
		p["faceModel"] = m.modelPath(models[PresetFaces])
	}
	if o.Plates {
		p["plateModel"] = m.modelPath(models[PresetPlates])
	}
	return p
}

func decode[T any](raw json.RawMessage) (T, error) {
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	return v, nil
}

func (m *Module) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[Options](job)
	if err != nil {
		return err
	}
	if ve := validateOptions(o); ve != nil {
		return ve
	}
	if len(job.Inputs) == 0 {
		return core.ValidationError("Add at least one file", map[string]string{"inputs": "Add at least one file"})
	}
	images, videos := split(job.Inputs)
	if len(images) > 0 && len(videos) > 0 {
		return core.ValidationError("Redact images and videos separately", nil)
	}
	if len(videos) > 1 {
		return core.ValidationError("Redact one video at a time", nil)
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	if len(job.Inputs) == 1 {
		job.SetTitle(filepath.Base(job.Inputs[0]))
	} else {
		job.SetTitle(plural(len(job.Inputs), "image", "images"))
	}
	if len(videos) == 1 {
		return m.runVideo(ctx, job, o, videos[0])
	}
	return m.runImages(ctx, job, o, images)
}

// -- images ------------------------------------------------------------------------

func (m *Module) runImages(ctx context.Context, job *core.JobContext, o Options, images []string) error {
	res := Result{Action: o.Action, Images: []ImageDetections{}, Outputs: []string{}}
	boxes := map[string][]Box{}
	n := float64(len(images))
	sink := &eventSink{job: job, seen: map[string]bool{}}

	if o.Action == ActionDetect || o.Action == ActionAuto {
		if err := m.requireModels(o.Faces, o.Plates); err != nil {
			return err
		}
		for i, in := range images {
			sink.base, sink.span = float64(i)/n, 1/n
			if o.Action == ActionAuto {
				sink.span = 0.5 / n
				sink.base = float64(i) * 0.5 / n
			}
			params := m.detectParams(o)
			params["path"] = in
			raw, err := m.sc.Call(ctx, "redact.detect_image", params, sink.onEvent)
			if err != nil {
				return err
			}
			d, err := decode[ImageDetections](raw)
			if err != nil {
				return err
			}
			d.Path = in
			if d.Boxes == nil {
				d.Boxes = []Box{}
			}
			res.Images = append(res.Images, d)
			boxes[in] = d.Boxes
		}
	} else {
		for _, in := range images {
			b, _ := boxesFor(o.ImageBoxes, in)
			boxes[in] = b
		}
	}

	if o.Action == ActionDetect {
		faces, plates := 0, 0
		for _, d := range res.Images {
			f, p := countKinds(d.Boxes)
			faces, plates = faces+f, plates+p
		}
		if err := job.SetResult(res); err != nil {
			return err
		}
		job.Progress(1, foundSummary(faces, plates))
		return nil
	}

	// apply / auto
	if len(images) > 0 && o.Action == ActionApply {
		for _, in := range images {
			if _, ok := boxesFor(o.ImageBoxes, in); !ok {
				return core.ValidationError("Every image needs its boxes", map[string]string{"imageBoxes": "Missing boxes for " + filepath.Base(in)})
			}
		}
	}
	applied := 0
	for i, in := range images {
		out := core.UniquePath(job.OutputDir, core.StemName(in)+" (redacted)", outputExt(in))
		sink.base, sink.span = float64(i)/n, 1/n
		if o.Action == ActionAuto {
			sink.base, sink.span = (float64(i)+n)/(2*n), 0.5/n
		}
		raw, err := m.sc.Call(ctx, "redact.apply_image", map[string]any{
			"path": in, "out": out, "boxes": boxes[in], "style": string(o.Style), "strength": o.Strength,
			"padding": o.Padding, "stripMetadata": o.StripMetadata,
		}, sink.onEvent)
		if err != nil {
			return err
		}
		r, err := decode[struct {
			Out     string `json:"out"`
			Applied int    `json:"applied"`
		}](raw)
		if err != nil {
			return err
		}
		if r.Out == "" {
			r.Out = out
		}
		sink.register(r.Out)
		if sink.err != nil {
			return sink.err
		}
		res.Outputs = append(res.Outputs, r.Out)
		applied += r.Applied
	}
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, fmt.Sprintf("Redacted %s · %s hidden", plural(len(images), "image", "images"), plural(applied, "area", "areas")))
	return nil
}

// -- video -------------------------------------------------------------------------

func (m *Module) runVideo(ctx context.Context, job *core.JobContext, o Options, input string) error {
	ffmpeg, err := job.Tool("ffmpeg")
	if err != nil {
		return err
	}
	res := Result{Action: o.Action, Images: []ImageDetections{}, Outputs: []string{}}
	sink := &eventSink{job: job, seen: map[string]bool{}, span: 1}
	detections := o.DetectionsPath
	disabled := o.DisabledTracks

	if o.Action == ActionDetect || o.Action == ActionAuto {
		if err := m.requireModels(o.Faces, o.Plates); err != nil {
			return err
		}
		// A detect job leaves its file in the cache for the later apply; auto
		// needs it only for this run.
		dir := m.cacheDir
		if o.Action == ActionAuto || dir == "" {
			dir = job.TempDir
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("creating the detections folder: %w", err)
		}
		cache := filepath.Join(dir, job.ID+".json")
		if job.ID == "" {
			cache = filepath.Join(dir, core.StemName(input)+".json")
		}
		if o.Action == ActionAuto {
			sink.span = 0.5
		}
		params := m.detectParams(o)
		params["path"], params["ffmpeg"], params["cachePath"] = input, ffmpeg, cache
		raw, err := m.sc.Call(ctx, "redact.detect_video", params, sink.onEvent)
		if err != nil {
			return err
		}
		v, err := decode[VideoDetections](raw)
		if err != nil {
			return err
		}
		v.DetectionsPath = cache
		if v.Tracks == nil {
			v.Tracks = []Track{}
		}
		for i := range v.Tracks {
			if v.Tracks[i].Samples == nil {
				v.Tracks[i].Samples = []TrackSample{}
			}
		}
		res.Video = &v
		detections = cache
		disabled = disabled[:0:0]
		for _, t := range v.Tracks {
			if !t.Enabled {
				disabled = append(disabled, t.ID)
			}
		}
		if o.Action == ActionDetect {
			if err := job.SetResult(res); err != nil {
				return err
			}
			enabled := 0
			for _, t := range v.Tracks {
				if t.Enabled {
					enabled++
				}
			}
			job.Progress(1, plural(enabled, "face or plate track", "face and plate tracks")+" found")
			return nil
		}
	} else if !inside(m.cacheDir, detections) {
		return core.ValidationError("The video's detections are missing", map[string]string{"detectionsPath": "Run the detection again"})
	}

	out := core.UniquePath(job.OutputDir, core.StemName(input)+" (redacted)", ".mp4")
	if o.Action == ActionAuto {
		sink.base, sink.span = 0.5, 0.5
	}
	if disabled == nil {
		disabled = []string{}
	}
	manual := o.ManualBoxes
	if manual == nil {
		manual = []TimedBox{}
	}
	raw, err := m.sc.Call(ctx, "redact.apply_video", map[string]any{
		"path": input, "ffmpeg": ffmpeg, "out": out, "detectionsPath": detections, "disabledTracks": disabled,
		"manualBoxes": manual, "style": string(o.Style), "strength": o.Strength, "padding": o.Padding,
		"stripMetadata": o.StripMetadata,
	}, sink.onEvent)
	if err != nil {
		return err
	}
	r, err := decode[struct {
		Out string `json:"out"`
	}](raw)
	if err != nil {
		return err
	}
	if r.Out == "" {
		r.Out = out
	}
	sink.register(r.Out)
	if sink.err != nil {
		return sink.err
	}
	res.Outputs = append(res.Outputs, r.Out)
	if err := job.SetResult(res); err != nil {
		return err
	}
	job.Progress(1, "Redacted video saved")
	return nil
}

// pruneCache deletes detection files older than 7 days.
func (m *Module) pruneCache() {
	if m.cacheDir == "" {
		return
	}
	entries, err := os.ReadDir(m.cacheDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-cacheMaxAge)
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(m.cacheDir, e.Name()))
		}
	}
}
