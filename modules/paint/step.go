package paint

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"

	"golang.org/x/image/draw"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// prepareStep makes one job per picture.
func (m *Module) prepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	if err := m.checkStepSources(ctx, o); err != nil {
		return nil, err
	}
	files := req.Item.Files
	if len(files) == 0 {
		for _, it := range req.Items {
			files = append(files, it.Files...)
		}
	}
	jobs := make([]core.StepJob, 0, len(files))
	for _, f := range files {
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: o})
	}
	return jobs, nil
}

func (m *Module) runStep(ctx context.Context, job *core.JobContext) error {
	o, err := decodeStep(job.Options)
	if err != nil {
		return err
	}
	if err := m.checkStepSources(ctx, o); err != nil {
		return err
	}
	if o.Action == StepDissolve {
		return m.runDissolve(ctx, job, o)
	}
	return m.runOverlay(ctx, job, o)
}

func (m *Module) runOverlay(ctx context.Context, job *core.JobContext, o StepOptions) error {
	doc, err := m.load(ctx, o.Project)
	if err != nil {
		return err
	}
	job.Progress(0.02, "Reading the painting")
	art, err := m.flatten(ctx, o.Project, doc, flattenOpts{})
	if err != nil {
		return err
	}
	for i, in := range job.Inputs {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("overlay cancelled: %w", err)
		}
		job.SetTitle("Painting over " + filepath.Base(in))
		base, err := readImage(ctx, in)
		if err != nil {
			return err
		}
		fitOnto(base, art, o.Fit)
		b, err := encodePNG(base)
		if err != nil {
			return err
		}
		tmp := filepath.Join(job.TempDir, fmt.Sprintf("overlay-%d.png", i))
		if err := os.WriteFile(tmp, b, 0o644); err != nil {
			return fmt.Errorf("write overlay: %w", err)
		}
		dest, err := placeNew(tmp, job.OutputDir, cleanFileName(stemOf(in))+" painted", ".png")
		if err != nil {
			return err
		}
		if _, err := job.OutputFrom(dest, in); err != nil {
			return err
		}
		job.Progress(float64(i+1)/float64(len(job.Inputs)), "Painting over")
	}
	return nil
}

// maskImage builds a binary mask (255 = dissolve) from the step's source and
// scales it (nearest) to w×h.
func (m *Module) maskImage(ctx context.Context, o StepOptions, w, h int) (*image.Gray, error) {
	var src *image.Gray
	if o.Layer != "" {
		doc, err := m.load(ctx, o.Project)
		if err != nil {
			return nil, err
		}
		for _, l := range doc.Layers {
			if l.ID != o.Layer {
				continue
			}
			img, err := m.layerImage(ctx, o.Project, l, doc.Width, doc.Height)
			if err != nil {
				return nil, err
			}
			src = image.NewGray(img.Bounds())
			for i := 0; i < len(img.Pix)/4; i++ {
				if img.Pix[i*4+3] > 0 {
					src.Pix[i] = 255
				}
			}
		}
		if src == nil {
			return nil, core.ValidationError("That layer no longer exists in the painting", nil)
		}
	} else {
		p, err := m.cfg.SavedMask(o.Mask)
		if err != nil {
			return nil, err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, core.Errorf(core.CodeNotFound, "That mask's picture is missing").WithCause(err)
		}
		img, err := png.Decode(bytes.NewReader(b))
		if err != nil {
			return nil, core.Errorf(core.CodeValidation, "That mask isn't a valid picture").WithCause(err)
		}
		src = image.NewGray(image.Rect(0, 0, img.Bounds().Dx(), img.Bounds().Dy()))
		for y := 0; y < src.Rect.Dy(); y++ {
			for x := 0; x < src.Rect.Dx(); x++ {
				c := img.At(img.Bounds().Min.X+x, img.Bounds().Min.Y+y)
				_, _, _, a := c.RGBA()
				l := uint32(color.GrayModel.Convert(c).(color.Gray).Y)
				if l*(a>>8)/255 > 127 {
					src.Pix[y*src.Stride+x] = 255
				}
			}
		}
	}
	empty := true
	for _, v := range src.Pix {
		if v != 0 {
			empty = false
			break
		}
	}
	if empty {
		return nil, core.ValidationError("The mask is empty: there is nothing to dissolve", nil)
	}
	if src.Rect.Dx() == w && src.Rect.Dy() == h {
		return src, nil
	}
	dst := image.NewGray(image.Rect(0, 0, w, h))
	draw.NearestNeighbor.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return dst, nil
}

func (m *Module) runDissolve(ctx context.Context, job *core.JobContext, o StepOptions) error {
	if m.cfg.Engine == nil {
		return core.Errorf(core.CodeInternal, "The AI engine isn't available")
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	if m.cfg.Models == nil {
		return core.ErrDependencyMissing("The fill model", "Install the Image pack in Settings → Tool packs")
	}
	spec, ok := m.cfg.Models.Inpaint(o.Model)
	if !ok {
		return core.ErrDependencyMissing("The "+o.Model+" fill model", "Install the Image pack's fill model in Settings → Tool packs")
	}
	for i, in := range job.Inputs {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("dissolve cancelled: %w", err)
		}
		job.SetTitle("Dissolving " + filepath.Base(in))
		img, err := readImage(ctx, in)
		if err != nil {
			return err
		}
		w, h := img.Bounds().Dx(), img.Bounds().Dy()
		mask, err := m.maskImage(ctx, o, w, h)
		if err != nil {
			return err
		}
		srcB, err := encodePNG(img)
		if err != nil {
			return err
		}
		maskB, err := encodePNG(mask)
		if err != nil {
			return err
		}
		dir := filepath.Join(job.TempDir, fmt.Sprintf("d%d", i))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create work folder: %w", err)
		}
		srcP, maskP, outP := filepath.Join(dir, "src.png"), filepath.Join(dir, "mask.png"), filepath.Join(dir, "out.png")
		if err := os.WriteFile(srcP, srcB, 0o644); err != nil {
			return fmt.Errorf("write source: %w", err)
		}
		if err := os.WriteFile(maskP, maskB, 0o644); err != nil {
			return fmt.Errorf("write mask: %w", err)
		}
		params := map[string]any{
			"src": srcP, "mask": maskP, "out": outP, "model": o.Model,
			"passes": o.Passes, "ghost": o.Ghost, "drift": o.Drift, "driftDir": "", "offset": []int{0, 0}, "seed": o.Seed,
		}
		mergeModelSpec(params, spec)
		lo, span := float64(i)/float64(len(job.Inputs)), 1/float64(len(job.Inputs))
		res, err := m.cfg.Engine.Call(ctx, "paint.fill", params, func(ev sidecar.Event) {
			switch ev.Kind {
			case "progress":
				if ev.Pct >= 0 {
					job.Progress(lo+span*ev.Pct, ev.Msg)
				} else {
					job.Progress(core.IndeterminateProgress, ev.Msg)
				}
			case "log":
				job.Log(core.StreamStdout, ev.Line)
			}
		})
		if err != nil {
			return err
		}
		result := outP
		var r struct {
			Output string `json:"output"`
		}
		if json.Unmarshal(res, &r) == nil && r.Output != "" {
			result = r.Output
		}
		dest, err := placeNew(result, job.OutputDir, cleanFileName(stemOf(in))+" dissolved", ".png")
		if err != nil {
			return err
		}
		if _, err := job.OutputFrom(dest, in); err != nil {
			return err
		}
	}
	return nil
}

// mergeModelSpec adds the resolver's model description to the engine params:
// a JSON string is the model's file ("modelPath"); an object's fields are
// merged in as they are.
func mergeModelSpec(params map[string]any, spec json.RawMessage) {
	var s string
	if json.Unmarshal(spec, &s) == nil {
		params["modelPath"] = s
		return
	}
	var obj map[string]any
	if json.Unmarshal(spec, &obj) == nil {
		for k, v := range obj {
			params[k] = v
		}
	}
}
