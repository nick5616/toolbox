package paint

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io/fs"
	"os"
	"path/filepath"
	"slices"

	"toolbox/core"
)

// tiles returns data URLs for a layer's tile keys; missing tiles are absent.
func (m *Module) tiles(id, layerID string, keys []string) (map[string]string, error) {
	out := map[string]string{}
	if len(keys) > MaxTilesPerGet {
		return out, core.ValidationError(fmt.Sprintf("Ask for at most %d tiles at a time", MaxTilesPerGet), nil)
	}
	dir, err := m.layerDir(id, layerID)
	if err != nil {
		return out, err
	}
	for _, k := range keys {
		if _, _, ok := parseKey(k); !ok {
			return map[string]string{}, core.ValidationError("That tile key isn't valid", nil)
		}
		b, err := os.ReadFile(filepath.Join(dir, k+".png"))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return map[string]string{}, fmt.Errorf("read tile %s: %w", k, err)
		}
		out[k] = pngDataURL(b)
	}
	return out, nil
}

// saveTiles writes dirty tiles atomically and removes the keys in removed.
// Everything is validated before anything is written.
func (m *Module) saveTiles(id, layerID string, tiles map[string]string, removed []string) error {
	dir, err := m.layerDir(id, layerID)
	if err != nil {
		return err
	}
	doc, err := m.load(context.Background(), id)
	if err != nil {
		return err
	}
	nx, ny := gridSize(doc.Width, doc.Height)
	inGrid := func(key string) bool {
		tx, ty, ok := parseKey(key)
		return ok && tx < nx && ty < ny
	}
	data := make(map[string][]byte, len(tiles))
	for key, url := range tiles {
		if !inGrid(key) {
			return core.ValidationError("That tile is outside the canvas", map[string]string{"tile": key})
		}
		b, err := decodeDataURL(url, "png", MaxTileBytes)
		if err != nil {
			return err
		}
		cfg, err := png.DecodeConfig(bytes.NewReader(b))
		if err != nil {
			return core.ValidationError("A tile isn't a valid PNG", map[string]string{"tile": key}).WithCause(err)
		}
		tx, ty, _ := parseKey(key)
		want := tileRect(tx, ty, doc.Width, doc.Height)
		full := cfg.Width == TileSize && cfg.Height == TileSize
		if !full && !(cfg.Width == want.Dx() && cfg.Height == want.Dy()) {
			return core.ValidationError("A tile has the wrong size", map[string]string{"tile": key})
		}
		if _, err := png.Decode(bytes.NewReader(b)); err != nil {
			return core.ValidationError("A tile isn't a valid PNG", map[string]string{"tile": key}).WithCause(err)
		}
		data[key] = b
	}
	for _, key := range removed {
		if !inGrid(key) {
			return core.ValidationError("That tile is outside the canvas", map[string]string{"tile": key})
		}
	}
	for key, b := range data {
		if err := writeAtomic(filepath.Join(dir, key+".png"), b); err != nil {
			return err
		}
	}
	for _, key := range removed {
		if _, dup := data[key]; dup {
			continue
		}
		if err := os.Remove(filepath.Join(dir, key+".png")); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("remove tile %s: %w", key, err)
		}
	}
	return nil
}

// loadTile reads one tile as NRGBA, or nil if it isn't stored.
func loadTile(dir, key string) (*image.NRGBA, error) {
	b, err := os.ReadFile(filepath.Join(dir, key+".png"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read tile %s: %w", key, err)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("decode tile %s: %w", key, err)
	}
	return toNRGBA(img), nil
}

// writeImageTiles slices img (placed at off on a w×h canvas) into the layer's
// tile files and returns the keys written. Fully transparent tiles are not
// stored.
func writeImageTiles(dir string, img image.Image, off image.Point, w, h int) ([]string, error) {
	keys := []string{}
	nx, ny := gridSize(w, h)
	placed := img.Bounds().Add(off.Sub(img.Bounds().Min))
	for ty := 0; ty < ny; ty++ {
		for tx := 0; tx < nx; tx++ {
			r := tileRect(tx, ty, w, h)
			if !r.Overlaps(placed) {
				continue
			}
			tile := image.NewNRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
			// src point: the pixel of img that lands at r.Min.
			sp := img.Bounds().Min.Add(r.Min.Sub(off))
			draw.Draw(tile, tile.Bounds(), img, sp, draw.Src)
			if transparent(tile) {
				continue
			}
			b, err := encodePNG(tile)
			if err != nil {
				return nil, err
			}
			k := tileKey(tx, ty)
			if err := writeAtomic(filepath.Join(dir, k+".png"), b); err != nil {
				return nil, err
			}
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	return keys, nil
}

func transparent(img *image.NRGBA) bool {
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] != 0 {
			return false
		}
	}
	return true
}

// saveThumb stores thumb.jpg and render.png.
func (m *Module) saveThumb(id, jpegDataURL, renderPNGDataURL string) error {
	if _, err := m.docs.Load(context.Background(), id); err != nil {
		return err
	}
	dir, err := m.projectDir(id)
	if err != nil {
		return err
	}
	var thumb, render []byte
	if jpegDataURL != "" {
		b, err := decodeDataURL(jpegDataURL, "jpeg", 4<<20)
		if err != nil {
			return err
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
		if err != nil {
			return core.ValidationError("The thumbnail isn't a valid JPEG", nil).WithCause(err)
		}
		if max(cfg.Width, cfg.Height) > 512 {
			return core.ValidationError("The thumbnail is larger than 512 px", nil)
		}
		thumb = b
	}
	if renderPNGDataURL != "" {
		b, err := decodeDataURL(renderPNGDataURL, "png", MaxRenderBytes*4/3+64)
		if err != nil {
			return err
		}
		if len(b) > MaxRenderBytes {
			return core.ValidationError("The render is too large", nil)
		}
		cfg, err := png.DecodeConfig(bytes.NewReader(b))
		if err != nil {
			return core.ValidationError("The render isn't a valid PNG", nil).WithCause(err)
		}
		if max(cfg.Width, cfg.Height) > 4096 {
			return core.ValidationError("The render is larger than 4096 px", nil)
		}
		render = b
	}
	if thumb != nil {
		if err := writeAtomic(m.docs.ThumbPath(id), thumb); err != nil {
			return err
		}
	}
	if render != nil {
		if err := writeAtomic(filepath.Join(dir, "render.png"), render); err != nil {
			return err
		}
	}
	return nil
}
