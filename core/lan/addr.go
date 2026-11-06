package lan

import (
	"net"
	"net/netip"
	"sort"
)

var allowedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
}

// AllowedAddr reports whether a remote address may talk to us (SPEC §3.5):
// private, link-local and Tailscale ranges, plus loopback only for tests.
func AllowedAddr(a netip.Addr, allowLoopback bool) bool {
	a = a.Unmap().WithZone("")
	if !a.IsValid() {
		return false
	}
	if a.IsLoopback() {
		return allowLoopback
	}
	for _, p := range allowedPrefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// hostOf parses the IP out of "ip:port", "[ip]:port" or a bare IP.
func hostOf(s string) (netip.Addr, bool) {
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().Unmap().WithZone(""), true
	}
	if h, _, err := net.SplitHostPort(s); err == nil {
		s = h
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap().WithZone(""), true
}

// localAddr is one of this computer's allowed addresses.
type localAddr struct {
	Addr  netip.Addr
	Net   netip.Prefix
	Iface net.Interface
}

// localAddrs lists this computer's allowed addresses on up interfaces.
func localAddrs(allowLoopback bool) []localAddr {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []localAddr
	for _, ifi := range ifs {
		if ifi.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip, ok := netip.AddrFromSlice(ipn.IP)
			if !ok {
				continue
			}
			ip = ip.Unmap().WithZone("")
			if !AllowedAddr(ip, allowLoopback) {
				continue
			}
			ones, bits := ipn.Mask.Size()
			if ip.Is4() && bits == 128 {
				ones -= 96
			}
			pfx, err := ip.Prefix(max(ones, 0))
			if err != nil {
				continue
			}
			out = append(out, localAddr{Addr: ip, Net: pfx, Iface: ifi})
		}
	}
	return out
}

// localAddrStrings lists the allowed local addresses as strings (IPv4 first).
func localAddrStrings(allowLoopback bool) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, la := range localAddrs(allowLoopback) {
		s := la.Addr.String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return addrRank(out[i]) < addrRank(out[j]) })
	return out
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// addrRank orders addresses by how well they reach a device on the same
// network: home-network IPv4 first, then Tailscale-range IPv4, link-local
// IPv4, unique-local IPv6, and IPv6 link-local last (it needs an interface
// zone to be dialled, which a stored address doesn't carry).
func addrRank(s string) int {
	a, ok := hostOf(s)
	if !ok {
		return 9
	}
	switch {
	case a.Is4() && a.IsLinkLocalUnicast():
		return 2
	case a.Is4() && cgnat.Contains(a):
		return 1
	case a.Is4():
		return 0
	case a.IsLinkLocalUnicast():
		return 4
	default:
		return 3
	}
}

// eligibleInterfaces lists up, multicast-capable, non-loopback interfaces with an allowed address.
func eligibleInterfaces() []net.Interface {
	seen := map[int]bool{}
	var out []net.Interface
	for _, la := range localAddrs(false) {
		ifi := la.Iface
		if ifi.Flags&net.FlagMulticast == 0 || ifi.Flags&net.FlagLoopback != 0 || seen[ifi.Index] {
			continue
		}
		seen[ifi.Index] = true
		out = append(out, ifi)
	}
	return out
}

// subnetHosts lists the IPv4 hosts of each local network (/24 at most), minus
// our own addresses, capped at limit hosts overall.
func subnetHosts(locals []localAddr, limit int) []netip.Addr {
	own := map[netip.Addr]bool{}
	for _, l := range locals {
		own[l.Addr] = true
	}
	seen := map[netip.Addr]bool{}
	var out []netip.Addr
	for _, l := range locals {
		if !l.Addr.Is4() || l.Addr.IsLoopback() {
			continue
		}
		bits := max(l.Net.Bits(), 24)
		pfx, err := l.Addr.Prefix(bits)
		if err != nil {
			continue
		}
		for a := pfx.Masked().Addr().Next(); pfx.Contains(a); a = a.Next() {
			if own[a] || seen[a] {
				continue
			}
			if a.As4()[3] == 255 {
				continue
			}
			seen[a] = true
			out = append(out, a)
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}
