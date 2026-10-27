package downloader

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"toolbox/core"
)

func TestParseTimecode(t *testing.T) {
	tests := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"0", 0, true},
		{"5", 5, true},
		{"59.5", 59.5, true},
		{"125", 125, true},
		{"0:59.5", 59.5, true},
		{"1:05", 65, true},
		{"12:34", 754, true},
		{"1:02:03.5", 3723.5, true},
		{"01:02:03", 3723, true},
		{"1:60", 0, false},
		{"1:5", 0, false},
		{"1:02:60", 0, false},
		{"1:60:00", 0, false},
		{"", 0, false},
		{"abc", 0, false},
		{"-5", 0, false},
		{"1:2:3:4", 0, false},
		{"5.", 0, false},
		{".5", 0, false},
		{"1.5:30", 0, false},
		{"1::30", 0, false},
	}
	for _, tc := range tests {
		got, err := ParseTimecode(tc.in)
		if (err == nil) != tc.ok {
			t.Errorf("ParseTimecode(%q) err = %v, want ok=%v", tc.in, err, tc.ok)
			continue
		}
		if tc.ok && got != tc.want {
			t.Errorf("ParseTimecode(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func optsJSON(t *testing.T, mut func(*Options)) json.RawMessage {
	t.Helper()
	o := DefaultOptions()
	if mut != nil {
		mut(&o)
	}
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func fieldsOf(t *testing.T, err error) map[string]string {
	t.Helper()
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
		t.Fatalf("want validation error, got %v", err)
	}
	return ae.Fields
}

func TestValidateInputs(t *testing.T) {
	m := &Module{}
	good := []string{"https://www.youtube.com/watch?v=jNQXAC9IVRw", "http://example.com/a"}
	if err := m.Validate(good, optsJSON(t, nil)); err != nil {
		t.Fatalf("good inputs: %v", err)
	}
	if err := m.Validate(good, nil); err == nil {
		t.Fatal("nil options should fail enum validation (zero values)")
	}

	f := fieldsOf(t, m.Validate([]string{"https://ok.com/x", "ftp://x.com/a", "not a url", "https:///nohost", ""}, optsJSON(t, nil)))
	if _, ok := f["inputs.0"]; ok {
		t.Error("inputs.0 should be valid")
	}
	for _, k := range []string{"inputs.1", "inputs.2", "inputs.3", "inputs.4"} {
		if f[k] == "" {
			t.Errorf("missing error for %s: %v", k, f)
		}
	}

	if f := fieldsOf(t, m.Validate(nil, optsJSON(t, nil))); f["inputs"] == "" {
		t.Errorf("empty inputs: %v", f)
	}
	many := make([]string, 51)
	for i := range many {
		many[i] = fmt.Sprintf("https://example.com/%d", i)
	}
	if f := fieldsOf(t, m.Validate(many, optsJSON(t, nil))); f["inputs"] == "" {
		t.Errorf("51 inputs: %v", f)
	}
	if err := m.Validate(many[:50], optsJSON(t, nil)); err != nil {
		t.Errorf("50 inputs should pass: %v", err)
	}
}

func TestValidateEnumsAndDecode(t *testing.T) {
	m := &Module{}
	in := []string{"https://example.com/a"}
	f := fieldsOf(t, m.Validate(in, optsJSON(t, func(o *Options) {
		o.Mode, o.AudioFormat, o.AudioQuality, o.MaxResolution = "x", "ogg", "64", "999"
	})))
	for _, k := range []string{"mode", "audioFormat", "audioQuality", "maxResolution"} {
		if f[k] == "" {
			t.Errorf("missing %s error: %v", k, f)
		}
	}
	err := m.Validate(in, json.RawMessage(`{"bogus":1}`))
	if !core.IsCode(err, core.CodeValidation) {
		t.Errorf("unknown field: %v", err)
	}
}

func TestValidateTrim(t *testing.T) {
	m := &Module{}
	in := []string{"https://example.com/a"}
	tests := []struct {
		name       string
		start, end string
		wantField  string // "" = valid
	}{
		{"neither", "", "", "trimStart"},
		{"start only", "0:05", "", ""},
		{"end only", "", "0:12", ""},
		{"both", "0:05", "0:12", ""},
		{"fractional", "0:59.5", "1:02:03.5", ""},
		{"end equals start", "0:05", "0:05", "trimEnd"},
		{"end before start", "1:00", "0:30", "trimEnd"},
		{"end zero no start", "", "0", "trimEnd"},
		{"bad start", "1:60", "", "trimStart"},
		{"bad end", "0:05", "x", "trimEnd"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(in, optsJSON(t, func(o *Options) {
				o.TrimEnabled, o.TrimStart, o.TrimEnd = true, tc.start, tc.end
			}))
			if tc.wantField == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if f := fieldsOf(t, err); f[tc.wantField] == "" {
				t.Fatalf("want error on %s, got %v", tc.wantField, f)
			}
		})
	}
	// Trim disabled: garbage times are ignored.
	if err := m.Validate(in, optsJSON(t, func(o *Options) { o.TrimStart = "zzz" })); err != nil {
		t.Errorf("trim disabled should ignore times: %v", err)
	}
	_ = strings.TrimSpace
}
