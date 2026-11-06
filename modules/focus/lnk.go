package focus

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

// A small reader for Windows shortcuts (MS-SHLLINK), enough to find the
// program a Start-menu shortcut starts (SPEC.md R24). It never touches the
// network or the shell: only bytes in, strings out.

const (
	lnkHeaderSize = 0x4C

	flagIDList       = 0x01
	flagLinkInfo     = 0x02
	flagName         = 0x04
	flagRelativePath = 0x08
	flagWorkingDir   = 0x10
	flagArguments    = 0x20
	flagIconLocation = 0x40
	flagUnicode      = 0x80

	linkInfoLocal = 0x01 // VolumeIDAndLocalBasePath

	envBlockSignature = 0xA0000001
	envBlockSize      = 0x314
)

var errLnk = errors.New("not a valid shortcut")

// lnkInfo is what the parser pulls out of a shortcut.
type lnkInfo struct {
	BasePath     string // LinkInfo: local base path + common suffix
	EnvTarget    string // EnvironmentVariableDataBlock target (unexpanded)
	RelativePath string
	WorkingDir   string
	Arguments    string
}

type lnkReader struct {
	b   []byte
	pos int
}

func (r *lnkReader) need(n int) error {
	if n < 0 || r.pos+n > len(r.b) {
		return errLnk
	}
	return nil
}

func (r *lnkReader) u16() (uint16, error) {
	if err := r.need(2); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint16(r.b[r.pos:])
	r.pos += 2
	return v, nil
}

func (r *lnkReader) u32() (uint32, error) {
	if err := r.need(4); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint32(r.b[r.pos:])
	r.pos += 4
	return v, nil
}

// parseLnk reads the pieces of a shortcut that locate its target.
func parseLnk(data []byte) (lnkInfo, error) {
	var info lnkInfo
	r := &lnkReader{b: data}
	size, err := r.u32()
	if err != nil || size != lnkHeaderSize || len(data) < lnkHeaderSize {
		return info, errLnk
	}
	flags := binary.LittleEndian.Uint32(data[20:])
	r.pos = lnkHeaderSize

	if flags&flagIDList != 0 {
		n, err := r.u16()
		if err != nil {
			return info, err
		}
		if err := r.need(int(n)); err != nil {
			return info, err
		}
		r.pos += int(n)
	}

	if flags&flagLinkInfo != 0 {
		start := r.pos
		total, err := r.u32()
		if err != nil {
			return info, err
		}
		if total < 28 || start+int(total) > len(data) {
			return info, errLnk
		}
		info.BasePath = parseLinkInfo(data[start : start+int(total)])
		r.pos = start + int(total)
	}

	unicode := flags&flagUnicode != 0
	readString := func() (string, error) {
		n, err := r.u16()
		if err != nil {
			return "", err
		}
		if unicode {
			if err := r.need(int(n) * 2); err != nil {
				return "", err
			}
			u := make([]uint16, n)
			for i := range u {
				u[i] = binary.LittleEndian.Uint16(r.b[r.pos+2*i:])
			}
			r.pos += int(n) * 2
			return string(utf16.Decode(u)), nil
		}
		if err := r.need(int(n)); err != nil {
			return "", err
		}
		s := string(r.b[r.pos : r.pos+int(n)])
		r.pos += int(n)
		return s, nil
	}
	for _, f := range []struct {
		flag uint32
		dst  *string
	}{
		{flagName, nil},
		{flagRelativePath, &info.RelativePath},
		{flagWorkingDir, &info.WorkingDir},
		{flagArguments, &info.Arguments},
		{flagIconLocation, nil},
	} {
		if flags&f.flag == 0 {
			continue
		}
		s, err := readString()
		if err != nil {
			return info, nil // truncated string data: keep what we have
		}
		if f.dst != nil {
			*f.dst = s
		}
	}

	// ExtraData blocks.
	for {
		bs, err := r.u32()
		if err != nil || bs < 4 {
			break
		}
		sig, err := r.u32()
		if err != nil {
			break
		}
		blockStart := r.pos - 8
		if blockStart+int(bs) > len(data) {
			break
		}
		if sig == envBlockSignature && bs == envBlockSize {
			blk := data[blockStart : blockStart+int(bs)]
			if u := utf16Z(blk[268 : 268+520]); u != "" {
				info.EnvTarget = u
			} else {
				info.EnvTarget = ansiZ(blk[8 : 8+260])
			}
		}
		r.pos = blockStart + int(bs)
	}
	return info, nil
}

// parseLinkInfo returns the local base path joined with the common suffix.
func parseLinkInfo(li []byte) string {
	le := binary.LittleEndian
	headerSize := le.Uint32(li[4:])
	flags := le.Uint32(li[8:])
	if flags&linkInfoLocal == 0 {
		return ""
	}
	baseOff := le.Uint32(li[16:])
	suffixOff := le.Uint32(li[24:])
	var base, suffix string
	if headerSize >= 0x24 && len(li) >= 0x24 {
		if o := le.Uint32(li[28:]); o != 0 {
			base = utf16ZAt(li, int(o))
		}
		if o := le.Uint32(li[32:]); o != 0 {
			suffix = utf16ZAt(li, int(o))
		}
	}
	if base == "" && baseOff != 0 {
		base = ansiZAt(li, int(baseOff))
	}
	if suffix == "" && suffixOff != 0 {
		suffix = ansiZAt(li, int(suffixOff))
	}
	if base == "" {
		return ""
	}
	if suffix == "" {
		return base
	}
	return strings.TrimRight(base, `\`) + `\` + strings.TrimLeft(suffix, `\`)
}

func ansiZAt(b []byte, off int) string {
	if off < 0 || off >= len(b) {
		return ""
	}
	return ansiZ(b[off:])
}

func ansiZ(b []byte) string {
	for i, c := range b {
		if c == 0 {
			b = b[:i]
			break
		}
	}
	return string(b)
}

func utf16ZAt(b []byte, off int) string {
	if off < 0 || off >= len(b) {
		return ""
	}
	return utf16Z(b[off:])
}

func utf16Z(b []byte) string {
	var u []uint16
	for i := 0; i+1 < len(b); i += 2 {
		c := binary.LittleEndian.Uint16(b[i:])
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u))
}

// expandPercent expands %NAME% with get; unknown names stay as written.
func expandPercent(s string, get func(string) string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] == '%' {
			if j := strings.IndexByte(s[i+1:], '%'); j > 0 {
				name := s[i+1 : i+1+j]
				if v := get(name); v != "" {
					b.WriteString(v)
					i += j + 2
					continue
				}
			}
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// lnkTarget picks the target path: the LinkInfo base path, else the
// environment block, else the relative path resolved against the shortcut's
// folder. env expands %VARS% (nil = os.Getenv).
func lnkTarget(info lnkInfo, lnkDir string, env func(string) string) string {
	if env == nil {
		env = os.Getenv
	}
	switch {
	case info.BasePath != "":
		return info.BasePath
	case info.EnvTarget != "":
		return expandPercent(info.EnvTarget, env)
	case info.RelativePath != "":
		rel := expandPercent(info.RelativePath, env)
		if isWinAbs(rel) {
			return rel
		}
		return filepath.Clean(filepath.Join(lnkDir, filepath.FromSlash(strings.ReplaceAll(rel, `\`, "/"))))
	}
	return ""
}

func isWinAbs(p string) bool {
	return len(p) >= 3 && p[1] == ':' && (p[2] == '\\' || p[2] == '/') || strings.HasPrefix(p, `\\`)
}

// readLnk resolves the shortcut file at path to its target. Files over
// 1 MiB are refused.
func readLnk(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.Size() > 1<<20 {
		return "", fmt.Errorf("%s: %w", filepath.Base(path), errLnk)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	info, err := parseLnk(data)
	if err != nil {
		return "", err
	}
	t := lnkTarget(info, filepath.Dir(path), nil)
	if t == "" {
		return "", errLnk
	}
	return t, nil
}
