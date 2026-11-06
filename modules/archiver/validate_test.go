package archiver

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"testing"

	"toolbox/core"
)

func TestCheckURL(t *testing.T) {
	tests := []struct {
		in    string
		local bool
		bad   bool
	}{
		{"https://example.com/a?b=1", false, false},
		{"http://example.com", false, false},
		{"  https://example.com  ", false, false},
		{"https://[2606:4700::1111]/", false, false},
		{"https://8.8.8.8/", false, false},
		{"file:///etc/passwd", false, true},
		{"file:///etc/passwd", true, true},
		{"ftp://example.com/", false, true},
		{"javascript:alert(1)", false, true},
		{"example.com", false, true},
		{"", false, true},
		{"https://", false, true},
		{"http://localhost:8080/", false, true},
		{"http://LOCALHOST/", false, true},
		{"http://app.localhost/", false, true},
		{"http://127.0.0.1/", false, true},
		{"http://127.1.2.3:9/", false, true},
		{"http://10.0.0.5/", false, true},
		{"http://172.16.0.1/", false, true},
		{"http://172.32.0.1/", false, false},
		{"http://192.168.1.1/", false, true},
		{"http://169.254.169.254/latest", false, true},
		{"http://100.64.0.1/", false, true},
		{"http://0.0.0.0/", false, true},
		{"http://[::1]/", false, true},
		{"http://[fe80::1]/", false, true},
		{"http://[fd00::1]/", false, true},
		{"http://[::ffff:127.0.0.1]/", false, true},
		{"http://localhost:8080/", true, false},
		{"http://127.0.0.1/", true, false},
		{"http://192.168.1.1/", true, false},
	}
	for _, tc := range tests {
		got := checkURL(tc.in, tc.local)
		if (got != "") != tc.bad {
			t.Errorf("checkURL(%q, local=%v) = %q, want bad=%v", tc.in, tc.local, got, tc.bad)
		}
	}
}

func opts(o Options) json.RawMessage {
	b, _ := json.Marshal(o)
	return b
}

func TestValidate(t *testing.T) {
	m := New()
	m.browser = func() (string, string) { return "", "" }
	good := DefaultOptions()

	if err := m.Validate([]string{"https://example.com"}, opts(good)); err != nil {
		t.Fatalf("good input: %v", err)
	}
	// Partial option JSON keeps the default timeout.
	if err := m.Validate([]string{"https://example.com"}, json.RawMessage(`{"noJs":true}`)); err != nil {
		t.Fatalf("partial options: %v", err)
	}
	cases := []struct {
		name   string
		inputs []string
		o      Options
		field  string
	}{
		{"none", nil, good, "inputs"},
		{"file url", []string{"file:///x"}, good, "inputs.0"},
		{"private", []string{"https://example.com", "http://10.1.1.1"}, good, "inputs.1"},
		{"timeout low", []string{"https://example.com"}, Options{TimeoutSec: 5}, "timeoutSec"},
		{"timeout high", []string{"https://example.com"}, Options{TimeoutSec: 301}, "timeoutSec"},
		{"too many", make([]string, maxInputs+1), good, "inputs.0"},
		{"render without browser", []string{"https://example.com"}, Options{RenderJS: true, TimeoutSec: 60}, "renderJs"},
		{"pdf without browser", []string{"https://example.com"}, Options{AlsoPDF: true, TimeoutSec: 60}, "alsoPdf"},
	}
	for _, tc := range cases {
		err := m.Validate(tc.inputs, opts(tc.o))
		ae := core.AsAppError(err)
		if ae == nil {
			t.Errorf("%s: want validation error, got %v", tc.name, err)
			continue
		}
		if _, ok := ae.Fields[tc.field]; !ok {
			t.Errorf("%s: fields %v lack %q", tc.name, ae.Fields, tc.field)
		}
		if strings.HasPrefix(tc.name, "render") || strings.HasPrefix(tc.name, "pdf") {
			if ae.Hint == "" {
				t.Errorf("%s: want a hint", tc.name)
			}
		}
	}

	// AllowLocal opens loopback.
	if err := m.Validate([]string{"http://127.0.0.1:8080/"}, opts(Options{TimeoutSec: 60, AllowLocal: true})); err != nil {
		t.Errorf("allow local: %v", err)
	}
	// A browser makes the toggles valid.
	m.browser = func() (string, string) { return "/b", "B" }
	if err := m.Validate([]string{"https://example.com"}, opts(Options{RenderJS: true, AlsoPDF: true, TimeoutSec: 60})); err != nil {
		t.Errorf("with browser: %v", err)
	}
	// Unknown fields are rejected.
	if err := m.Validate([]string{"https://example.com"}, json.RawMessage(`{"bogus":1}`)); err == nil {
		t.Error("unknown field accepted")
	}
}

func TestCheckResolved(t *testing.T) {
	m := New()
	m.lookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		switch host {
		case "public.test":
			return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
		case "internal.test":
			return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("10.0.0.7")}, nil
		case "mapped.test":
			return []netip.Addr{netip.MustParseAddr("::ffff:127.0.0.1")}, nil
		}
		return nil, errors.New("no such host")
	}
	ctx := context.Background()
	if err := m.checkResolved(ctx, "https://public.test/", false); err != nil {
		t.Errorf("public: %v", err)
	}
	for _, h := range []string{"internal.test", "mapped.test", "missing.test"} {
		if err := m.checkResolved(ctx, "https://"+h+"/", false); err == nil {
			t.Errorf("%s: want error", h)
		}
	}
	if err := m.checkResolved(ctx, "https://internal.test/", true); err != nil {
		t.Errorf("allow local: %v", err)
	}
}
