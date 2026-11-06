package paint

// PaintDoc is a Paint+ project document (SPEC.md §2.2). Pixels are not in
// the document: each layer is a grid of TileSize RGBA PNG tiles under
// <support>/projects/<id>/layers/<layerID>/<tx>_<ty>.png (absent = transparent).
type PaintDoc struct {
	Version    int          `json:"version"`    // 1
	Width      int          `json:"width"`      // ≤ MaxSide
	Height     int          `json:"height"`     // ≤ MaxSide, Width*Height ≤ MaxPixels
	Background string       `json:"background"` // "#rrggbb" | "transparent"
	Layers     []PaintLayer `json:"layers"`     // bottom → top, ≤ MaxLayers
	Active     string       `json:"active"`     // layer ID
	Palette    []string     `json:"palette"`    // ≤ MaxPalette "#rrggbb"
	Guides     string       `json:"guides"`     // JSON owned by the frontend (paint/guides schema); "" = none
	TileSize   int          `json:"tileSize"`   // TileSize
	Source     string       `json:"source"`     // the file it was opened from ("" = blank); never written
}

// PaintLayer is one layer.
type PaintLayer struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Hidden    bool     `json:"hidden"`
	Locked    bool     `json:"locked"`
	AlphaLock bool     `json:"alphaLock"`
	Clip      bool     `json:"clip"`      // clipping mask onto the layer below
	Reference bool     `json:"reference"` // fill tools see this layer's lines
	Opacity   float64  `json:"opacity"`   // 0..1
	Blend     string   `json:"blend"`     // one of Blends
	Tiles     []string `json:"tiles"`     // "tx_ty" keys present on disk
	Rev       int      `json:"rev"`       // bumps on every pixel save (cache key)
}

// Blends are the layer blend modes (SPEC.md §1.1).
var Blends = []string{
	"normal", "multiply", "screen", "overlay", "add", "darken", "lighten",
	"color-dodge", "color-burn", "soft-light", "hard-light", "difference",
	"hue", "saturation", "color", "luminosity",
}

// GoBlends are the modes the Go compositor flattens itself; for any other
// visible mode an export carries a frontend-flattened render
// (ExportOptions.Flattened).
var GoBlends = []string{"normal", "multiply", "screen", "overlay", "add", "darken", "lighten"}
