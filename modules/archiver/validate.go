package archiver

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"

	"toolbox/core"
)

const maxInputs = 50

// lookupAddrs resolves a host name; tests replace it.
var lookupAddrs = func(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// cgnat is 100.64.0.0/10 (carrier-grade NAT), treated as private.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// isLocalAddr reports loopback, private, link-local, unspecified and similar.
func isLocalAddr(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsMulticast() || a.IsUnspecified() || cgnat.Contains(a)
}

func isLocalName(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	return h == "localhost" || strings.HasSuffix(h, ".localhost")
}

const localMsg = "Local addresses are off. Turn on Allow local addresses to archive this"

// checkURL returns a user-facing problem with in, or "" when it is fine. It
// never resolves names; Run does that.
func checkURL(in string, allowLocal bool) string {
	s := strings.TrimSpace(in)
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || (u.Hostname() == "" && u.Scheme != "file") {
		return "Enter a valid http or https link"
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "Only http and https links can be archived"
	}
	if allowLocal {
		return ""
	}
	host := u.Hostname()
	if isLocalName(host) {
		return localMsg
	}
	if a, err := netip.ParseAddr(host); err == nil && isLocalAddr(a) {
		return localMsg
	}
	return ""
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	opts, err := core.DecodeOptionsJSON[Options](options)
	if err != nil {
		return err
	}
	opts = withDefaults(opts)
	fields := map[string]string{}

	if len(inputs) < 1 {
		fields["inputs"] = "Add at least one link"
	} else if len(inputs) > maxInputs {
		fields["inputs"] = fmt.Sprintf("At most %d links at a time", maxInputs)
	}
	for i, in := range inputs {
		if msg := checkURL(in, opts.AllowLocal); msg != "" {
			fields[fmt.Sprintf("inputs.%d", i)] = msg
		}
	}
	if opts.TimeoutSec < MinTimeoutSec || opts.TimeoutSec > MaxTimeoutSec {
		fields["timeoutSec"] = fmt.Sprintf("Choose a timeout between %d and %d seconds", MinTimeoutSec, MaxTimeoutSec)
	}
	if len(fields) > 0 {
		return core.ValidationError("Check the highlighted fields", fields)
	}
	if opts.RenderJS || opts.AlsoPDF {
		if p, _ := m.browser(); p == "" {
			key := "renderJs"
			if !opts.RenderJS {
				key = "alsoPdf"
			}
			return core.ValidationError("No browser found", map[string]string{key: "Needs Microsoft Edge or Google Chrome"}).
				WithHint(browserHint())
		}
	}
	return nil
}

// checkResolved refuses hosts that resolve to local addresses.
func (m *Module) checkResolved(ctx context.Context, rawURL string, allowLocal bool) error {
	if allowLocal {
		return nil
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return fmt.Errorf("parse url: %w", err)
	}
	host := u.Hostname()
	if _, err := netip.ParseAddr(host); err == nil {
		return nil // literals were checked by checkURL
	}
	addrs, err := m.lookup(ctx, host)
	if err != nil {
		return core.Errorf(core.CodeToolFailed, "Couldn't find %s", host).
			WithHint("Check the link and your connection").WithCause(err)
	}
	for _, a := range addrs {
		if isLocalAddr(a) {
			return core.Errorf(core.CodeValidation, "%s points to a local address", host).
				WithHint("Turn on Allow local addresses to archive pages on your own network")
		}
	}
	return nil
}
