//go:build windows

package focus

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"unsafe"

	"golang.org/x/image/draw"
	"golang.org/x/sys/windows"
)

var (
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	user32   = windows.NewLazySystemDLL("user32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	pSHInfo  = shell32.NewProc("SHGetFileInfoW")
	pIconInf = user32.NewProc("GetIconInfo")
	pDestroy = user32.NewProc("DestroyIcon")
	pGetDC   = user32.NewProc("GetDC")
	pRelDC   = user32.NewProc("ReleaseDC")
	pGetObj  = gdi32.NewProc("GetObjectW")
	pDIBits  = gdi32.NewProc("GetDIBits")
	pDelObj  = gdi32.NewProc("DeleteObject")
)

const (
	shgfiIcon      = 0x100
	shgfiLargeIcon = 0x0
)

type shFileInfo struct {
	HIcon       uintptr
	IIcon       int32
	Attributes  uint32
	DisplayName [260]uint16
	TypeName    [80]uint16
}

type iconInfo struct {
	FIcon    int32
	XHotspot uint32
	YHotspot uint32
	HbmMask  uintptr
	HbmColor uintptr
}

type bitmap struct {
	Type       int32
	Width      int32
	Height     int32
	WidthBytes int32
	Planes     uint16
	BitsPixel  uint16
	Bits       uintptr
}

type bitmapInfo struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
	Colors        [1]uint32
}

// renderIcon draws the program's large shell icon into a 32 px PNG.
func renderIcon(path string) ([]byte, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	var fi shFileInfo
	r, _, _ := pSHInfo.Call(uintptr(unsafe.Pointer(p)), 0, uintptr(unsafe.Pointer(&fi)),
		unsafe.Sizeof(fi), shgfiIcon|shgfiLargeIcon)
	if r == 0 || fi.HIcon == 0 {
		return nil, errors.New("no icon")
	}
	defer pDestroy.Call(fi.HIcon)

	var ii iconInfo
	if r, _, _ := pIconInf.Call(fi.HIcon, uintptr(unsafe.Pointer(&ii))); r == 0 {
		return nil, errors.New("GetIconInfo failed")
	}
	if ii.HbmColor != 0 {
		defer pDelObj.Call(ii.HbmColor)
	}
	if ii.HbmMask != 0 {
		defer pDelObj.Call(ii.HbmMask)
	}
	if ii.HbmColor == 0 {
		return nil, errors.New("monochrome icon")
	}

	hdc, _, _ := pGetDC.Call(0)
	if hdc == 0 {
		return nil, errors.New("GetDC failed")
	}
	defer pRelDC.Call(0, hdc)

	w, h, pix, err := dibits(hdc, ii.HbmColor)
	if err != nil {
		return nil, err
	}
	opaque := false
	for i := 3; i < len(pix); i += 4 {
		if pix[i] != 0 {
			opaque = true
			break
		}
	}
	var mask []byte
	if !opaque && ii.HbmMask != 0 {
		if mw, mh, m, err := dibits(hdc, ii.HbmMask); err == nil && mw == w && mh == h {
			mask = m
		}
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		b, g, rr, a := pix[4*i], pix[4*i+1], pix[4*i+2], pix[4*i+3]
		if !opaque {
			a = 255
			if mask != nil && mask[4*i] != 0 {
				a = 0
			}
		}
		img.Pix[4*i], img.Pix[4*i+1], img.Pix[4*i+2], img.Pix[4*i+3] = rr, g, b, a
	}
	var out image.Image = img
	if w != iconSize || h != iconSize {
		dst := image.NewNRGBA(image.Rect(0, 0, iconSize, iconSize))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Over, nil)
		out = dst
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// dibits reads a bitmap as top-down 32-bit BGRA.
func dibits(hdc, hbm uintptr) (w, h int, pix []byte, err error) {
	var bm bitmap
	if r, _, _ := pGetObj.Call(hbm, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); r == 0 {
		return 0, 0, nil, errors.New("GetObject failed")
	}
	w, h = int(bm.Width), int(bm.Height)
	if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
		return 0, 0, nil, errors.New("odd icon size")
	}
	bi := bitmapInfo{Size: 40, Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	pix = make([]byte, w*h*4)
	r, _, _ := pDIBits.Call(hdc, hbm, 0, uintptr(h), uintptr(unsafe.Pointer(&pix[0])), uintptr(unsafe.Pointer(&bi)), 0)
	if r == 0 {
		return 0, 0, nil, errors.New("GetDIBits failed")
	}
	return w, h, pix, nil
}
