package brushimport

import (
	"encoding/binary"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
)

// ParseKritaBundle reads a Krita resource bundle (.bundle, a zip). Tips from
// brushes/*.gbr|*.png become tips (one brush each); patterns/*.pat|*.png
// become grains (one brush each, so they can be tried). Paint-op presets
// (.kpp) aren't read.
func ParseKritaBundle(data []byte, fileName string) (*Result, error) {
	files, err := ReadZip(data)
	if err != nil {
		return nil, err
	}
	res := &Result{Set: Set{Name: strings.TrimSuffix(fileName, extOf(fileName)), Source: SourceKrita, Files: map[string][]byte{}}}
	var n notes
	names := make([]string, 0, len(files))
	for k := range files {
		names = append(names, k)
	}
	sort.Strings(names)
	presets, other := 0, 0
	for _, name := range names {
		ext := strings.ToLower(path.Ext(name))
		base := strings.TrimSuffix(path.Base(name), path.Ext(name))
		switch {
		case strings.HasPrefix(name, "brushes/") && (ext == ".gbr" || ext == ".png"):
			var png []byte
			var title string
			spacing := 0.25
			if ext == ".gbr" {
				mask, w, h, t, sp, err := parseGBR(files[name])
				if err != nil {
					n.add("%s was skipped: %v.", path.Base(name), err)
					continue
				}
				mask, w, h, scaled := downscale(mask, w, h, MaxTipSide)
				if scaled {
					n.add("Large tip images were scaled down to %d px.", MaxTipSide)
				}
				png, err = EncodeTip(mask, w, h)
				if err != nil {
					return nil, err
				}
				title, spacing = t, sp
			} else {
				png, err = TipFromPNG(files[name], true, &n)
				if err != nil {
					n.add("%s was skipped: %v.", path.Base(name), err)
					continue
				}
			}
			if strings.TrimSpace(title) == "" {
				title = base
			}
			p := NewPreset(title)
			p.Size = 30
			p.Spacing = spacing
			p.Tip.Shape = Ref(res.Set.addFile("tips", title, png))
			if err := res.Set.add(p); err != nil {
				return nil, err
			}
		case strings.HasPrefix(name, "patterns/") && (ext == ".pat" || ext == ".png"):
			var png []byte
			title := base
			if ext == ".pat" {
				mask, w, h, t, err := parsePAT(files[name])
				if err != nil {
					n.add("%s was skipped: %v.", path.Base(name), err)
					continue
				}
				mask, w, h, _ = downscale(mask, w, h, MaxTipSide)
				if png, err = EncodeGrain(mask, w, h); err != nil {
					return nil, err
				}
				if strings.TrimSpace(t) != "" {
					title = t
				}
			} else {
				png, err = GrainFromPNG(files[name], &n)
				if err != nil {
					n.add("%s was skipped: %v.", path.Base(name), err)
					continue
				}
			}
			p := NewPreset(title + " (grain)")
			p.Size = 40
			p.Spacing = 0.06
			p.Grain = Grain{Texture: Ref(res.Set.addFile("grains", title, png)), Mode: "texturised", Scale: 1, Depth: 1, Contrast: 1}
			if err := res.Set.add(p); err != nil {
				return nil, err
			}
		case strings.HasPrefix(name, "paintoppresets/") && ext == ".kpp":
			presets++
		case name == "meta.xml" || name == "manifest.xml" || name == "mimetype" || strings.HasPrefix(name, "META-INF/") || strings.HasPrefix(name, "preview"):
		default:
			other++
		}
	}
	if len(res.Set.Brushes) == 0 {
		return nil, errors.New("no brush tips or patterns found in this bundle")
	}
	if presets > 0 {
		n.add("%d Krita brush presets (.kpp) were skipped: their engine settings aren't imported, only the tips and patterns they use.", presets)
	}
	if other > 0 {
		n.add("%d other files (such as gradients, palettes or animated tips) were skipped.", other)
	}
	n.add("Gray tips are assumed to be dark = paint, as Krita draws them.")
	res.Fidelity = n.list
	return res, nil
}

// parseGBR reads a GIMP brush (.gbr, versions 1 and 2) into a coverage mask.
func parseGBR(d []byte) (mask []uint8, w, h int, name string, spacing float64, err error) {
	spacing = 0.25
	if len(d) < 20 {
		return nil, 0, 0, "", 0, errors.New("not a GIMP brush")
	}
	hdr := int(binary.BigEndian.Uint32(d[0:]))
	ver := binary.BigEndian.Uint32(d[4:])
	w, h = int(binary.BigEndian.Uint32(d[8:])), int(binary.BigEndian.Uint32(d[12:]))
	bpp := int(binary.BigEndian.Uint32(d[16:]))
	nameAt := 20
	if ver == 2 {
		if len(d) < 28 || string(d[20:24]) != "GIMP" {
			return nil, 0, 0, "", 0, errors.New("not a GIMP brush")
		}
		if sp := int(binary.BigEndian.Uint32(d[24:])); sp > 0 {
			spacing = clamp(float64(sp)/100, 0.01, 5)
		}
		nameAt = 28
	} else if ver != 1 {
		return nil, 0, 0, "", 0, fmt.Errorf("brush version %d isn't supported", ver)
	}
	if w <= 0 || h <= 0 || w > MaxImageSide || h > MaxImageSide || hdr < nameAt || hdr > len(d) {
		return nil, 0, 0, "", 0, errors.New("brush size is outside the limits")
	}
	if i := indexByte(d[nameAt:hdr], 0); i >= 0 {
		name = string(d[nameAt : nameAt+i])
	} else {
		name = string(d[nameAt:hdr])
	}
	if bpp < 1 || bpp > 4 {
		return nil, 0, 0, "", 0, fmt.Errorf("%d bytes per pixel isn't supported", bpp)
	}
	if len(d)-hdr < w*h*bpp {
		return nil, 0, 0, "", 0, errors.New("pixel data is truncated")
	}
	px := d[hdr:]
	mask = make([]uint8, w*h)
	switch bpp {
	case 1:
		for i := range mask {
			mask[i] = 255 - px[i]
		}
	case 2:
		for i := range mask {
			mask[i] = px[i*2+1]
		}
	case 3:
		for i := range mask {
			mask[i] = 255 - uint8((299*int(px[i*3])+587*int(px[i*3+1])+114*int(px[i*3+2]))/1000)
		}
	case 4:
		varies := false
		for i := range mask {
			mask[i] = px[i*4+3]
			if mask[i] != 255 {
				varies = true
			}
		}
		if !varies {
			for i := range mask {
				mask[i] = 255 - uint8((299*int(px[i*4])+587*int(px[i*4+1])+114*int(px[i*4+2]))/1000)
			}
		}
	}
	return mask, w, h, name, spacing, nil
}

// parsePAT reads a GIMP pattern (.pat) into a grayscale grain.
func parsePAT(d []byte) (mask []uint8, w, h int, name string, err error) {
	if len(d) < 24 || string(d[20:24]) != "GPAT" {
		return nil, 0, 0, "", errors.New("not a GIMP pattern")
	}
	hdr := int(binary.BigEndian.Uint32(d[0:]))
	w, h = int(binary.BigEndian.Uint32(d[8:])), int(binary.BigEndian.Uint32(d[12:]))
	bpp := int(binary.BigEndian.Uint32(d[16:]))
	if w <= 0 || h <= 0 || w > MaxImageSide || h > MaxImageSide || hdr < 24 || hdr > len(d) {
		return nil, 0, 0, "", errors.New("pattern size is outside the limits")
	}
	if bpp < 1 || bpp > 4 {
		return nil, 0, 0, "", fmt.Errorf("%d bytes per pixel isn't supported", bpp)
	}
	if len(d)-hdr < w*h*bpp {
		return nil, 0, 0, "", errors.New("pixel data is truncated")
	}
	if i := indexByte(d[24:hdr], 0); i >= 0 {
		name = string(d[24 : 24+i])
	}
	px := d[hdr:]
	mask = make([]uint8, w*h)
	for i := range mask {
		switch bpp {
		case 1, 2:
			mask[i] = px[i*bpp]
		default:
			mask[i] = uint8((299*int(px[i*bpp]) + 587*int(px[i*bpp+1]) + 114*int(px[i*bpp+2])) / 1000)
		}
	}
	return mask, w, h, name, nil
}

func indexByte(b []byte, c byte) int {
	for i, v := range b {
		if v == c {
			return i
		}
	}
	return -1
}
