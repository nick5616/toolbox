package pdf

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
	"golang.org/x/image/draw"
)

// minImageSide is the smallest side (px) an image needs to be recompressed.
const minImageSide = 300

// alreadyCompactRatio: outputs at or above this fraction of the input are
// discarded ("Already compact").
const alreadyCompactRatio = 0.95

// compressLevel is one row of the SPEC §6.4 table.
type compressLevel struct{ dpi, quality int }

func levelParams(level string) compressLevel {
	switch level {
	case LevelSmall:
		return compressLevel{110, 55}
	case LevelHigh:
		return compressLevel{220, 82}
	default:
		return compressLevel{150, 70}
	}
}

// imgJob is one image XObject selected for recompression.
type imgJob struct {
	objNr  int
	sd     types.StreamDict // copy; Raw/Content are read-only here
	w, h   int
	comps  int  // 1 (gray), 3 (rgb) or 4 (cmyk)
	isDCT  bool // else raw flate pixels
	invert bool // CMYK /Decode [1 0 ...]
	capPx  int  // long-edge cap in pixels
}

// imgResult is a successfully shrunk image.
type imgResult struct {
	objNr int
	data  []byte
	w, h  int
	gray  bool
}

// compressResult describes a finished compression.
type compressResult struct {
	recompressed int
}

// compressPDF recompresses the images of in and writes the optimised file to
// outTmp (inside the job's temp dir). progress(done,total) counts images.
func compressPDF(ctx context.Context, in, outTmp, password string, lvl compressLevel, progress func(done, total int)) (compressResult, error) {
	f, err := os.Open(in)
	if err != nil {
		return compressResult{}, fmt.Errorf("open %s: %w", in, err)
	}
	xctx, err := api.ReadValidateAndOptimize(ctx, f, conf(password), nil)
	_ = f.Close()
	if err != nil {
		return compressResult{}, mapErr(ctx, err, password)
	}

	jobs := collectImages(ctx, xctx, lvl)
	results, err := recompressImages(ctx, jobs, lvl.quality, progress)
	if err != nil {
		return compressResult{}, err
	}
	for _, r := range results {
		applyResult(xctx, r)
	}

	stage1 := outTmp + ".stage1"
	defer os.Remove(stage1)
	if err := api.WriteContextFile(ctx, xctx, stage1); err != nil {
		removePartial(stage1)
		return compressResult{}, mapErr(ctx, err, password)
	}
	// Dedupe pass; keep whichever file is smaller (optimize can grow some files).
	stage2 := outTmp + ".stage2"
	defer os.Remove(stage2)
	best := stage1
	if err := api.OptimizeFile(ctx, stage1, stage2, conf(password), nil); err != nil {
		if ctx.Err() != nil {
			return compressResult{}, ctx.Err()
		}
		removePartial(stage2) // keep stage1
	} else if s1, e1 := os.Stat(stage1); e1 == nil {
		if s2, e2 := os.Stat(stage2); e2 == nil && s2.Size() < s1.Size() {
			best = stage2
		}
	}
	if err := moveFile(best, outTmp); err != nil {
		return compressResult{}, err
	}
	return compressResult{recompressed: len(results)}, nil
}

// collectImages selects the image XObjects eligible for recompression.
func collectImages(ctx context.Context, xctx *model.Context, lvl compressLevel) []imgJob {
	// Largest page long edge (inches) per image, from the page resources.
	dims, _ := xctx.PageDims(ctx)
	longIn := make([]float64, len(dims))
	maxAll := 0.0
	for i, d := range dims {
		longIn[i] = max(d.Width, d.Height) / 72
		maxAll = max(maxAll, longIn[i])
	}
	pageLong := map[int]float64{}
	if xctx.Optimize != nil {
		for pi, set := range xctx.Optimize.PageImages {
			if pi >= len(longIn) {
				break
			}
			for objNr := range set {
				pageLong[objNr] = max(pageLong[objNr], longIn[pi])
			}
		}
	}

	var out []imgJob
	for objNr, e := range xctx.Table {
		if e == nil || e.Free {
			continue
		}
		sd, ok := e.Object.(types.StreamDict)
		if !ok {
			continue
		}
		if st, _ := sd.Dict["Subtype"].(types.Name); st != "Image" {
			continue
		}
		j, ok := classify(xctx, objNr, sd)
		if !ok {
			continue
		}
		in := pageLong[objNr]
		if in == 0 {
			in = maxAll
		}
		j.capPx = int(float64(lvl.dpi) * in)
		if j.capPx < 1 {
			continue
		}
		out = append(out, j)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].objNr < out[b].objNr })
	return out
}

func intEntry(d types.Dict, key string) int {
	switch v := d[key].(type) {
	case types.Integer:
		return int(v)
	case types.Float:
		return int(v)
	}
	return 0
}

// classify decides whether an image qualifies and extracts its parameters.
func classify(xctx *model.Context, objNr int, sd types.StreamDict) (imgJob, bool) {
	d := sd.Dict
	for _, k := range []string{"SMask", "Mask", "ImageMask", "SMaskInData", "Matte"} {
		if _, has := d[k]; has {
			if b, isBool := d[k].(types.Boolean); !(isBool && !bool(b)) {
				return imgJob{}, false
			}
		}
	}
	w, h := intEntry(d, "Width"), intEntry(d, "Height")
	if w < minImageSide || h < minImageSide {
		return imgJob{}, false
	}
	if bpc := intEntry(d, "BitsPerComponent"); bpc != 0 && bpc != 8 {
		return imgJob{}, false
	}
	if len(sd.FilterPipeline) != 1 {
		return imgJob{}, false
	}
	j := imgJob{objNr: objNr, sd: sd, w: w, h: h}
	switch sd.FilterPipeline[0].Name {
	case "DCTDecode":
		j.isDCT = true
	case "FlateDecode":
	default:
		return imgJob{}, false
	}
	n, ok := csComponents(xctx, d["ColorSpace"])
	if !ok {
		return imgJob{}, false
	}
	j.comps = n
	if !j.isDCT && n == 4 {
		return imgJob{}, false
	}
	if dec, has := d["Decode"]; has {
		arr, isArr := dec.(types.Array)
		if !isArr || len(arr) < 2 {
			return imgJob{}, false
		}
		first, _ := arr[0].(types.Integer)
		second, _ := arr[1].(types.Integer)
		switch {
		case first == 0 && second == 1: // identity
		case first == 1 && second == 0 && n == 4 && j.isDCT:
			j.invert = true
		default:
			return imgJob{}, false
		}
	}
	return j, true
}

// csComponents returns the component count of a colour space the compressor
// understands (device spaces and ICCBased).
func csComponents(xctx *model.Context, o types.Object) (int, bool) {
	switch v := o.(type) {
	case types.Name:
		switch v {
		case "DeviceGray", "G", "CalGray":
			return 1, true
		case "DeviceRGB", "RGB", "CalRGB":
			return 3, true
		case "DeviceCMYK", "CMYK":
			return 4, true
		}
	case types.IndirectRef:
		r, err := xctx.Dereference(v)
		if err != nil || r == nil {
			return 0, false
		}
		if _, isRef := r.(types.IndirectRef); isRef {
			return 0, false
		}
		return csComponents(xctx, r)
	case types.Array:
		if len(v) == 2 {
			if name, _ := v[0].(types.Name); name == "ICCBased" {
				sd, _, err := xctx.DereferenceStreamDict(v[1])
				if err != nil || sd == nil {
					return 0, false
				}
				n := intEntry(sd.Dict, "N")
				if n == 1 || n == 3 || n == 4 {
					return n, true
				}
			}
		}
	}
	return 0, false
}

// recompressImages runs the jobs on a worker pool of max(1, NumCPU/2).
func recompressImages(ctx context.Context, jobs []imgJob, quality int, progress func(done, total int)) ([]imgResult, error) {
	if len(jobs) == 0 {
		return nil, nil
	}
	workers := max(1, runtime.NumCPU()/2)
	in := make(chan imgJob)
	var (
		mu      sync.Mutex
		results []imgResult
		done    int
		wg      sync.WaitGroup
	)
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range in {
				if ctx.Err() != nil {
					continue // drain
				}
				r, ok := recompressOne(j, quality)
				mu.Lock()
				done++
				if ok {
					results = append(results, r)
				}
				d := done
				mu.Unlock()
				if progress != nil {
					progress(d, len(jobs))
				}
			}
		}()
	}
feed:
	for _, j := range jobs {
		select {
		case in <- j:
		case <-ctx.Done():
			break feed
		}
	}
	close(in)
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return results, nil
}

// recompressOne decodes, downsamples and re-encodes one image. ok is false
// when the image can't be decoded or the result isn't smaller.
func recompressOne(j imgJob, quality int) (imgResult, bool) {
	img, ok := decodeImage(j)
	if !ok {
		return imgResult{}, false
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w < 1 || h < 1 {
		return imgResult{}, false
	}
	_, isGray := img.(*image.Gray)
	if long := max(w, h); long > j.capPx {
		nw, nh := max(1, w*j.capPx/long), max(1, h*j.capPx/long)
		var dst draw.Image
		if isGray {
			dst = image.NewGray(image.Rect(0, 0, nw, nh))
		} else {
			dst = image.NewRGBA(image.Rect(0, 0, nw, nh))
		}
		draw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
		img = dst
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return imgResult{}, false
	}
	if buf.Len() >= len(j.sd.Raw) {
		return imgResult{}, false
	}
	nb := img.Bounds()
	return imgResult{objNr: j.objNr, data: buf.Bytes(), w: nb.Dx(), h: nb.Dy(), gray: isGray}, true
}

// decodeImage returns the pixels as Gray or RGB-compatible (never CMYK).
func decodeImage(j imgJob) (image.Image, bool) {
	if j.isDCT {
		img, err := jpeg.Decode(bytes.NewReader(j.sd.Raw))
		if err != nil {
			return nil, false
		}
		if c, ok := img.(*image.CMYK); ok {
			return cmykToRGBA(c, j.invert), true
		}
		return img, true
	}
	sd := j.sd // copy: Decode fills Content on the copy only
	sd.Content = nil
	if err := sd.Decode(); err != nil {
		return nil, false
	}
	pix := sd.Content
	if len(pix) != j.w*j.h*j.comps {
		return nil, false
	}
	switch j.comps {
	case 1:
		return &image.Gray{Pix: pix, Stride: j.w, Rect: image.Rect(0, 0, j.w, j.h)}, true
	case 3:
		rgba := image.NewRGBA(image.Rect(0, 0, j.w, j.h))
		for i, o := 0, 0; i < len(pix); i, o = i+3, o+4 {
			rgba.Pix[o], rgba.Pix[o+1], rgba.Pix[o+2], rgba.Pix[o+3] = pix[i], pix[i+1], pix[i+2], 255
		}
		return rgba, true
	}
	return nil, false
}

// cmykToRGBA converts Go's decoded CMYK to RGB. Go's JPEG decoder always
// undoes the Adobe inversion, so its values are 255-raw. PDF viewers use the
// raw stream: without /Decode [1 0 ...] raw is the real ink amount; with it,
// raw is inverted ink. Hence ink = 255-g normally, and g when invert is set.
func cmykToRGBA(c *image.CMYK, invert bool) *image.RGBA {
	b := c.Bounds()
	out := image.NewRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			p := c.CMYKAt(x, y)
			if !invert {
				p = color.CMYK{C: 255 - p.C, M: 255 - p.M, Y: 255 - p.Y, K: 255 - p.K}
			}
			r, g, bl := color.CMYKToRGB(p.C, p.M, p.Y, p.K)
			out.SetRGBA(x, y, color.RGBA{R: r, G: g, B: bl, A: 255})
		}
	}
	return out
}

// applyResult swaps the stream of a recompressed image for the JPEG data.
func applyResult(xctx *model.Context, r imgResult) {
	e, ok := xctx.Table[r.objNr]
	if !ok || e == nil {
		return
	}
	sd, ok := e.Object.(types.StreamDict)
	if !ok {
		return
	}
	n := int64(len(r.data))
	sd.Raw = r.data
	sd.Content = nil
	sd.StreamLength = &n
	sd.StreamLengthObjNr = nil
	sd.FilterPipeline = []types.PDFFilter{{Name: "DCTDecode"}}
	sd.Dict["Filter"] = types.Name("DCTDecode")
	sd.Dict["Length"] = types.Integer(len(r.data))
	sd.Dict["Width"] = types.Integer(r.w)
	sd.Dict["Height"] = types.Integer(r.h)
	sd.Dict["BitsPerComponent"] = types.Integer(8)
	if r.gray {
		sd.Dict["ColorSpace"] = types.Name("DeviceGray")
	} else {
		sd.Dict["ColorSpace"] = types.Name("DeviceRGB")
	}
	delete(sd.Dict, "Decode")
	delete(sd.Dict, "DecodeParms")
	delete(sd.Dict, "DP")
	e.Object = sd
}

// moveFile renames src to dst, copying when they are on different volumes.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read %s: %w", src, err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(dst), err)
	}
	if err := os.WriteFile(dst, b, 0o644); err != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("write %s: %w", dst, err)
	}
	_ = os.Remove(src)
	return nil
}
