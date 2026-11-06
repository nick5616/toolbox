package paint

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"hash/crc32"
	"image"
	"image/png"
	"io"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/image/draw"

	"toolbox/core"
)

// OpenRaster (https://www.openraster.org): a zip with an uncompressed
// "mimetype" first, stack.xml (top layer first), data/<layer>.png,
// mergedimage.png and Thumbnails/thumbnail.png.

const (
	oraMime       = "image/openraster"
	maxOraEntry   = 256 << 20
	maxOraEntries = 1024
)

// oraOps maps our blend names to OpenRaster composite-op names.
var oraOps = map[string]string{
	"normal": "svg:src-over", "multiply": "svg:multiply", "screen": "svg:screen",
	"overlay": "svg:overlay", "add": "svg:plus", "darken": "svg:darken", "lighten": "svg:lighten",
	"color-dodge": "svg:color-dodge", "color-burn": "svg:color-burn", "soft-light": "svg:soft-light",
	"hard-light": "svg:hard-light", "difference": "svg:difference", "hue": "svg:hue",
	"saturation": "svg:saturation", "color": "svg:color", "luminosity": "svg:luminosity",
}

func oraBlend(op string) string {
	for k, v := range oraOps {
		if v == op {
			return k
		}
	}
	return "normal"
}

type oraLayerOut struct {
	layer PaintLayer
	get   func() (*image.NRGBA, error) // full-canvas pixels (already scaled), read when written
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// writeORA writes an OpenRaster file. layers are bottom → top.
func writeORA(w io.Writer, width, height int, layers []oraLayerOut, merged *image.NRGBA) error {
	zw := zip.NewWriter(w)
	mt := []byte(oraMime)
	fh := &zip.FileHeader{Name: "mimetype", Method: zip.Store, CRC32: crc32.ChecksumIEEE(mt),
		CompressedSize64: uint64(len(mt)), UncompressedSize64: uint64(len(mt))}
	fw, err := zw.CreateRaw(fh)
	if err != nil {
		return fmt.Errorf("write ora: %w", err)
	}
	if _, err := fw.Write(mt); err != nil {
		return fmt.Errorf("write ora: %w", err)
	}
	var stack strings.Builder
	stack.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	fmt.Fprintf(&stack, `<image version="0.0.3" w="%d" h="%d"><stack>`+"\n", width, height)
	for i := len(layers) - 1; i >= 0; i-- { // top first
		l := layers[i].layer
		vis := "visible"
		if l.Hidden {
			vis = "hidden"
		}
		clip := ""
		if l.Clip {
			clip = ` paintplus-clip="true"`
		}
		fmt.Fprintf(&stack, `<layer name="%s" src="data/%s.png" x="0" y="0" opacity="%s" visibility="%s" composite-op="%s"%s/>`+"\n",
			xmlEscape(l.Name), l.ID, strconv.FormatFloat(l.Opacity, 'f', -1, 64), vis, oraOps[l.Blend], clip)
	}
	stack.WriteString("</stack></image>\n")
	add := func(name string, b []byte) error {
		f, err := zw.Create(name)
		if err != nil {
			return fmt.Errorf("write ora: %w", err)
		}
		_, err = f.Write(b)
		return err
	}
	if err := add("stack.xml", []byte(stack.String())); err != nil {
		return err
	}
	for _, l := range layers {
		img, err := l.get()
		if err != nil {
			return err
		}
		b, err := encodePNG(img)
		if err != nil {
			return err
		}
		if err := add("data/"+l.layer.ID+".png", b); err != nil {
			return err
		}
	}
	b, err := encodePNG(merged)
	if err != nil {
		return err
	}
	if err := add("mergedimage.png", b); err != nil {
		return err
	}
	tw, th := width, height
	if f := 256.0 / float64(max(width, height)); f < 1 {
		tw, th = max(1, int(float64(width)*f)), max(1, int(float64(height)*f))
	}
	thumb := image.NewNRGBA(image.Rect(0, 0, tw, th))
	draw.ApproxBiLinear.Scale(thumb, thumb.Bounds(), merged, merged.Bounds(), draw.Src, nil)
	if b, err = encodePNG(thumb); err != nil {
		return err
	}
	if err := add("Thumbnails/thumbnail.png", b); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("write ora: %w", err)
	}
	return nil
}

type oraNode struct {
	XMLName  xml.Name
	Attrs    []xml.Attr `xml:",any,attr"`
	Children []oraNode  `xml:",any"`
}

func (n oraNode) attr(name string) string {
	for _, a := range n.Attrs {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

// oraLayerIn is one layer read from stack.xml.
type oraLayerIn struct {
	Name    string
	Src     string
	X, Y    int
	Opacity float64
	Hidden  bool
	Blend   string
	Clip    bool
}

// oraImage is a parsed OpenRaster file; layer pixels are read on demand.
type oraImage struct {
	W, H   int
	Layers []oraLayerIn // bottom → top
	zr     *zip.ReadCloser
	files  map[string]*zip.File
}

func (o *oraImage) Close() { _ = o.zr.Close() }

func openORA(p string) (*oraImage, error) {
	bad := func(msg string, err error) (*oraImage, error) {
		e := core.Errorf(core.CodeValidation, "%s", msg)
		if err != nil {
			e = e.WithCause(err)
		}
		return nil, e
	}
	zr, err := zip.OpenReader(p)
	if err != nil {
		return bad(filepath.Base(p)+" isn't an OpenRaster file", err)
	}
	if len(zr.File) > maxOraEntries {
		_ = zr.Close()
		return bad("This OpenRaster file has too many entries", nil)
	}
	o := &oraImage{zr: zr, files: map[string]*zip.File{}}
	for _, f := range zr.File {
		o.files[path.Clean(f.Name)] = f
	}
	sf := o.files["stack.xml"]
	if sf == nil || sf.UncompressedSize64 > 4<<20 {
		o.Close()
		return bad("This OpenRaster file has no layer list", nil)
	}
	rc, err := sf.Open()
	if err != nil {
		o.Close()
		return bad("This OpenRaster file can't be read", err)
	}
	var root oraNode
	err = xml.NewDecoder(io.LimitReader(rc, 4<<20)).Decode(&root)
	_ = rc.Close()
	if err != nil || root.XMLName.Local != "image" {
		o.Close()
		return bad("This OpenRaster file's layer list is damaged", err)
	}
	o.W, _ = strconv.Atoi(root.attr("w"))
	o.H, _ = strconv.Atoi(root.attr("h"))
	var walk func(n oraNode)
	walk = func(n oraNode) {
		for _, c := range n.Children {
			switch c.XMLName.Local {
			case "stack":
				walk(c)
			case "layer":
				l := oraLayerIn{Name: strings.TrimSpace(c.attr("name")), Src: c.attr("src"), Opacity: 1,
					Hidden: c.attr("visibility") == "hidden", Blend: oraBlend(c.attr("composite-op")),
					Clip: c.attr("paintplus-clip") == "true"}
				l.X, _ = strconv.Atoi(c.attr("x"))
				l.Y, _ = strconv.Atoi(c.attr("y"))
				if v, err := strconv.ParseFloat(c.attr("opacity"), 64); err == nil && v >= 0 && v <= 1 {
					l.Opacity = v
				}
				o.Layers = append([]oraLayerIn{l}, o.Layers...) // file order is top first
			}
		}
	}
	walk(root)
	if o.W == 0 || o.H == 0 {
		// Some writers omit w/h on the root: fall back to the merged image.
		if f := o.files["mergedimage.png"]; f != nil {
			if rc, err := f.Open(); err == nil {
				cfg, _ := png.DecodeConfig(rc)
				_ = rc.Close()
				o.W, o.H = cfg.Width, cfg.Height
			}
		}
	}
	if err := checkSize(o.W, o.H); err != nil {
		o.Close()
		return nil, err
	}
	if len(o.Layers) == 0 {
		o.Close()
		return bad("This OpenRaster file has no layers", nil)
	}
	if len(o.Layers) > MaxLayers {
		o.Close()
		return bad(fmt.Sprintf("This OpenRaster file has %d layers; Paint+ keeps at most %d", len(o.Layers), MaxLayers), nil)
	}
	return o, nil
}

// layerPixels decodes layer i (placed at its offset on a W×H canvas is the
// caller's job: the image and its offset are returned).
func (o *oraImage) layerPixels(i int) (*image.NRGBA, error) {
	l := o.Layers[i]
	name := path.Clean(l.Src)
	if strings.HasPrefix(name, "..") || path.IsAbs(name) {
		return nil, core.Errorf(core.CodeValidation, "A layer in this OpenRaster file has an unsafe path")
	}
	f := o.files[name]
	if f == nil || f.UncompressedSize64 > maxOraEntry {
		return nil, core.Errorf(core.CodeValidation, "A layer's picture is missing from this OpenRaster file")
	}
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("open ora layer: %w", err)
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, maxOraEntry+1))
	if err != nil || len(b) > maxOraEntry {
		return nil, core.Errorf(core.CodeValidation, "A layer's picture can't be read")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width > MaxSide || cfg.Height > MaxSide || cfg.Width*cfg.Height > MaxPixels {
		return nil, core.Errorf(core.CodeValidation, "A layer's picture isn't a PNG Paint+ can read")
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, core.Errorf(core.CodeValidation, "A layer's picture isn't a valid PNG").WithCause(err)
	}
	return toNRGBA(img), nil
}

// importORA makes a project from an OpenRaster file.
func (m *Module) importORA(ctx context.Context, p string) (string, error) {
	o, err := openORA(p)
	if err != nil {
		return "", err
	}
	defer o.Close()
	doc := PaintDoc{Version: docVersion, Width: o.W, Height: o.H, Background: "transparent",
		Layers: []PaintLayer{}, Palette: []string{}, TileSize: TileSize}
	if abs, err := filepath.Abs(p); err == nil {
		doc.Source = abs
	} else {
		doc.Source = p
	}
	for _, l := range o.Layers {
		name := l.Name
		if name == "" {
			name = fmt.Sprintf("Layer %d", len(doc.Layers)+1)
		}
		doc.Layers = append(doc.Layers, PaintLayer{ID: newLayerID(), Name: name, Hidden: l.Hidden, Clip: l.Clip,
			Opacity: l.Opacity, Blend: l.Blend, Tiles: []string{}, Rev: 1})
	}
	doc.Active = doc.Layers[len(doc.Layers)-1].ID
	info, err := m.docs.Create(ctx, stemOf(p), doc)
	if err != nil {
		return "", err
	}
	fail := func(err error) (string, error) {
		_ = m.docs.Delete(ctx, info.ID)
		return "", err
	}
	for i := range doc.Layers {
		if err := ctx.Err(); err != nil {
			return fail(fmt.Errorf("import cancelled: %w", err))
		}
		img, err := o.layerPixels(i)
		if err != nil {
			return fail(err)
		}
		dir, err := m.layerDir(info.ID, doc.Layers[i].ID)
		if err != nil {
			return fail(err)
		}
		keys, err := writeImageTiles(dir, img, image.Pt(o.Layers[i].X, o.Layers[i].Y), o.W, o.H)
		if err != nil {
			return fail(err)
		}
		doc.Layers[i].Tiles = keys
	}
	if _, err := m.docs.Save(ctx, info.ID, info.Name, doc); err != nil {
		return fail(err)
	}
	return info.ID, nil
}
