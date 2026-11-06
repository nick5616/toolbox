package paint

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"toolbox/core"
)

var (
	projectIDRe = regexp.MustCompile(`^[A-Za-z0-9]{1,40}$`)
	layerIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	tileKeyRe   = regexp.MustCompile(`^(\d{1,3})_(\d{1,3})$`)
	hexColorRe  = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// layersDir is <projects>/<id>/layers; the ID is checked first so a crafted
// ID can never leave the projects folder.
func (m *Module) layersDir(id string) (string, error) {
	if !projectIDRe.MatchString(id) {
		return "", core.Errorf(core.CodeNotFound, "Project not found")
	}
	return filepath.Join(m.cfg.ProjectsDir, id, "layers"), nil
}

func (m *Module) layerDir(id, layerID string) (string, error) {
	base, err := m.layersDir(id)
	if err != nil {
		return "", err
	}
	if !layerIDRe.MatchString(layerID) {
		return "", core.ValidationError("That layer ID isn't valid", nil)
	}
	return filepath.Join(base, layerID), nil
}

func (m *Module) projectDir(id string) (string, error) {
	if !projectIDRe.MatchString(id) {
		return "", core.Errorf(core.CodeNotFound, "Project not found")
	}
	return filepath.Join(m.cfg.ProjectsDir, id), nil
}

// parseKey returns a tile key's grid position.
func parseKey(key string) (tx, ty int, ok bool) {
	g := tileKeyRe.FindStringSubmatch(key)
	if g == nil {
		return 0, 0, false
	}
	tx, _ = strconv.Atoi(g[1])
	ty, _ = strconv.Atoi(g[2])
	return tx, ty, true
}

func tileKey(tx, ty int) string { return fmt.Sprintf("%d_%d", tx, ty) }

func gridSize(w, h int) (nx, ny int) {
	return (w + TileSize - 1) / TileSize, (h + TileSize - 1) / TileSize
}

// tileRect is a tile's pixel rectangle on the canvas (edge tiles are cropped).
func tileRect(tx, ty, w, h int) image.Rectangle {
	return image.Rect(tx*TileSize, ty*TileSize, min(w, (tx+1)*TileSize), min(h, (ty+1)*TileSize))
}

// newLayerID makes a safe layer ID.
func newLayerID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return "l" + hex.EncodeToString(b[:])
}

// writeAtomic writes data to path through a temp file in the same folder, so
// a crash never leaves a half-written file.
func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmp := f.Name()
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmp)
		if werr != nil {
			return fmt.Errorf("write %s: %w", path, werr)
		}
		return fmt.Errorf("write %s: %w", path, cerr)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}

// decodeDataURL returns the bytes of a base64 data URL of the given media
// type ("png" or "jpeg"); maxLen bounds the encoded length.
func decodeDataURL(url, kind string, maxLen int) ([]byte, error) {
	prefix := "data:image/" + kind + ";base64,"
	if !strings.HasPrefix(url, prefix) {
		return nil, core.ValidationError("That isn't a "+strings.ToUpper(kind)+" picture", nil)
	}
	if len(url) > maxLen {
		return nil, core.ValidationError("That picture is too large", nil)
	}
	b, err := base64.StdEncoding.DecodeString(url[len(prefix):])
	if err != nil {
		return nil, core.ValidationError("That picture isn't valid", nil).WithCause(err)
	}
	return b, nil
}

func encodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

func pngDataURL(b []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(b)
}

// toNRGBA converts any image to a zero-origin NRGBA.
func toNRGBA(img image.Image) *image.NRGBA {
	b := img.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(out, out.Bounds(), img, b.Min, draw.Src)
	return out
}

func copyDir(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		s, d := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := copyDir(s, d); err != nil {
				return err
			}
			continue
		}
		if !e.Type().IsRegular() || strings.HasPrefix(e.Name(), ".tmp-") {
			continue
		}
		b, err := os.ReadFile(s)
		if err != nil {
			return err
		}
		if err := os.WriteFile(d, b, 0o644); err != nil {
			return err
		}
	}
	return nil
}
