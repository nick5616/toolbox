package pdf

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"

	"toolbox/core"
)

const (
	marginSmallPts = 36.0 // 0.5 in
	fitAssumedDPI  = 150.0
	maxPageDim     = 14400.0 // PDF page limit
)

type imgInfo struct {
	path   string
	w, h   int
	orient int // EXIF orientation 1..8
}

func readImgInfo(path string) (imgInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return imgInfo{}, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(bufio.NewReader(f))
	if err != nil {
		return imgInfo{}, core.ValidationError(fmt.Sprintf("%s can't be read as an image", filepath.Base(path)), nil).WithCause(err)
	}
	ii := imgInfo{path: path, w: cfg.Width, h: cfg.Height, orient: 1}
	if ext := strings.ToLower(filepath.Ext(path)); ext == ".jpg" || ext == ".jpeg" {
		if _, err := f.Seek(0, io.SeekStart); err == nil {
			ii.orient = jpegOrientation(f)
		}
	}
	return ii, nil
}

// jpegOrientation reads the EXIF orientation tag (1 when absent).
func jpegOrientation(r io.Reader) int {
	br := bufio.NewReader(r)
	var soi [2]byte
	if _, err := io.ReadFull(br, soi[:]); err != nil || soi != [2]byte{0xFF, 0xD8} {
		return 1
	}
	for {
		var h [4]byte
		if _, err := io.ReadFull(br, h[:]); err != nil || h[0] != 0xFF {
			return 1
		}
		size := int(binary.BigEndian.Uint16(h[2:])) - 2
		if size < 0 {
			return 1
		}
		if h[1] == 0xE1 {
			seg := make([]byte, size)
			if _, err := io.ReadFull(br, seg); err != nil {
				return 1
			}
			return exifOrientation(seg)
		}
		if h[1] == 0xDA { // start of scan: no EXIF before it
			return 1
		}
		if _, err := br.Discard(size); err != nil {
			return 1
		}
	}
}

func exifOrientation(seg []byte) int {
	if len(seg) < 14 || string(seg[:6]) != "Exif\x00\x00" {
		return 1
	}
	t := seg[6:]
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 1
	}
	n := int(bo.Uint16(t[off:]))
	for i := range n {
		e := off + 2 + i*12
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:]) == 0x0112 {
			if v := int(bo.Uint16(t[e+8:])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// uprightJPEG rewrites a JPEG with a non-trivial EXIF orientation as an upright PNG-free JPEG.
func uprightJPEG(src, dst string, orient int) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	img, err := jpeg.Decode(bufio.NewReader(f))
	if err != nil {
		return err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	swap := orient >= 5
	nw, nh := w, h
	if swap {
		nw, nh = h, w
	}
	out := image.NewRGBA(image.Rect(0, 0, nw, nh))
	for y := range h {
		for x := range w {
			var dx, dy int
			switch orient {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			default:
				dx, dy = x, y
			}
			out.Set(dx, dy, img.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	o, err := os.Create(dst)
	if err != nil {
		return err
	}
	if err := jpeg.Encode(o, out, &jpeg.Options{Quality: 92}); err != nil {
		o.Close()
		return err
	}
	return o.Close()
}

// imagesToPDF: one job, all images in the given order.
func (r *runner) imagesToPDF(ctx context.Context) error {
	dir, err := r.scratch()
	if err != nil {
		return err
	}
	var files []string
	var infos []imgInfo
	for i, in := range r.job.Inputs {
		if err := ctx.Err(); err != nil {
			return err
		}
		ii, err := readImgInfo(in)
		if err != nil {
			return err
		}
		if ii.orient > 1 {
			dst := filepath.Join(dir, fmt.Sprintf("img%04d.jpg", i))
			if err := uprightJPEG(in, dst, ii.orient); err != nil {
				return core.ValidationError(fmt.Sprintf("%s can't be read as an image", filepath.Base(in)), nil).WithCause(err)
			}
			ii.path = dst
			if ii.orient >= 5 {
				ii.w, ii.h = ii.h, ii.w
			}
		}
		infos = append(infos, ii)
		files = append(files, ii.path)
		if fi, err := os.Stat(in); err == nil {
			r.res.BytesBefore += fi.Size()
		}
	}

	imp, err := r.importConfig(infos)
	if err != nil {
		return err
	}
	out := r.outPath(core.StemName(r.job.Inputs[0]), "")
	r.job.Progress(core.IndeterminateProgress, fmt.Sprintf("Building PDF from %d images", len(files)))
	if err := api.ImportImagesFile(ctx, files, out, imp, conf("")); err != nil {
		return r.failed(ctx, err, out)
	}
	if r.opts.PageSize == PageFit {
		if err := fitPages(ctx, out, infos); err != nil {
			return r.failed(ctx, err, out)
		}
	}
	r.res.Pages = len(files)
	r.job.Progress(1, fmt.Sprintf("%d pages", len(files)))
	return r.register(out)
}

// importConfig builds the pdfcpu import settings for the chosen page size.
func (r *runner) importConfig(infos []imgInfo) (*pdfcpu.Import, error) {
	if r.opts.PageSize == PageFit {
		return pdfcpu.ParseImportDetails("pos:full", types.POINTS)
	}
	form := "A4"
	if r.opts.PageSize == PageLetter {
		form = "Letter"
	}
	// Landscape page when every image is landscape (one config covers all pages).
	landscape := len(infos) > 0
	for _, ii := range infos {
		if ii.w <= ii.h {
			landscape = false
		}
	}
	dim := types.PaperSize[strings.ToUpper(form[:1])+strings.ToLower(form[1:])]
	if dim == nil {
		dim = types.PaperSize[form]
	}
	pw, ph := 595.0, 842.0
	if dim != nil {
		pw, ph = dim.Width, dim.Height
	}
	if landscape {
		form += "L"
		pw, ph = ph, pw
	}
	scale := 1.0
	if r.opts.Margin == MarginSmall {
		scale = 1 - 2*marginSmallPts/min(pw, ph)
	}
	return pdfcpu.ParseImportDetails(fmt.Sprintf("f:%s, pos:c, sc:%.4f rel", form, scale), types.POINTS)
}

var contentMatrix = "q %.5f 0 0 %.5f 0 0 cm /%s Do Q"

// fitPages rescales the full-bleed pages written by pdfcpu (1 px = 1 pt) to
// the assumed image resolution so the page size is a sensible physical size.
func fitPages(ctx context.Context, path string, infos []imgInfo) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	xctx, err := api.ReadAndValidate(ctx, f, conf(""))
	_ = f.Close()
	if err != nil {
		return err
	}
	if xctx.PageCount != len(infos) {
		return fmt.Errorf("fit pages: %d pages for %d images", xctx.PageCount, len(infos))
	}
	for pn := 1; pn <= xctx.PageCount; pn++ {
		ii := infos[pn-1]
		s := min(72/fitAssumedDPI, maxPageDim/float64(max(ii.w, ii.h)))
		w, h := float64(ii.w)*s, float64(ii.h)*s
		_, pref, _, err := xctx.PageDict(ctx, pn, false)
		if err != nil || pref == nil {
			return fmt.Errorf("page %d: %w", pn, err)
		}
		pe, ok := xctx.FindTableEntryForIndRef(pref)
		if !ok {
			return fmt.Errorf("page %d: object not found", pn)
		}
		pd, ok := pe.Object.(types.Dict)
		if !ok {
			return fmt.Errorf("page %d: unexpected page object", pn)
		}
		pd["MediaBox"] = types.RectForDim(w, h).Array()
		// Contents: one stream "q W 0 0 H 0 0 cm /Im0 Do Q" written by pdfcpu.
		cref, ok := pd["Contents"].(types.IndirectRef)
		if !ok {
			return fmt.Errorf("page %d: unexpected contents", pn)
		}
		ce, ok := xctx.FindTableEntryForIndRef(&cref)
		if !ok {
			return fmt.Errorf("page %d: contents not found", pn)
		}
		sd, ok := ce.Object.(types.StreamDict)
		if !ok {
			return fmt.Errorf("page %d: unexpected contents object", pn)
		}
		if err := sd.Decode(); err != nil {
			return err
		}
		parts := strings.Fields(string(sd.Content)) // q W 0 0 H 0 0 cm /Im0 Do Q
		if len(parts) < 11 {
			return fmt.Errorf("page %d: unexpected content stream", pn)
		}
		sd.Content = []byte(fmt.Sprintf(contentMatrix, w, h, strings.TrimPrefix(parts[8], "/")))
		sd.Raw = nil
		if err := sd.Encode(); err != nil {
			return err
		}
		ce.Object = sd
	}
	tmp := path + ".fit"
	if err := api.WriteContextFile(ctx, xctx, tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return moveFile(tmp, path)
}

// pdfToImages renders the selected pages with pdfium.
func (r *runner) pdfToImages(ctx context.Context) error {
	in := r.job.Inputs[0]
	info, err := r.open(ctx, in, true)
	if err != nil {
		return err
	}
	pages := make([]int, 0, info.Pages)
	if strings.TrimSpace(r.opts.PageRange) == "" {
		for p := 1; p <= info.Pages; p++ {
			pages = append(pages, p)
		}
	} else {
		rs, err := parseRanges(r.opts.PageRange, info.Pages)
		if err != nil {
			return fieldErr("pageRange", capitalize(err.Error()))
		}
		pages = pagesOf(rs)
	}
	if len(pages) == 0 {
		return fieldErr("pageRange", "No pages selected")
	}
	folder := core.UniquePath(r.job.OutputDir, core.StemName(in)+" (pages)", "")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", folder, err)
	}
	ext := ".png"
	if r.opts.ImageFormat == ImageJPG {
		ext = ".jpg"
	}
	digits := max(3, len(strconv.Itoa(info.Pages)))
	var made []string
	cleanup := func() {
		removePartial(made...)
		_ = os.Remove(folder)
	}
	for i, p := range pages {
		if err := ctx.Err(); err != nil {
			cleanup()
			return err
		}
		path := filepath.Join(folder, fmt.Sprintf("page %0*d%s", digits, p, ext))
		err := r.m.state.r.renderDPI(ctx, in, r.password, p-1, r.opts.DPI, func(img image.Image, _ int) error {
			return writeImage(path, img, r.opts.ImageFormat)
		})
		if err != nil {
			removePartial(path)
			cleanup()
			return mapErr(ctx, err, r.password)
		}
		made = append(made, path)
		r.job.Progress(float64(i+1)/float64(len(pages)), fmt.Sprintf("Page %d of %d", i+1, len(pages)))
	}
	for _, p := range made {
		if err := r.register(p); err != nil {
			return err
		}
	}
	r.res.Folder = folder
	r.res.Pages = len(made)
	if len(r.res.Outputs) > 100 { // keep the stored result small; the folder is enough
		r.res.Outputs = []string{}
	}
	r.job.Progress(1, fmt.Sprintf("%d images", len(made)))
	return nil
}

func writeImage(path string, img image.Image, format string) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	bw := bufio.NewWriter(f)
	if format == ImageJPG {
		err = jpeg.Encode(bw, img, &jpeg.Options{Quality: 90})
	} else {
		err = (&png.Encoder{CompressionLevel: png.DefaultCompression}).Encode(bw, img)
	}
	if err == nil {
		err = bw.Flush()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
