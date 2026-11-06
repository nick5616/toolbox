package lan

import (
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSanitizeComponent(t *testing.T) {
	long := strings.Repeat("é", 200) + ".txt" // 404 bytes
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "photo.jpg", want: "photo.jpg"},
		{in: ".", wantErr: true},
		{in: "..", wantErr: true},
		{in: "  spaced name . ", want: "spaced name"},
		{in: "...", want: "file"},
		{in: "", want: "file"},
		{in: `a<b>c:d"e|f?g*h\i/j`, want: "abcdefghij"},
		{in: "tab\there\x00nul\x1b", want: "tabherenul"},
		{in: "CON", want: "CON_"},
		{in: "nul.txt", want: "nul_.txt"},
		{in: "Com1.tar.gz", want: "Com1_.tar.gz"},
		{in: "LPT9", want: "LPT9_"},
		{in: "console.txt", want: "console.txt"},
		{in: "cafe\u0301.txt", want: "caf\u00e9.txt"}, // NFC
		{in: "日本語のファイル.pdf", want: "日本語のファイル.pdf"},
		{in: "trailing.", want: "trailing"},
		{in: ".hidden", want: "hidden"},
	}
	for _, tc := range tests {
		got, err := SanitizeComponent(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("SanitizeComponent(%q) = %q, want an error", tc.in, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("SanitizeComponent(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
		}
	}
	got, err := SanitizeComponent(long)
	if err != nil || len(got) > MaxNameBytes || !strings.HasSuffix(got, ".txt") {
		t.Errorf("long name: %d bytes, %q, %v", len(got), got, err)
	}
}

func TestSanitizePath(t *testing.T) {
	deep := strings.Repeat("d/", MaxPathDepth+1) + "f"
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "Trip/IMG_1.jpg", want: "Trip/IMG_1.jpg"},
		{in: "/etc/passwd", want: "etc/passwd"},
		{in: `C:\Users\x\file.txt`, want: "C/Users/x/file.txt"},
		{in: "a//b///c", want: "a/b/c"},
		{in: "../../evil", wantErr: true},
		{in: "a/../b", wantErr: true},
		{in: "a/./b", wantErr: true},
		{in: `..\evil`, wantErr: true},
		{in: "con/aux.txt", want: "con_/aux_.txt"},
		{in: "///", want: "file"},
		{in: deep, wantErr: true},
	}
	for _, tc := range tests {
		got, err := SanitizePath(tc.in)
		if tc.wantErr != (err != nil) || (!tc.wantErr && got != tc.want) {
			t.Errorf("SanitizePath(%q) = %q, %v; want %q (err %v)", tc.in, got, err, tc.want, tc.wantErr)
		}
	}
}

func TestSafeFolderNameAndUniqueName(t *testing.T) {
	if got := SafeFolderName("Nicole's MacBook: Pro"); got != "Nicole's MacBook Pro" {
		t.Errorf("SafeFolderName = %q", got)
	}
	if got := SafeFolderName(".."); got != "device" {
		t.Errorf("SafeFolderName(..) = %q", got)
	}
	dir := t.TempDir()
	if got := UniqueName(dir, "a.txt"); got != "a.txt" {
		t.Errorf("unused name = %q", got)
	}
	os.WriteFile(filepath.Join(dir, "a.txt"), nil, 0o600)
	if got := UniqueName(dir, "a.txt"); got != "a (2).txt" {
		t.Errorf("collision = %q", got)
	}
	os.WriteFile(filepath.Join(dir, "a (2).txt"), nil, 0o600)
	if got := UniqueName(dir, "a.txt"); got != "a (3).txt" {
		t.Errorf("second collision = %q", got)
	}
	os.MkdirAll(filepath.Join(dir, "sub"), 0o700)
	os.WriteFile(filepath.Join(dir, "sub", "b"), nil, 0o600)
	if got := UniqueName(dir, "sub/b"); got != "sub/b (2)" {
		t.Errorf("nested collision = %q", got)
	}
}

func TestAllowedAddr(t *testing.T) {
	tests := []struct {
		ip   string
		loop bool
		want bool
	}{
		{"10.1.2.3", false, true},
		{"172.16.0.1", false, true},
		{"172.31.255.255", false, true},
		{"172.32.0.1", false, false},
		{"172.15.0.1", false, false},
		{"192.168.1.20", false, true},
		{"169.254.10.10", false, true},
		{"100.64.0.1", false, true},
		{"100.127.255.254", false, true},
		{"100.128.0.1", false, false},
		{"8.8.8.8", false, false},
		{"1.1.1.1", false, false},
		{"127.0.0.1", false, false},
		{"127.0.0.1", true, true},
		{"::1", false, false},
		{"::1", true, true},
		{"fd12:3456::1", false, true},
		{"fe80::1", false, true},
		{"2001:db8::1", false, false},
		{"::ffff:192.168.1.5", false, true},
		{"::ffff:8.8.8.8", false, false},
		{"0.0.0.0", false, false},
	}
	for _, tc := range tests {
		a := netip.MustParseAddr(tc.ip)
		if got := AllowedAddr(a, tc.loop); got != tc.want {
			t.Errorf("AllowedAddr(%s, loopback=%v) = %v, want %v", tc.ip, tc.loop, got, tc.want)
		}
	}
	if AllowedAddr(netip.Addr{}, true) {
		t.Error("the zero address must not be allowed")
	}
}

func TestSubnetHosts(t *testing.T) {
	a := netip.MustParseAddr("192.168.1.20")
	locals := []localAddr{{Addr: a, Net: netip.MustParsePrefix("192.168.1.0/16")}}
	hosts := subnetHosts(locals, 1024)
	if len(hosts) != 253 { // .1-.254 minus ourselves
		t.Errorf("got %d hosts, want 253", len(hosts))
	}
	for _, h := range hosts {
		if h == a {
			t.Error("own address in the scan list")
		}
	}
	if got := subnetHosts(locals, 10); len(got) != 10 {
		t.Errorf("limit not applied: %d", len(got))
	}
	small := []localAddr{{Addr: netip.MustParseAddr("10.0.0.5"), Net: netip.MustParsePrefix("10.0.0.0/8")}}
	if got := subnetHosts(small, 1024); len(got) > 254 {
		t.Errorf("a /8 must be limited to its /24: %d", len(got))
	}
}

type fakeAddrConn struct {
	net.Conn
	addr net.Addr
}

func (f fakeAddrConn) RemoteAddr() net.Addr { return f.addr }

type fakeListener struct {
	conns  chan net.Conn
	closed []net.Conn
}

func (f *fakeListener) Accept() (net.Conn, error) {
	c, ok := <-f.conns
	if !ok {
		return nil, net.ErrClosed
	}
	return c, nil
}
func (f *fakeListener) Close() error   { return nil }
func (f *fakeListener) Addr() net.Addr { return &net.TCPAddr{} }

func TestFilterListenerClosesDisallowed(t *testing.T) {
	fl := &fakeListener{conns: make(chan net.Conn, 3)}
	mk := func(ip string) (net.Conn, net.Conn) {
		a, b := net.Pipe()
		return fakeAddrConn{Conn: a, addr: &net.TCPAddr{IP: net.ParseIP(ip), Port: 1234}}, b
	}
	bad, badPeer := mk("8.8.8.8")
	good, _ := mk("192.168.0.9")
	fl.conns <- bad
	fl.conns <- good
	f := &filterListener{Listener: fl, allow: func(a netip.Addr) bool { return AllowedAddr(a, false) }}
	got, err := f.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if got.RemoteAddr().String() != "192.168.0.9:1234" {
		t.Errorf("accepted %v", got.RemoteAddr())
	}
	badPeer.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := badPeer.Read(make([]byte, 1)); err == nil {
		t.Error("the public address's connection should have been closed before any data")
	}
}

func TestFingerprintVectors(t *testing.T) {
	if got := Fingerprint([]byte("abc")); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Errorf("Fingerprint(abc) = %s", got)
	}
	if got := ShortCode("ba7816bf8f01"); got != "BA78" {
		t.Errorf("ShortCode = %q", got)
	}
	if got := ShortCode("ab"); got != "AB" {
		t.Errorf("short input = %q", got)
	}
	vectors := []struct{ a, b, want string }{
		{"aa", "bb", "245865"},
		{"BB", "aa", "245865"}, // order and case don't matter
		{strings.Repeat("0123456789abcdef", 4), strings.Repeat("fedcba9876543210", 4), "627097"},
		{"x", "x", "324906"},
	}
	for _, v := range vectors {
		if got := PairCode(v.a, v.b); got != v.want {
			t.Errorf("PairCode(%q,%q) = %s, want %s", v.a, v.b, got, v.want)
		}
		if got := PairCode(v.b, v.a); got != v.want {
			t.Errorf("PairCode reversed (%q,%q) = %s", v.b, v.a, got)
		}
	}
}

func TestIdentityPersistsAndIsPrivate(t *testing.T) {
	dir := t.TempDir()
	a, err := LoadOrCreateIdentity(dir, "Studio")
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreateIdentity(dir, "Other name")
	if err != nil {
		t.Fatal(err)
	}
	if a.Fingerprint != b.Fingerprint || len(a.Fingerprint) != 64 || a.Fingerprint != strings.ToLower(a.Fingerprint) {
		t.Errorf("identity not stable: %s vs %s", a.Fingerprint, b.Fingerprint)
	}
	fi, err := os.Stat(filepath.Join(dir, "identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 && os.PathSeparator == '/' {
		t.Errorf("identity.pem is %v, want 0600", perm)
	}
	leaf := a.Cert.Leaf
	if leaf == nil {
		leaf, _ = parseLeaf(a)
	}
	if leaf.Subject.CommonName != "Studio" {
		t.Errorf("CN = %q", leaf.Subject.CommonName)
	}
	if years := leaf.NotAfter.Sub(leaf.NotBefore).Hours() / 24 / 365; years < 9.9 || years > 10.1 {
		t.Errorf("validity %.2f years", years)
	}
	if len(leaf.DNSNames)+len(leaf.IPAddresses) != 0 {
		t.Error("the certificate must carry no SANs")
	}
	c, err := LoadOrCreateIdentity(t.TempDir(), "x")
	if err != nil || c.Fingerprint == a.Fingerprint {
		t.Errorf("a new directory must get a new identity (%v)", err)
	}
}

func TestWireFixtures(t *testing.T) {
	read := func(name string) []byte {
		b, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	var ann Info
	if err := json.Unmarshal(read("localsend_announce.json"), &ann); err != nil {
		t.Fatal(err)
	}
	if ann.Alias != "Nice Orange" || ann.Version != "2.0" || ann.DeviceType != "mobile" || ann.Port != 53317 ||
		ann.Protocol != "https" || !ann.Announce || !ann.Download || ann.Toolbox != 0 || len(ann.Fingerprint) != 64 {
		t.Errorf("announce decoded as %+v", ann)
	}
	var tb Info
	if err := json.Unmarshal(read("toolbox_announce.json"), &tb); err != nil || tb.Toolbox != 1 || tb.DeviceModel != "Toolbox" {
		t.Errorf("toolbox announce: %+v, %v", tb, err)
	}
	// Our own announcement round-trips and carries the extension.
	out, _ := json.Marshal(Info{Alias: "A", Version: ProtocolVersion, DeviceModel: DeviceModel, DeviceType: "desktop", Fingerprint: "ff", Port: 1, Protocol: "https", Announce: true, Toolbox: 1})
	var m map[string]any
	json.Unmarshal(out, &m)
	for _, k := range []string{"alias", "version", "deviceModel", "deviceType", "fingerprint", "port", "protocol", "download", "announce", "toolbox"} {
		if _, ok := m[k]; !ok {
			t.Errorf("announcement lacks %q: %s", k, out)
		}
	}

	var pr prepareRequest
	if err := json.Unmarshal(read("localsend_prepare_upload.json"), &pr); err != nil {
		t.Fatal(err)
	}
	if len(pr.Files) != 2 || pr.Info.Alias != "Nice Orange" {
		t.Fatalf("prepare decoded as %+v", pr)
	}
	metas, total, err := buildFiles(pr)
	if err != nil {
		t.Fatal(err)
	}
	if total != 324242+5 || len(metas) != 2 {
		t.Errorf("total %d, %d files", total, len(metas))
	}
	var img FileMeta
	for _, m := range metas {
		if m.ID == "some file id" {
			img = m
		}
	}
	if img.RelPath != "my image.png" || img.Type != "image/png" || img.SHA256 == "" || img.Modified != time.Date(2021, 1, 1, 12, 34, 56, 0, time.UTC).UnixMilli() {
		t.Errorf("image meta = %+v", img)
	}
	if isTextOnly(pr.Files) {
		t.Error("a request with an image isn't text only")
	}
	txt := map[string]wireFile{"t": pr.Files["text file id"]}
	if !isTextOnly(txt) {
		t.Error("the note should count as a text message")
	}
	var resp prepareResponse
	if err := json.Unmarshal(read("localsend_prepare_response.json"), &resp); err != nil || resp.SessionID != "mySessionId" || resp.Files["some file id"] != "someFileToken" {
		t.Errorf("response: %+v, %v", resp, err)
	}
}

func TestBuildFilesRejects(t *testing.T) {
	one := func(name string, size int64) prepareRequest {
		return prepareRequest{Files: map[string]wireFile{"a": {ID: "a", FileName: name, Size: size}}}
	}
	for name, req := range map[string]prepareRequest{
		"empty":     {},
		"dotdot":    one("a/../b", 1),
		"negative":  one("a", -1),
		"long name": one(strings.Repeat("x", 300), 1),
		"no name":   one("", 1),
		"bad sha":   {Files: map[string]wireFile{"a": {ID: "a", FileName: "a", Size: 1, SHA256: ptr("zz")}}},
	} {
		if _, _, err := buildFiles(req); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	many := prepareRequest{Files: map[string]wireFile{}}
	for i := 0; i <= MaxFilesPerSess; i++ {
		id := "f" + strings.Repeat("x", 1) + string(rune('a'+i%26)) + itoa(i)
		many.Files[id] = wireFile{ID: id, FileName: id, Size: 1}
	}
	if _, _, err := buildFiles(many); err == nil {
		t.Error("more than MaxFilesPerSess files must be rejected")
	}
}

func TestISOTimes(t *testing.T) {
	want := time.Date(2021, 1, 1, 12, 34, 56, 0, time.UTC).UnixMilli()
	for _, s := range []string{"2021-01-01T12:34:56Z", "2021-01-01T12:34:56.000Z", "2021-01-01T12:34:56", "2021-01-01T13:34:56+01:00"} {
		if got := parseISO(s); got != want {
			t.Errorf("parseISO(%q) = %d, want %d", s, got, want)
		}
	}
	if parseISO("junk") != 0 || parseISO("") != 0 {
		t.Error("junk dates must be 0")
	}
	if got := parseISO(formatISO(want)); got != want {
		t.Errorf("round trip %d != %d", got, want)
	}
}

func TestAddrRankPrefersHomeIPv4(t *testing.T) {
	order := []string{"192.168.1.20", "100.101.102.103", "169.254.1.1", "fd7a::1", "fe80::1"}
	for i := 1; i < len(order); i++ {
		if addrRank(order[i-1]) >= addrRank(order[i]) {
			t.Errorf("%s should rank before %s", order[i-1], order[i])
		}
	}
}
