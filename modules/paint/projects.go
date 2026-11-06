package paint

import (
	"context"
	"fmt"
	"image"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"golang.org/x/image/draw"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"toolbox/core"
	"toolbox/core/imaging"
	"toolbox/core/projectdocs"
)

const docVersion = 1

// checkSize validates a canvas size.
func checkSize(w, h int) error {
	if w < 1 || h < 1 {
		return core.ValidationError("The canvas must be at least 1 × 1 px", map[string]string{"size": "Too small"})
	}
	if w > MaxSide || h > MaxSide {
		return core.ValidationError(fmt.Sprintf("The canvas can be at most %d px on a side", MaxSide), map[string]string{"size": "Too large"})
	}
	if w*h > MaxPixels {
		return core.ValidationError(fmt.Sprintf("The canvas can be at most %d megapixels", MaxPixels/1_000_000), map[string]string{"size": "Too many pixels"})
	}
	return nil
}

func checkBackground(bg string) error {
	if bg == "transparent" || hexColorRe.MatchString(bg) {
		return nil
	}
	return core.ValidationError("Choose a background colour or transparent", map[string]string{"background": "Not a colour"})
}

func newDoc(w, h int, bg string) PaintDoc {
	id := newLayerID()
	return PaintDoc{
		Version: docVersion, Width: w, Height: h, Background: bg,
		Layers:  []PaintLayer{{ID: id, Name: "Layer 1", Opacity: 1, Blend: "normal", Tiles: []string{}}},
		Active:  id,
		Palette: []string{}, TileSize: TileSize,
	}
}

// create makes a blank canvas.
func (m *Module) create(ctx context.Context, name string, w, h int, background string) (string, error) {
	if err := checkSize(w, h); err != nil {
		return "", err
	}
	if err := checkBackground(background); err != nil {
		return "", err
	}
	info, err := m.docs.Create(ctx, name, newDoc(w, h, background))
	if err != nil {
		return "", err
	}
	return info.ID, nil
}

// readImage decodes a picture: HEIC through the engine, EXIF orientation applied.
func readImage(ctx context.Context, path string) (*image.NRGBA, error) {
	readable, err := imaging.ToReadable(ctx, path)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(readable)
	if err != nil {
		return nil, core.Errorf(core.CodeNotFound, "%s can't be opened", filepath.Base(path)).WithCause(err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, core.Errorf(core.CodeValidation, "%s isn't a picture Paint+ can read", filepath.Base(path)).WithCause(err)
	}
	if !imaging.IsHEIC(path) {
		img = imaging.Orient(img, imaging.Orientation(readable))
	}
	return toNRGBA(img), nil
}

// fitSize is the largest size ≤ the limits with the same aspect ratio.
func fitSize(w, h int) (int, int) {
	f := math.Min(float64(MaxSide)/float64(max(w, h)), math.Sqrt(float64(MaxPixels)/(float64(w)*float64(h))))
	if f >= 1 {
		return w, h
	}
	nw, nh := max(1, int(float64(w)*f)), max(1, int(float64(h)*f))
	for nw*nh > MaxPixels || max(nw, nh) > MaxSide {
		nw, nh = max(1, nw-1), max(1, nh-1)
	}
	return nw, nh
}

func resize(src *image.NRGBA, w, h int) *image.NRGBA {
	if src.Bounds().Dx() == w && src.Bounds().Dy() == h {
		return src
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return dst
}

func stemOf(path string) string {
	b := filepath.Base(path)
	return strings.TrimSuffix(b, filepath.Ext(b))
}

// createFromImage makes a project whose "Layer 1" is the picture.
func (m *Module) createFromImage(ctx context.Context, path, name string, fit bool) (string, error) {
	img, err := readImage(ctx, path)
	if err != nil {
		return "", err
	}
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	if checkSize(w, h) != nil {
		if !fit {
			return "", core.ValidationError(fmt.Sprintf("This picture is %d × %d px, larger than Paint+ allows (%d px a side, %d megapixels)", w, h, MaxSide, MaxPixels/1_000_000),
				map[string]string{"size": "Too large"}).WithHint("Choose to scale it down to fit")
		}
		w, h = fitSize(w, h)
		img = resize(img, w, h)
	}
	doc := newDoc(w, h, "transparent")
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	doc.Source = abs
	if name == "" {
		name = stemOf(path)
	}
	info, err := m.docs.Create(ctx, name, doc)
	if err != nil {
		return "", err
	}
	fail := func(err error) (string, error) {
		_ = m.docs.Delete(ctx, info.ID)
		return "", err
	}
	dir, err := m.layerDir(info.ID, doc.Layers[0].ID)
	if err != nil {
		return fail(err)
	}
	keys, err := writeImageTiles(dir, img, image.Point{}, w, h)
	if err != nil {
		return fail(err)
	}
	doc.Layers[0].Tiles, doc.Layers[0].Rev = keys, 1
	if _, err := m.docs.Save(ctx, info.ID, info.Name, doc); err != nil {
		return fail(err)
	}
	return info.ID, nil
}

// load returns a project's document, with non-nil slices.
func (m *Module) load(ctx context.Context, id string) (PaintDoc, error) {
	doc, err := projectdocs.Get[PaintDoc](ctx, m.docs, id)
	if err != nil {
		return doc, err
	}
	if doc.Layers == nil {
		doc.Layers = []PaintLayer{}
	}
	for i := range doc.Layers {
		if doc.Layers[i].Tiles == nil {
			doc.Layers[i].Tiles = []string{}
		}
	}
	if doc.Palette == nil {
		doc.Palette = []string{}
	}
	return doc, nil
}

// validateDoc checks a document and returns a normalised copy.
func validateDoc(doc PaintDoc) (PaintDoc, error) {
	bad := func(msg, field string) (PaintDoc, error) {
		return doc, core.ValidationError(msg, map[string]string{field: msg})
	}
	if doc.Version != docVersion {
		return bad("Unknown project version", "version")
	}
	if err := checkSize(doc.Width, doc.Height); err != nil {
		return doc, err
	}
	if err := checkBackground(doc.Background); err != nil {
		return doc, err
	}
	if doc.TileSize != TileSize {
		return bad("Unsupported tile size", "tileSize")
	}
	if len(doc.Layers) < 1 {
		return bad("A painting needs at least one layer", "layers")
	}
	if len(doc.Layers) > MaxLayers {
		return bad(fmt.Sprintf("A painting can have at most %d layers", MaxLayers), "layers")
	}
	if len(doc.Palette) > MaxPalette {
		return bad(fmt.Sprintf("The palette can have at most %d colours", MaxPalette), "palette")
	}
	for _, c := range doc.Palette {
		if !hexColorRe.MatchString(c) {
			return bad("A palette colour isn't valid", "palette")
		}
	}
	nx, ny := gridSize(doc.Width, doc.Height)
	seen := map[string]bool{}
	layers := slices.Clone(doc.Layers)
	for i := range layers {
		l := &layers[i]
		if !layerIDRe.MatchString(l.ID) || seen[l.ID] {
			return bad("A layer has an invalid or repeated ID", "layers")
		}
		seen[l.ID] = true
		if !slices.Contains(Blends, l.Blend) {
			return bad("A layer has an unknown blend mode", "blend")
		}
		if !(l.Opacity >= 0 && l.Opacity <= 1) {
			return bad("Layer opacity must be 0 to 100%", "opacity")
		}
		l.Name = strings.TrimSpace(l.Name)
		if l.Name == "" {
			l.Name = fmt.Sprintf("Layer %d", i+1)
		}
		if r := []rune(l.Name); len(r) > 80 {
			l.Name = string(r[:80])
		}
		if l.Tiles == nil {
			l.Tiles = []string{}
		}
		for _, k := range l.Tiles {
			if tx, ty, ok := parseKey(k); !ok || tx >= nx || ty >= ny {
				return bad("A layer lists a tile outside the canvas", "tiles")
			}
		}
	}
	doc.Layers = layers
	if !seen[doc.Active] {
		return bad("The active layer doesn't exist", "active")
	}
	if doc.Palette == nil {
		doc.Palette = []string{}
	}
	return doc, nil
}

// saveDoc validates and saves the document. Source is kept as stored (a
// client can't change where a project came from) and the tile folders of
// removed layers are deleted.
func (m *Module) saveDoc(ctx context.Context, id, name string, doc PaintDoc) error {
	old, err := m.load(ctx, id)
	if err != nil {
		return err
	}
	doc, err = validateDoc(doc)
	if err != nil {
		return err
	}
	doc.Source = old.Source
	if _, err := m.docs.Save(ctx, id, name, doc); err != nil {
		return err
	}
	base, err := m.layersDir(id)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil // no tiles yet
	}
	keep := map[string]bool{}
	for _, l := range doc.Layers {
		keep[l.ID] = true
	}
	for _, e := range entries {
		if e.IsDir() && !keep[e.Name()] && layerIDRe.MatchString(e.Name()) {
			if err := os.RemoveAll(filepath.Join(base, e.Name())); err != nil {
				return fmt.Errorf("remove layer tiles: %w", err)
			}
		}
	}
	return nil
}

func (m *Module) rename(ctx context.Context, id, name string) error {
	doc, err := m.load(ctx, id)
	if err != nil {
		return err
	}
	_, err = m.docs.Save(ctx, id, name, doc)
	return err
}

// duplicate copies a project, document and tiles.
func (m *Module) duplicate(ctx context.Context, id string) (string, error) {
	info, err := m.docs.Duplicate(ctx, id)
	if err != nil {
		return "", err
	}
	src, err := m.layersDir(id)
	if err != nil {
		return "", err
	}
	dst, err := m.layersDir(info.ID)
	if err != nil {
		return "", err
	}
	if err := copyDir(src, dst); err != nil {
		_ = m.docs.Delete(ctx, info.ID)
		return "", fmt.Errorf("copy tiles: %w", err)
	}
	return info.ID, nil
}

// importLayer turns a picture into a new layer's tiles, scaled down (never
// up) to fit the canvas and centred. The document isn't changed.
func (m *Module) importLayer(ctx context.Context, id, path string) (PaintLayer, error) {
	doc, err := m.load(ctx, id)
	if err != nil {
		return PaintLayer{}, err
	}
	if len(doc.Layers) >= MaxLayers {
		return PaintLayer{}, core.ValidationError(fmt.Sprintf("A painting can have at most %d layers", MaxLayers), nil)
	}
	img, err := readImage(ctx, path)
	if err != nil {
		return PaintLayer{}, err
	}
	iw, ih := img.Bounds().Dx(), img.Bounds().Dy()
	if iw > doc.Width || ih > doc.Height {
		f := math.Min(float64(doc.Width)/float64(iw), float64(doc.Height)/float64(ih))
		iw, ih = max(1, int(float64(iw)*f)), max(1, int(float64(ih)*f))
		img = resize(img, iw, ih)
	}
	layer := PaintLayer{ID: newLayerID(), Name: stemOf(path), Opacity: 1, Blend: "normal", Tiles: []string{}, Rev: 1}
	dir, err := m.layerDir(id, layer.ID)
	if err != nil {
		return PaintLayer{}, err
	}
	keys, err := writeImageTiles(dir, img, image.Pt((doc.Width-iw)/2, (doc.Height-ih)/2), doc.Width, doc.Height)
	if err != nil {
		_ = os.RemoveAll(dir)
		return PaintLayer{}, err
	}
	layer.Tiles = keys
	return layer, nil
}
