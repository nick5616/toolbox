package chat

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"net/http"
	"os"
	"time"

	_ "image/gif"
	_ "image/png"

	_ "golang.org/x/image/bmp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"

	"toolbox/core"
	"toolbox/core/imaging"
)

// Phase 20 (SPEC.md §5.2): the chat engine sees pictures. A catalog model with
// a projector (--mmproj) reads them through llama-server's OpenAI-style image
// parts; an Ollama model with the "vision" capability gets base64 images.
// Pictures are read, oriented, scaled and encoded here: paths never leave Go.

// Chat implements core.VisionGenerator.
var _ core.VisionGenerator = (*Chat)(nil)

// maxVisionDim is the longest side of a picture sent to the model.
const maxVisionDim = 896

// maxVisionPixels bounds what is decoded (guards against decompression bombs).
const maxVisionPixels = 200_000_000

func errNoVisionPack() error {
	return core.Errorf(core.CodeDependencyMissing, "Install the Caption Writer pack to read pictures").
		WithHint("Open Settings → Tool packs and install Caption Writer")
}

func errCantSee() error {
	return core.Errorf(core.CodeValidation, "This model can't read pictures")
}

// Vision implements core.VisionGenerator. It never starts the server.
func (c *Chat) Vision() (string, error) {
	if m, err := c.pickModel(); err == nil {
		if isOllamaID(m) {
			if c.ollamaCanSee(m) {
				return m, nil
			}
		} else if e, ok := c.lookup(m); ok && c.visionReady(e) {
			return m, nil
		}
	}
	for _, e := range c.entries() {
		if e.VisionDefault && c.visionReady(e) {
			return e.ID, nil
		}
	}
	return "", errNoVisionPack()
}

// canSee reports whether model (catalog or Ollama ID) can read pictures now.
func (c *Chat) canSee(model string) bool {
	if isOllamaID(model) {
		return c.ollamaCanSee(model)
	}
	e, ok := c.lookup(model)
	return ok && c.visionReady(e)
}

// ollamaCanSee asks Ollama's /api/show whether the model reports "vision"
// (a loopback call with a 2 s limit; false on any failure).
func (c *Chat) ollamaCanSee(id string) bool {
	url := c.cfg.Settings.Current().Chat.OllamaURL
	if url == "" {
		return false
	}
	base, err := ollamaBase(url)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"model": ollamaName(id)})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/show", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := loopbackClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var out struct {
		Capabilities []string `json:"capabilities"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false
	}
	for _, capability := range out.Capabilities {
		if capability == "vision" {
			return true
		}
	}
	return false
}

// encodeImage reads path (HEIC via the registered converter), applies EXIF
// orientation, fits the long side to maxVisionDim and returns JPEG q90 bytes.
func encodeImage(ctx context.Context, path string) ([]byte, error) {
	cantRead := core.Errorf(core.CodeValidation, "Couldn't read this picture")
	readable, err := imaging.ToReadable(ctx, path)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(readable)
	if err != nil {
		return nil, cantRead
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || int64(cfg.Width)*int64(cfg.Height) > maxVisionPixels {
		return nil, cantRead
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, cantRead
	}
	src = imaging.Orient(src, imaging.Orientation(readable))
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > maxVisionDim || h > maxVisionDim {
		if w >= h {
			h = max(1, h*maxVisionDim/w)
			w = maxVisionDim
		} else {
			w = max(1, w*maxVisionDim/h)
			h = maxVisionDim
		}
	}
	// Flatten onto white (JPEG has no alpha), scaling in the same step.
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, xdraw.Over, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 90}); err != nil {
		return nil, core.Errorf(core.CodeInternal, "Couldn't prepare the picture").WithCause(err)
	}
	return buf.Bytes(), nil
}

// encodeImages encodes every picture, in order.
func encodeImages(ctx context.Context, paths []string) ([][]byte, error) {
	out := make([][]byte, 0, len(paths))
	for _, p := range paths {
		b, err := encodeImage(ctx, p)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			var ae *core.AppError
			if errors.As(err, &ae) {
				return nil, err
			}
			return nil, core.Errorf(core.CodeValidation, "Couldn't read this picture").WithCause(err)
		}
		out = append(out, b)
	}
	return out, nil
}

// contentPart is one OpenAI-style message part.
type contentPart struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *imageURL `json:"image_url,omitempty"`
}

type imageURL struct {
	URL string `json:"url"`
}

// visionMsg is a user message with pictures.
type visionMsg struct {
	Role    string        `json:"role"`
	Content []contentPart `json:"content"`
}

func imageParts(prompt string, jpegs [][]byte) []contentPart {
	parts := []contentPart{{Type: "text", Text: prompt}}
	for _, j := range jpegs {
		parts = append(parts, contentPart{Type: "image_url",
			ImageURL: &imageURL{URL: "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(j)}})
	}
	return parts
}
