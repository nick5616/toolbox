package lan

import (
	"context"
	"encoding/json"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"toolbox/core"
)

func multicastDest(ip netip.Addr) string {
	if ip.Is6() {
		return net.JoinHostPort(MulticastV6, strconv.Itoa(DefaultPort))
	}
	return net.JoinHostPort(MulticastV4, strconv.Itoa(DefaultPort))
}

// announceLoop announces three times after listening starts (0, 1 and 3 s).
func (l *listener) announceLoop() {
	prev := time.Duration(0)
	for _, at := range []time.Duration{0, 1 * time.Second, 3 * time.Second} {
		if d := at - prev; d > 0 {
			select {
			case <-l.ctx.Done():
				return
			case <-time.After(d):
			}
		}
		prev = at
		if l.ctx.Err() != nil {
			return
		}
		l.r.announceOn(l.mc)
	}
}

// announceOn writes our announcement to both multicast groups.
func (r *Runtime) announceOn(pc PacketConn) {
	b, err := json.Marshal(r.selfInfo(true))
	if err != nil {
		return
	}
	_ = pc.WriteTo(b, net.JoinHostPort(MulticastV4, strconv.Itoa(DefaultPort)))
	_ = pc.WriteTo(b, net.JoinHostPort(MulticastV6, strconv.Itoa(DefaultPort)))
}

func (l *listener) readLoop() {
	buf := make([]byte, 8192)
	for {
		n, from, err := l.mc.ReadFrom(buf)
		if l.ctx.Err() != nil {
			return
		}
		if err != nil {
			select {
			case <-l.ctx.Done():
				return
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}
		data := make([]byte, n)
		copy(data, buf[:n])
		l.handleDatagram(from, data)
	}
}

func (l *listener) handleDatagram(from string, data []byte) {
	r := l.r
	var in Info
	if json.Unmarshal(data, &in) != nil {
		return
	}
	ip, ok := hostOf(from)
	if !ok || !AllowedAddr(ip, r.cfg.AllowLoopback) {
		return
	}
	fp := normFP(in.Fingerprint)
	if fp == "" || fp == r.id.Fingerprint {
		return
	}
	r.mu.Lock()
	d := r.devs[fp]
	stored := d != nil && d.Stored
	r.mu.Unlock()
	if !stored {
		r.noteDevice(in, fp, ip.String(), false)
	}
	if in.Protocol == "http" {
		return // plain HTTP peers are shown but never used
	}
	if !in.Announce && !stored {
		return // a reply: nothing more to do
	}
	if stored {
		// Claims about a stored device move it only after a pinned handshake.
		r.mu.Lock()
		last := r.verifyAt[fp]
		recent := r.now().Sub(last) < 30*time.Second
		if !recent {
			r.verifyAt[fp] = r.now()
		}
		r.mu.Unlock()
		if recent && !in.Announce {
			return
		}
	}
	select {
	case l.sem <- struct{}{}:
	default:
		return
	}
	pin := ""
	if stored {
		pin = fp
	}
	l.spawn(func() {
		defer func() { <-l.sem }()
		l.answer(ip, in, fp, pin)
	})
}

// answer registers with a peer that announced itself; if that fails within
// 2 s and the peer asked (announce:true) we answer by multicast instead.
func (l *listener) answer(ip netip.Addr, in Info, fp, pin string) {
	r := l.r
	port := in.Port
	if port <= 0 {
		port = DefaultPort
	}
	ctx, cancel := context.WithTimeout(l.ctx, 2*time.Second)
	defer cancel()
	info, certFP, err := r.registerWith(ctx, ip.String(), port, pin, 2*time.Second)
	if err == nil {
		if certFP != "" {
			info.Fingerprint = certFP
		}
		if normFP(info.Fingerprint) != r.id.Fingerprint {
			r.noteDevice(info, info.Fingerprint, ip.String(), certFP != "")
		}
		return
	}
	if in.Announce && l.ctx.Err() == nil && l.mc != nil {
		if b, e := json.Marshal(r.selfInfo(false)); e == nil {
			_ = l.mc.WriteTo(b, multicastDest(ip))
		}
	}
}

// scanTarget is one address Scan registers with.
type scanTarget struct {
	host string
	port int
	pin  string
}

func (r *Runtime) scanTargets() []scanTarget {
	if r.scanTargetsFn != nil {
		return r.scanTargetsFn()
	}
	var out []scanTarget
	seen := map[string]bool{}
	r.mu.Lock()
	for _, d := range r.devs {
		if d.Address == "" || d.Protocol == "http" {
			continue
		}
		pin := ""
		if d.Stored {
			pin = d.Fingerprint
		}
		port := d.Port
		if port == 0 {
			port = DefaultPort
		}
		k := net.JoinHostPort(d.Address, strconv.Itoa(port))
		seen[k] = true
		out = append(out, scanTarget{host: d.Address, port: port, pin: pin})
	}
	r.mu.Unlock()
	for _, a := range subnetHosts(localAddrs(r.cfg.AllowLoopback), 1024) {
		k := net.JoinHostPort(a.String(), strconv.Itoa(DefaultPort))
		if seen[k] {
			continue
		}
		out = append(out, scanTarget{host: a.String(), port: DefaultPort})
	}
	return out
}

// Scan announces and scans the local subnets; results arrive as EventDevices.
// It blocks until the scan is done or ctx is cancelled, and never needs a listener.
func (r *Runtime) Scan(ctx context.Context) {
	if !r.scanning.CompareAndSwap(false, true) {
		return
	}
	defer r.scanning.Store(false)
	ctx, cancel := r.mergeCtx(ctx)
	defer cancel()

	if pc, err := r.openPacket(false); err == nil {
		r.announceOn(pc)
		_ = pc.Close()
	}
	targets := r.scanTargets()
	sem := make(chan struct{}, 64)
	var wg sync.WaitGroup
loop:
	for _, t := range targets {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			break loop
		}
		wg.Add(1)
		go func(t scanTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			info, certFP, err := r.registerWith(ctx, t.host, t.port, t.pin, time.Second)
			if err != nil {
				return
			}
			if certFP != "" {
				info.Fingerprint = certFP
			}
			if normFP(info.Fingerprint) == "" || normFP(info.Fingerprint) == r.id.Fingerprint {
				return
			}
			info.Port = t.port
			r.noteDevice(info, info.Fingerprint, t.host, certFP != "")
		}(t)
	}
	wg.Wait()
	r.emitDevicesIfChanged()
}

// AddByAddress registers with host:port (port 0 = DefaultPort) and returns that device.
func (r *Runtime) AddByAddress(ctx context.Context, host string, port int) (Device, error) {
	if port == 0 {
		port = DefaultPort
	}
	if port < 0 || port > 65535 {
		return Device{}, core.ValidationError("That port isn't valid", map[string]string{"port": "Use a number from 1 to 65535"})
	}
	ctx, cancel := r.mergeCtx(ctx)
	defer cancel()
	ip, err := r.resolveHost(ctx, host)
	if err != nil {
		return Device{}, err
	}
	info, certFP, err := r.registerWith(ctx, ip.String(), port, "", 3*time.Second)
	if err != nil {
		return Device{}, classifyErr(ctx, err, host)
	}
	if certFP == "" || certFP == r.id.Fingerprint {
		return Device{}, core.Errorf(CodeOffline, "That address is this computer").WithHint("Enter the address of your other device")
	}
	info.Port = port
	return r.noteDevice(info, certFP, ip.String(), true), nil
}

func (r *Runtime) resolveHost(ctx context.Context, host string) (netip.Addr, error) {
	bad := core.ValidationError("That address isn't on your local network", map[string]string{"host": "Use a local address like 192.168.1.20"})
	if host == "" {
		return netip.Addr{}, bad
	}
	if a, err := netip.ParseAddr(host); err == nil {
		a = a.Unmap().WithZone("")
		if !AllowedAddr(a, r.cfg.AllowLoopback) {
			return netip.Addr{}, bad
		}
		return a, nil
	}
	rctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupNetIP(rctx, "ip", host)
	if err != nil {
		return netip.Addr{}, core.Errorf(CodeOffline, "Couldn't find %s on this network", host).
			WithHint("Check the name or use its IP address").WithCause(err)
	}
	for _, a := range addrs {
		if a = a.Unmap().WithZone(""); AllowedAddr(a, r.cfg.AllowLoopback) {
			return a, nil
		}
	}
	return netip.Addr{}, bad
}

// Probe checks one device is reachable (POST /register to its last address) and refreshes it.
func (r *Runtime) Probe(ctx context.Context, fp string) (Device, error) {
	dev, ok := r.Device(fp)
	if !ok {
		return Device{}, core.Errorf(core.CodeNotFound, "That device isn't known")
	}
	if dev.Protocol == "http" {
		return Device{}, errEncryptionOff(dev.Alias)
	}
	if dev.Address == "" {
		return Device{}, errOffline(dev.Alias)
	}
	ctx, cancel := r.mergeCtx(ctx)
	defer cancel()
	port := dev.Port
	if port == 0 {
		port = DefaultPort
	}
	info, certFP, err := r.registerWith(ctx, dev.Address, port, dev.Fingerprint, 3*time.Second)
	if err != nil {
		return Device{}, classifyErr(ctx, err, dev.Alias)
	}
	_ = certFP
	info.Port = port
	return r.noteDevice(info, dev.Fingerprint, dev.Address, true), nil
}
