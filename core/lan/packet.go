package lan

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync"

	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

// realConn is the real multicast socket pair (IPv4 and IPv6, either may be missing).
type realConn struct {
	p4  *net.UDPConn
	p6  *net.UDPConn
	m4  *ipv4.PacketConn
	m6  *ipv6.PacketConn
	ifs []net.Interface

	in        chan datagram
	closed    chan struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup
}

type datagram struct {
	data []byte
	from string
}

// realPacket opens the multicast sockets. listen=true binds the multicast
// port (with address reuse, so a LocalSend app on this computer keeps working)
// and joins the group on every eligible interface; false opens ephemeral senders.
func realPacket(listen bool) (PacketConn, error) {
	c := &realConn{ifs: eligibleInterfaces(), in: make(chan datagram, 64), closed: make(chan struct{})}
	lc := net.ListenConfig{}
	laddr4, laddr6 := ":0", ":0"
	if listen {
		lc.Control = reuseControl
		laddr4 = ":" + strconv.Itoa(DefaultPort)
		laddr6 = laddr4
	}
	ctx := context.Background()
	if pc, err := lc.ListenPacket(ctx, "udp4", laddr4); err == nil {
		c.p4 = pc.(*net.UDPConn)
		c.m4 = ipv4.NewPacketConn(c.p4)
	}
	if pc, err := lc.ListenPacket(ctx, "udp6", laddr6); err == nil {
		c.p6 = pc.(*net.UDPConn)
		c.m6 = ipv6.NewPacketConn(c.p6)
	}
	if c.p4 == nil && c.p6 == nil {
		return nil, errors.New("couldn't open a network socket")
	}
	if listen {
		joined := false
		for i := range c.ifs {
			ifi := &c.ifs[i]
			if c.m4 != nil && c.m4.JoinGroup(ifi, &net.UDPAddr{IP: net.ParseIP(MulticastV4)}) == nil {
				joined = true
			}
			if c.m6 != nil && c.m6.JoinGroup(ifi, &net.UDPAddr{IP: net.ParseIP(MulticastV6)}) == nil {
				joined = true
			}
		}
		if !joined {
			c.Close()
			return nil, errors.New("no network interface could join the multicast group")
		}
		for _, pc := range []*net.UDPConn{c.p4, c.p6} {
			if pc == nil {
				continue
			}
			c.wg.Add(1)
			go c.readLoop(pc)
		}
	}
	return c, nil
}

func (c *realConn) readLoop(pc *net.UDPConn) {
	defer c.wg.Done()
	buf := make([]byte, 8192)
	for {
		n, from, err := pc.ReadFromUDPAddrPort(buf)
		if err != nil {
			select {
			case <-c.closed:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		d := datagram{data: append([]byte(nil), buf[:n]...), from: from.String()}
		select {
		case c.in <- d:
		case <-c.closed:
			return
		default: // a full queue drops datagrams
		}
	}
}

func (c *realConn) ReadFrom(b []byte) (int, string, error) {
	select {
	case d := <-c.in:
		return copy(b, d.data), d.from, nil
	case <-c.closed:
		return 0, "", net.ErrClosed
	}
}

func (c *realConn) WriteTo(b []byte, to string) error {
	ap, err := netip.ParseAddrPort(to)
	if err != nil {
		return err
	}
	dst := net.UDPAddrFromAddrPort(ap)
	var firstErr error
	note := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	switch {
	case ap.Addr().Is4() && c.p4 != nil:
		if ap.Addr().IsMulticast() {
			for i := range c.ifs {
				if c.m4.SetMulticastInterface(&c.ifs[i]) == nil {
					_, err := c.p4.WriteToUDP(b, dst)
					note(err)
				}
			}
		} else {
			_, err := c.p4.WriteToUDP(b, dst)
			note(err)
		}
	case ap.Addr().Is6() && c.p6 != nil:
		if ap.Addr().IsMulticast() {
			for i := range c.ifs {
				if c.m6.SetMulticastInterface(&c.ifs[i]) == nil {
					_, err := c.p6.WriteToUDP(b, dst)
					note(err)
				}
			}
		} else {
			_, err := c.p6.WriteToUDP(b, dst)
			note(err)
		}
	default:
		return errors.New("no socket for that address family")
	}
	return firstErr
}

func (c *realConn) Close() error {
	c.closeOnce.Do(func() {
		close(c.closed)
		if c.p4 != nil {
			c.p4.Close()
		}
		if c.p6 != nil {
			c.p6.Close()
		}
		c.wg.Wait()
	})
	return nil
}
