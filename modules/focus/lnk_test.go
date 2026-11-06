package focus

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf16"
)

// lnkBuilder writes a minimal but spec-shaped shortcut.
type lnkBuilder struct {
	idList      bool
	linkInfo    bool
	unicodeInfo bool // LinkInfo with the optional Unicode offsets
	base        string
	suffix      string
	relative    string
	workingDir  string
	args        string
	env         string
	envAnsiOnly bool
	unicode     bool // StringData is UTF-16
}

func u16(b *bytes.Buffer, v uint16) { _ = binary.Write(b, binary.LittleEndian, v) }
func u32(b *bytes.Buffer, v uint32) { _ = binary.Write(b, binary.LittleEndian, v) }

func (l lnkBuilder) build() []byte {
	var flags uint32
	if l.idList {
		flags |= flagIDList
	}
	if l.linkInfo {
		flags |= flagLinkInfo
	}
	if l.relative != "" {
		flags |= flagRelativePath
	}
	if l.workingDir != "" {
		flags |= flagWorkingDir
	}
	if l.args != "" {
		flags |= flagArguments
	}
	if l.unicode {
		flags |= flagUnicode
	}
	var b bytes.Buffer
	u32(&b, lnkHeaderSize)
	b.Write(make([]byte, 16)) // CLSID
	u32(&b, flags)
	b.Write(make([]byte, lnkHeaderSize-b.Len())) // the rest of the header

	if l.idList {
		ids := []byte{0x14, 0x00, 0x1F, 0x50, 0xE0, 0x4F, 0xD0, 0x20, 0xEA, 0x3A, 0x69, 0x10, 0xA2, 0xD8, 0x08, 0x00, 0x2B, 0x30, 0x30, 0x9D, 0x00, 0x00}
		u16(&b, uint16(len(ids)))
		b.Write(ids)
	}
	if l.linkInfo {
		b.Write(l.linkInfoBytes())
	}
	str := func(s string) {
		if l.unicode {
			u := utf16.Encode([]rune(s))
			u16(&b, uint16(len(u)))
			for _, c := range u {
				u16(&b, c)
			}
			return
		}
		u16(&b, uint16(len(s)))
		b.WriteString(s)
	}
	if l.relative != "" {
		str(l.relative)
	}
	if l.workingDir != "" {
		str(l.workingDir)
	}
	if l.args != "" {
		str(l.args)
	}
	if l.env != "" {
		u32(&b, envBlockSize)
		u32(&b, envBlockSignature)
		ansi := make([]byte, 260)
		copy(ansi, l.env)
		b.Write(ansi)
		uni := make([]byte, 520)
		if !l.envAnsiOnly {
			for i, c := range utf16.Encode([]rune(l.env)) {
				binary.LittleEndian.PutUint16(uni[2*i:], c)
			}
		}
		b.Write(uni)
	}
	u32(&b, 0) // terminal block
	return b.Bytes()
}

func (l lnkBuilder) linkInfoBytes() []byte {
	headerSize := uint32(0x1C)
	if l.unicodeInfo {
		headerSize = 0x24
	}
	vol := make([]byte, 16) // a tiny VolumeID: size 16, drive type 3
	binary.LittleEndian.PutUint32(vol[0:], 16)
	binary.LittleEndian.PutUint32(vol[4:], 3)
	binary.LittleEndian.PutUint32(vol[12:], 0x10) // label offset (none)

	var tail bytes.Buffer
	volOff := headerSize
	tail.Write(vol)
	baseOff := volOff + uint32(len(vol))
	tail.WriteString(l.base)
	tail.WriteByte(0)
	suffixOff := baseOff + uint32(len(l.base)) + 1
	tail.WriteString(l.suffix)
	tail.WriteByte(0)
	var baseU, suffixU uint32
	if l.unicodeInfo {
		baseU = headerSize + uint32(tail.Len())
		for _, c := range utf16.Encode([]rune(l.base)) {
			u16(&tail, c)
		}
		u16(&tail, 0)
		suffixU = headerSize + uint32(tail.Len())
		for _, c := range utf16.Encode([]rune(l.suffix)) {
			u16(&tail, c)
		}
		u16(&tail, 0)
	}
	var b bytes.Buffer
	u32(&b, headerSize+uint32(tail.Len()))
	u32(&b, headerSize)
	u32(&b, linkInfoLocal)
	u32(&b, volOff)
	u32(&b, baseOff)
	u32(&b, 0) // CommonNetworkRelativeLinkOffset
	u32(&b, suffixOff)
	if l.unicodeInfo {
		u32(&b, baseU)
		u32(&b, suffixU)
	}
	b.Write(tail.Bytes())
	return b.Bytes()
}

func TestParseLnk(t *testing.T) {
	env := func(k string) string {
		return map[string]string{"ProgramFiles": `C:\Program Files`, "LOCALAPPDATA": `C:\Users\me\AppData\Local`}[k]
	}
	tests := []struct {
		name string
		l    lnkBuilder
		want string
	}{
		{"link info ansi", lnkBuilder{idList: true, linkInfo: true, base: `C:\Program Files\Foo`, suffix: `foo.exe`}, `C:\Program Files\Foo\foo.exe`},
		{"link info with base only", lnkBuilder{linkInfo: true, base: `C:\Apps\bar.exe`}, `C:\Apps\bar.exe`},
		{"link info unicode wins", lnkBuilder{linkInfo: true, unicodeInfo: true, base: `C:\Progräm\Foo`, suffix: `foo.exe`}, `C:\Progräm\Foo\foo.exe`},
		{"environment block (unicode)", lnkBuilder{idList: true, env: `%ProgramFiles%\Foo\foo.exe`}, `C:\Program Files\Foo\foo.exe`},
		{"environment block (ansi only)", lnkBuilder{env: `%LOCALAPPDATA%\Discord\Update.exe`, envAnsiOnly: true}, `C:\Users\me\AppData\Local\Discord\Update.exe`},
		{"relative path, unicode strings", lnkBuilder{relative: `..\bin\tool.exe`, workingDir: `C:\x`, args: "-a", unicode: true}, ""},
		{"absolute relative path", lnkBuilder{relative: `D:\Games\g.exe`}, `D:\Games\g.exe`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := parseLnk(tc.l.build())
			if err != nil {
				t.Fatal(err)
			}
			got := lnkTarget(info, filepath.Join("C:", "lnks", "sub"), env)
			if tc.want == "" {
				// resolved against the shortcut's folder
				want := filepath.Clean(filepath.Join("C:", "lnks", "sub", "..", "bin", "tool.exe"))
				if got != want {
					t.Errorf("got %q, want %q", got, want)
				}
				if info.WorkingDir != `C:\x` || info.Arguments != "-a" {
					t.Errorf("string data = %+v", info)
				}
				return
			}
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseLnkPrefersLinkInfoOverEnvAndRelative(t *testing.T) {
	l := lnkBuilder{linkInfo: true, base: `C:\A`, suffix: `a.exe`, relative: `b.exe`, env: `C:\E\e.exe`}
	info, err := parseLnk(l.build())
	if err != nil {
		t.Fatal(err)
	}
	if got := lnkTarget(info, `C:\`, nil); got != `C:\A\a.exe` {
		t.Errorf("got %q", got)
	}
	if info.EnvTarget != `C:\E\e.exe` || info.RelativePath != "b.exe" {
		t.Errorf("info = %+v", info)
	}
}

func TestParseLnkRejectsGarbage(t *testing.T) {
	good := lnkBuilder{linkInfo: true, base: `C:\A\a.exe`}.build()
	for name, data := range map[string][]byte{
		"empty":        nil,
		"short":        []byte{1, 2, 3},
		"bad header":   append([]byte{9, 0, 0, 0}, make([]byte, 100)...),
		"cut linkinfo": good[:lnkHeaderSize+10],
	} {
		if _, err := parseLnk(data); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	// A huge claimed LinkInfo size must not panic.
	bad := append([]byte{}, good...)
	binary.LittleEndian.PutUint32(bad[lnkHeaderSize:], 0xFFFFFFF0)
	if _, err := parseLnk(bad); err == nil {
		t.Error("oversized LinkInfo accepted")
	}
}

func TestReadLnkFromDisk(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "App.lnk")
	if err := os.WriteFile(p, lnkBuilder{linkInfo: true, base: `C:\Apps`, suffix: `app.exe`}.build(), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readLnk(p)
	if err != nil || got != `C:\Apps\app.exe` {
		t.Fatalf("got %q err=%v", got, err)
	}
	big := filepath.Join(dir, "big.lnk")
	if err := os.WriteFile(big, bytes.Repeat([]byte{0}, 2<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readLnk(big); err == nil {
		t.Error("a 2 MiB shortcut should be refused")
	}
}

func TestExpandPercent(t *testing.T) {
	get := func(k string) string { return map[string]string{"A": "x"}[k] }
	for in, want := range map[string]string{
		"%A%\\b":    "x\\b",
		"%NOPE%\\b": "%NOPE%\\b",
		"100%":      "100%",
		"%%":        "%%",
		"a%A%%A%":   "axx",
	} {
		if got := expandPercent(in, get); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}
