package brushimport

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path"
	"sort"
	"strings"

	"howett.net/plist"
)

// ParseProcreate reads a .brushset or .brush: a zip with brushset.plist (the
// set's name and order) and one folder per brush holding Brush.archive (an
// NSKeyedArchiver binary plist), Shape.png and Grain.png. A single .brush has
// one such folder (or the files at the root).
//
// The format is undocumented. Known keys are mapped; everything else is kept
// in Set.Raw and listed in the fidelity notes.
func ParseProcreate(data []byte, fileName string) (*Result, error) {
	files, err := ReadZip(data)
	if err != nil {
		return nil, err
	}
	// Folders holding a Brush.archive.
	var dirs []string
	for name := range files {
		if path.Base(name) == "Brush.archive" {
			dirs = append(dirs, path.Dir(name))
		}
	}
	if len(dirs) == 0 {
		return nil, errors.New("no Procreate brushes found in this file (no Brush.archive)")
	}
	sort.Strings(dirs)

	setName := strings.TrimSuffix(fileName, path.Ext(fileName))
	var order []string
	if pl, ok := files["brushset.plist"]; ok {
		var meta map[string]any
		if _, err := plist.Unmarshal(pl, &meta); err == nil {
			if s, ok := meta["name"].(string); ok && strings.TrimSpace(s) != "" {
				setName = strings.TrimSpace(s)
			}
			if arr, ok := meta["brushes"].([]any); ok {
				for _, e := range arr {
					if s, ok := e.(string); ok {
						order = append(order, s)
					}
				}
			}
		}
	}
	if len(order) > 0 {
		pos := map[string]int{}
		for i, o := range order {
			pos[o] = i
		}
		sort.SliceStable(dirs, func(i, j int) bool {
			pi, oki := pos[path.Base(dirs[i])]
			pj, okj := pos[path.Base(dirs[j])]
			if oki && okj {
				return pi < pj
			}
			return oki && !okj
		})
	}

	res := &Result{Set: Set{Name: setName, Source: SourceProcreate, Files: map[string][]byte{}, Raw: map[string][]byte{}}}
	var n notes
	n.add("Procreate's brush format is undocumented: settings were mapped from community-documented keys and are approximate.")
	skipped := 0
	for _, dir := range dirs {
		prefix := ""
		if dir != "." {
			prefix = dir + "/"
		}
		archive := files[prefix+"Brush.archive"]
		brushNotes := &notes{}
		p, raw, err := mapProcreateBrush(archive, baseOrBrush(dir), files[prefix+"Shape.png"], files[prefix+"Grain.png"], &res.Set, brushNotes)
		if err != nil {
			skipped++
			n.add("Skipped a brush that couldn't be read (%s): %v", baseOrBrush(dir), err)
			continue
		}
		p.Fidelity = append([]string{}, brushNotes.list...)
		if err := res.Set.add(p); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			res.Set.Raw[p.ID] = raw
		}
		for _, m := range brushNotes.list {
			n.add("%s", m)
		}
	}
	if len(res.Set.Brushes) == 0 {
		return nil, fmt.Errorf("none of the %d brushes could be read", skipped)
	}
	res.Fidelity = n.list
	return res, nil
}

func baseOrBrush(p string) string {
	if p == "." || p == "" {
		return "Brush"
	}
	return path.Base(p)
}

// ---- NSKeyedArchiver ----

type archive struct{ objects []any }

const maxArchiveDepth = 40

func (a *archive) uid(v any) (int, bool) {
	if u, ok := v.(plist.UID); ok {
		return int(u), int(u) >= 0 && int(u) < len(a.objects)
	}
	return 0, false
}

// expand turns a value of the object graph into plain Go data: UID references
// are followed, NSDictionary/NSArray/NSString/NSData become map/slice/string/[]byte
// and every other class becomes a map of its fields plus "$classname".
func (a *archive) expand(v any, depth int) any {
	if depth > maxArchiveDepth {
		return nil
	}
	if i, ok := a.uid(v); ok {
		return a.expand(a.objects[i], depth+1)
	}
	switch t := v.(type) {
	case string:
		if t == "$null" {
			return nil
		}
		return t
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = a.expand(e, depth+1)
		}
		return out
	case map[string]any:
		class := ""
		if c, ok := t["$class"]; ok {
			if cm, ok := a.expand(c, depth+1).(map[string]any); ok {
				class, _ = cm["$classname"].(string)
			}
		}
		switch class {
		case "NSDictionary", "NSMutableDictionary":
			keys, _ := t["NS.keys"].([]any)
			vals, _ := t["NS.objects"].([]any)
			out := map[string]any{}
			for i := range keys {
				if i >= len(vals) {
					break
				}
				if k, ok := a.expand(keys[i], depth+1).(string); ok {
					out[k] = a.expand(vals[i], depth+1)
				}
			}
			return out
		case "NSArray", "NSMutableArray", "NSSet", "NSMutableSet":
			vals, _ := t["NS.objects"].([]any)
			out := make([]any, len(vals))
			for i, e := range vals {
				out[i] = a.expand(e, depth+1)
			}
			return out
		case "NSString", "NSMutableString":
			s, _ := t["NS.string"].(string)
			return s
		case "NSData", "NSMutableData":
			b, _ := t["NS.data"].([]byte)
			return b
		}
		out := map[string]any{}
		for k, e := range t {
			if k == "$class" {
				continue
			}
			out[k] = a.expand(e, depth+1)
		}
		if class != "" {
			out["$classname"] = class
		}
		return out
	default:
		return v
	}
}

// DecodeArchive parses an NSKeyedArchiver plist and returns its root object.
func DecodeArchive(data []byte) (map[string]any, error) {
	var top map[string]any
	if _, err := plist.Unmarshal(data, &top); err != nil {
		return nil, fmt.Errorf("not a property list: %w", err)
	}
	objs, ok := top["$objects"].([]any)
	if !ok {
		return nil, errors.New("not an NSKeyedArchiver archive (no $objects)")
	}
	a := &archive{objects: objs}
	root := any(nil)
	if t, ok := top["$top"].(map[string]any); ok {
		if r, ok := t["root"]; ok {
			root = r
		} else {
			keys := make([]string, 0, len(t))
			for k := range t {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			if len(keys) > 0 {
				root = t[keys[0]]
			}
		}
	}
	if root == nil && len(objs) > 1 {
		root = plist.UID(1)
	}
	m, ok := a.expand(root, 0).(map[string]any)
	if !ok {
		return nil, errors.New("archive has no brush object")
	}
	return m, nil
}

// ---- mapping ----

type keys struct {
	m    map[string]any // lowercased key -> value
	used map[string]bool
}

func newKeys(m map[string]any) *keys {
	k := &keys{m: map[string]any{}, used: map[string]bool{}}
	for name, v := range m {
		k.m[strings.ToLower(name)] = v
	}
	return k
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, !math.IsNaN(t) && !math.IsInf(t, 0)
	case float32:
		return float64(t), true
	case int64:
		return float64(t), true
	case uint64:
		return float64(t), true
	case int:
		return float64(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// num returns the first present numeric key among names and marks it used.
func (k *keys) num(names ...string) (float64, bool) {
	for _, n := range names {
		if v, ok := k.m[n]; ok {
			if f, ok := toFloat(v); ok {
				k.used[n] = true
				return f, true
			}
		}
	}
	return 0, false
}

func (k *keys) str(names ...string) (string, bool) {
	for _, n := range names {
		if s, ok := k.m[n].(string); ok {
			k.used[n] = true
			return s, true
		}
	}
	return "", false
}

// unmapped returns the scalar settings that no mapping used, sorted.
func (k *keys) unmapped() map[string]any {
	out := map[string]any{}
	for n, v := range k.m {
		if k.used[n] || strings.HasPrefix(n, "$") {
			continue
		}
		switch t := v.(type) {
		case float64, int64, uint64, bool, string:
			out[n] = t
		}
	}
	return out
}

func mapProcreateBrush(archiveData []byte, folder string, shapePNG, grainPNG []byte, set *Set, n *notes) (*Preset, []byte, error) {
	root, err := DecodeArchive(archiveData)
	if err != nil {
		return nil, nil, err
	}
	k := newKeys(root)
	name, _ := k.str("name")
	if strings.TrimSpace(name) == "" {
		name = folder
	}
	p := NewPreset(strings.TrimSpace(name))
	p.Size = 40

	if v, ok := k.num("plotspacing", "spacing"); ok {
		p.Spacing = clamp(v, 0.01, 5)
	} else {
		n.add("%s: spacing not found; a default was used.", p.Name)
	}
	if v, ok := k.num("plotjitter", "jitter", "shapescatter"); ok {
		p.Scatter = clamp(v, 0, 3)
	}
	if v, ok := k.num("shapecount"); ok {
		p.Count = int(clamp(math.Round(v), 1, 16))
	}
	if v, ok := k.num("taperstartlength", "taperstart"); ok {
		p.Taper.Start = clamp(v, 0, 1)
	}
	if v, ok := k.num("taperendlength", "taperend"); ok {
		p.Taper.End = clamp(v, 0, 1)
	}
	if v, ok := k.num("taperpressure"); ok && v > 0.5 {
		p.Taper.ByPressure = true
	}
	if v, ok := k.num("minimumsize", "minsize"); ok {
		p.MinSize = clamp(v, 0, 1)
	}
	if v, ok := k.num("maximumsize", "maxsize"); ok {
		p.Size = round3(clamp(v, 0.05, 1) * 40)
		n.add("%s: Procreate stores sizes as fractions, so the brush size is a default (40 px).", p.Name)
	}
	if v, ok := k.num("maxopacity", "opacity"); ok {
		p.Opacity = clamp(v, 0, 1)
	}
	if _, ok := k.num("minopacity"); ok {
		n.add("%s: minimum opacity isn't supported and was skipped.", p.Name)
	}

	// Tip
	if len(shapePNG) > 0 {
		png, err := TipFromPNG(shapePNG, false, n)
		if err != nil {
			n.add("%s: the shape image couldn't be read (%v); a round tip was used.", p.Name, err)
		} else {
			p.Tip.Shape = Ref(set.addFile("tips", p.Name, png))
			n.add("Shape images are assumed to be white = paint; turn on Invert on the tip if one looks reversed.")
		}
	}
	if v, ok := k.num("shaperoundness", "roundness"); ok {
		p.Tip.Roundness = clamp(v, 0.05, 1)
	}
	if v, ok := k.num("shaperotation", "rotation"); ok {
		if math.Abs(v) <= 1 {
			v *= 360
		}
		p.Tip.Angle = round3(math.Mod(v, 360))
		n.add("%s: tip rotation is approximated.", p.Name)
	}
	if v, ok := k.num("shapeorientation", "orienttostroke", "followsstroke"); ok && v > 0.5 {
		p.Tip.AngleMode = "stroke"
	}
	if v, ok := k.num("shapeazimuth", "tiltazimuth", "azimuth"); ok && v > 0.5 {
		p.Tip.AngleMode = "tilt"
	}
	if v, ok := k.num("shaperandomise", "shaperandomize", "jitterrotation", "rotationjitter"); ok {
		p.Tip.RotationJitter = clamp(v, 0, 1)
	}
	if v, ok := k.num("shapeinverted", "shapeinvert"); ok && v > 0.5 {
		p.Tip.Invert = true
	}

	// Grain
	if len(grainPNG) > 0 {
		png, err := GrainFromPNG(grainPNG, n)
		if err != nil {
			n.add("%s: the grain image couldn't be read (%v); no grain was used.", p.Name, err)
		} else {
			p.Grain.Texture = Ref(set.addFile("grains", p.Name, png))
			p.Grain.Depth = 0.6
		}
	}
	if v, ok := k.num("texturescale", "grainscale"); ok {
		p.Grain.Scale = clamp(v, 0.1, 4)
	}
	if v, ok := k.num("texturedepth", "graindepth"); ok {
		p.Grain.Depth = clamp(v, 0, 1)
	}
	if v, ok := k.num("texturecontrast", "graincontrast"); ok {
		p.Grain.Contrast = clamp(v, 0, 2)
	}
	if v, ok := k.num("texturemovement", "grainmovement"); ok {
		if v >= 0.5 {
			p.Grain.Mode = "texturised"
		}
		n.add("%s: grain movement is approximated as moving or fixed (texturised).", p.Name)
	}

	// Dynamics: each is a linear response with the stored amount.
	dyn := func(input, target string, names ...string) {
		if v, ok := k.num(names...); ok && v > 0.001 {
			p.Dynamics = append(p.Dynamics, Dynamics{Input: input, Target: target, Amount: clamp(v, 0, 1), Curve: Curve{{0, 0}, {1, 1}}})
			n.add("%s: response curves are approximated as straight lines.", p.Name)
		}
	}
	dyn("pressure", "size", "dynamicspressuresize", "pressuresize")
	dyn("pressure", "opacity", "dynamicspressureopacity", "pressureopacity")
	dyn("pressure", "flow", "dynamicspressureflow", "pressureflow")
	dyn("velocity", "size", "dynamicsspeedsize", "speedsize")
	dyn("velocity", "opacity", "dynamicsspeedopacity", "speedopacity")
	dyn("tilt", "size", "dynamicstiltsize", "tiltsize")
	dyn("tilt", "opacity", "dynamicstiltopacity", "tiltopacity")

	// Wet
	if v, ok := k.num("dynamicsmix", "wetmix", "mix"); ok {
		p.Wet.Mix = clamp(v, 0, 1)
	}
	if v, ok := k.num("dynamicsload", "wetload", "load"); ok {
		p.Wet.Charge = clamp(v, 0, 1)
	}
	if v, ok := k.num("dynamicspressurebleed", "pressurebleed", "bleed"); ok {
		p.Wet.Bleed = clamp(v, 0, 1)
	}
	if v, ok := k.num("dynamicsglazedflow", "glazedflow"); ok && v > 0.5 {
		p.Rendering = "uniform-glaze"
	}
	if p.Wet.Mix > 0.3 {
		p.Rendering = "intense"
	}

	// Smoothing and colour
	if v, ok := k.num("plotsmoothing", "smoothing", "streamline", "pressuresmoothing"); ok {
		p.Smoothing.Streamline = clamp(v, 0, 1)
	}
	if v, ok := k.num("huejitter", "jitterhue", "dynamicsjitterhue"); ok {
		p.Color.HueJitter = clamp(v, 0, 1)
	}
	if v, ok := k.num("saturationjitter", "jittersaturation", "dynamicsjittersaturation"); ok {
		p.Color.SatJitter = clamp(v, 0, 1)
	}
	if v, ok := k.num("brightnessjitter", "jitterbrightness", "dynamicsjitterbrightness", "dynamicsjitterlightness"); ok {
		p.Color.BriJitter = clamp(v, 0, 1)
	}

	// Everything else is kept and named.
	rest := k.unmapped()
	var raw []byte
	if len(rest) > 0 {
		names := make([]string, 0, len(rest))
		for name := range rest {
			names = append(names, name)
		}
		sort.Strings(names)
		shown := names
		if len(shown) > 12 {
			shown = shown[:12]
		}
		more := ""
		if len(names) > len(shown) {
			more = fmt.Sprintf(" and %d more", len(names)-len(shown))
		}
		n.add("%s: %d settings aren't mapped yet (kept in the set's raw data): %s%s.", p.Name, len(names), strings.Join(shown, ", "), more)
		raw, _ = json.Marshal(rest)
	}
	return p, raw, nil
}
