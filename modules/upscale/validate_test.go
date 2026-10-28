package upscale

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"toolbox/core"
)

func rawOpts(t *testing.T, o Options) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestValidate(t *testing.T) {
	dir := t.TempDir()
	small := filepath.Join(dir, "small.png")
	writePNG(t, small, 8, 6, false)
	huge := filepath.Join(dir, "huge.png") // 5000×4000 = 20 MP: ok at 2× (80 MP), too big at 4×
	writeHugePNGHeader(t, huge, 5000, 4000)
	cpuBig := filepath.Join(dir, "cpubig.png") // 1700×1300 = 2.2 MP
	writeHugePNGHeader(t, cpuBig, 1700, 1300)
	garbage := filepath.Join(dir, "garbage.png")
	os.WriteFile(garbage, []byte("not an image"), 0o644)
	heic := filepath.Join(dir, "IMG.heic")
	os.WriteFile(heic, []byte("heic"), 0o644)
	txt := filepath.Join(dir, "a.txt")
	os.WriteFile(txt, []byte("x"), 0o644)

	def := DefaultOptions()
	with := func(f func(*Options)) Options { o := def; f(&o); return o }
	m := &Module{}

	tests := []struct {
		name     string
		inputs   []string
		opts     Options
		wantErr  bool
		wantMsg  string // top-level message when non-empty
		wantKeys []string
	}{
		{"ok", []string{small}, def, false, "", nil},
		{"heic skips the size check", []string{heic}, with(func(o *Options) { o.Device = DeviceCPU }), false, "", nil},
		{"over 100 MP at 4x", []string{huge}, def, true,
			"Too large to upscale 4× (5000×4000 → 20000×16000); try 2× or a smaller image", []string{"inputs.0"}},
		{"same image ok at 2x", []string{huge}, with(func(o *Options) { o.Scale = 2 }), false, "", nil},
		{"cpu cap", []string{cpuBig}, with(func(o *Options) { o.Device = DeviceCPU }), true,
			"Too large for CPU upscaling (max 2 megapixels); use the GPU or a smaller image", []string{"inputs.0"}},
		{"cpu cap not applied on auto", []string{cpuBig}, def, false, "", nil},
		{"undecodable", []string{garbage}, def, true, "Couldn't read this image", []string{"inputs.0"}},
		{"several bad", []string{garbage, huge, small}, def, true, "Some files can't be upscaled", []string{"inputs.0", "inputs.1"}},
		{"unsupported type", []string{txt}, def, true, "", []string{"inputs.0"}},
		{"no inputs", nil, def, true, "", []string{"inputs"}},
		{"bad scale", []string{small}, with(func(o *Options) { o.Scale = 3 }), true, "", []string{"scale"}},
		{"bad model", []string{small}, with(func(o *Options) { o.Model = "x" }), true, "", []string{"model"}},
		{"bad format", []string{small}, with(func(o *Options) { o.Format = "gif" }), true, "", []string{"format"}},
		{"bad device", []string{small}, with(func(o *Options) { o.Device = "tpu" }), true, "", []string{"device"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := m.Validate(tc.inputs, rawOpts(t, tc.opts))
			if !tc.wantErr {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			ae := appErr(t, err, core.CodeValidation, tc.wantMsg)
			for _, k := range tc.wantKeys {
				if ae.Fields[k] == "" {
					t.Errorf("fields %v missing %s", ae.Fields, k)
				}
			}
		})
	}
	t.Run("empty options mean defaults", func(t *testing.T) {
		if err := m.Validate([]string{small}, json.RawMessage(`{"model":"photo","scale":2,"format":"same"}`)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("unknown option field", func(t *testing.T) {
		appErr(t, m.Validate([]string{small}, json.RawMessage(`{"nope":1}`)), core.CodeValidation, "")
	})
}

func TestDescriptor(t *testing.T) {
	d := (&Module{}).Descriptor()
	if d.ID != "upscaler" || !d.SplitInputs || d.MaxConcurrent != 1 || len(d.Requires) != 1 || d.Requires[0] != "upscayl" {
		t.Errorf("%+v", d)
	}
}
