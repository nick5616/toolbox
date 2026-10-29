package devutils

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

var vectors = map[string]map[string]string{
	"": {
		AlgoMD5:    "d41d8cd98f00b204e9800998ecf8427e",
		AlgoSHA1:   "da39a3ee5e6b4b0d3255bfef95601890afd80709",
		AlgoSHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		AlgoSHA512: "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
		AlgoCRC32:  "00000000",
	},
	"abc": {
		AlgoMD5:    "900150983cd24fb0d6963f7d28e17f72",
		AlgoSHA1:   "a9993e364706816aba3e25717850c26c9cd0d89d",
		AlgoSHA256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		AlgoSHA512: "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
		AlgoCRC32:  "352441c2",
	},
}

type rec struct {
	title    string
	progress []float64
	result   json.RawMessage
}

func (r *rec) job(inputs []string, opts string) *core.JobContext {
	return core.NewJobContext(core.JobContext{Inputs: inputs, Options: json.RawMessage(opts)}, core.JobHooks{
		Progress: func(p float64, _ string) { r.progress = append(r.progress, p) },
		Title:    func(t string) { r.title = t },
		Result:   func(b json.RawMessage) { r.result = b },
	})
}

func writeFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func allOpts() string {
	b, _ := json.Marshal(Options{Algorithms: AllAlgorithms()})
	return string(b)
}

func TestRunVectors(t *testing.T) {
	empty := writeFile(t, "empty", nil)
	abc := writeFile(t, "abc", []byte("abc"))
	r := &rec{}
	if err := (&Module{}).Run(context.Background(), r.job([]string{empty, abc}, allOpts())); err != nil {
		t.Fatal(err)
	}
	if r.title != "Hashing 2 files" {
		t.Errorf("title = %q", r.title)
	}
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 2 {
		t.Fatalf("files = %d", len(res.Files))
	}
	for i, in := range []string{"", "abc"} {
		for algo, want := range vectors[in] {
			if got := res.Files[i].Hashes[algo]; got != want {
				t.Errorf("%q %s = %s, want %s", in, algo, got, want)
			}
		}
	}
	if res.Files[1].Size != 3 {
		t.Errorf("size = %d", res.Files[1].Size)
	}
	if last := r.progress[len(r.progress)-1]; last != 1 {
		t.Errorf("final progress = %v", last)
	}
}

func TestRunLargeMatchesHashText(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789abcdef"), 3<<16) // 3 MiB
	p := writeFile(t, "big", data)
	r := &rec{}
	if err := (&Module{}).Run(context.Background(), r.job([]string{p}, allOpts())); err != nil {
		t.Fatal(err)
	}
	var res Result
	if err := json.Unmarshal(r.result, &res); err != nil {
		t.Fatal(err)
	}
	for _, h := range hashText(string(data)) {
		if res.Files[0].Hashes[h.Algorithm] != h.Hex {
			t.Errorf("%s = %s, want %s", h.Algorithm, res.Files[0].Hashes[h.Algorithm], h.Hex)
		}
	}
	if res.Files[0].Size != int64(len(data)) {
		t.Errorf("size = %d", res.Files[0].Size)
	}
}

func TestHashTextVectors(t *testing.T) {
	for in, m := range vectors {
		got := hashText(in)
		if len(got) != 5 {
			t.Fatalf("len = %d", len(got))
		}
		for i, a := range AllAlgorithms() {
			if got[i].Algorithm != a || got[i].Hex != m[a] {
				t.Errorf("%q %s = %+v, want %s", in, a, got[i], m[a])
			}
		}
	}
}

func TestRunCancel(t *testing.T) {
	p := writeFile(t, "big", make([]byte, 4<<20))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var result json.RawMessage
	job := core.NewJobContext(core.JobContext{Inputs: []string{p}, Options: json.RawMessage(allOpts())}, core.JobHooks{
		Progress: func(pct float64, _ string) {
			if pct > 0 {
				cancel() // cancel after the first chunk
			}
		},
		Result: func(b json.RawMessage) { result = b },
	})
	err := (&Module{}).Run(ctx, job)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if result != nil {
		t.Error("result set after cancel")
	}
}

func TestValidate(t *testing.T) {
	f := writeFile(t, "a", []byte("x"))
	dir := t.TempDir()
	tooMany := make([]string, 101)
	for i := range tooMany {
		tooMany[i] = f
	}
	tests := []struct {
		name   string
		inputs []string
		opts   string
		want   string
	}{
		{"ok default", []string{f}, `{"algorithms":["sha256"]}`, ""},
		{"ok all", []string{f}, allOpts(), ""},
		{"no inputs", nil, ``, "at least one file"},
		{"too many", tooMany, `{"algorithms":["md5"]}`, "At most 100"},
		{"missing", []string{filepath.Join(dir, "nope")}, `{"algorithms":["md5"]}`, "can't be hashed"},
		{"directory", []string{dir}, `{"algorithms":["md5"]}`, "can't be hashed"},
		{"no algos", []string{f}, `{"algorithms":[]}`, "invalid"},
		{"unknown algo", []string{f}, `{"algorithms":["sha3"]}`, "invalid"},
		{"duplicate", []string{f}, `{"algorithms":["md5","md5"]}`, "invalid"},
		{"unknown option", []string{f}, `{"nope":1}`, "nope"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := (&Module{}).Validate(tc.inputs, json.RawMessage(tc.opts))
			if tc.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want containing %q", err, tc.want)
			}
		})
	}
}

func TestFileBase64(t *testing.T) {
	p := writeFile(t, "a", []byte("hello"))
	got, err := fileBase64(p)
	if err != nil || got != "aGVsbG8=" {
		t.Fatalf("got %q, %v", got, err)
	}
	at := writeFile(t, "at", make([]byte, maxBase64Bytes))
	if _, err := fileBase64(at); err != nil {
		t.Errorf("exactly 10 MiB should pass: %v", err)
	}
	over := writeFile(t, "over", make([]byte, maxBase64Bytes+1))
	_, err = fileBase64(over)
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeValidation {
		t.Fatalf("err = %v, want validation error", err)
	}
	if _, err := fileBase64(filepath.Join(t.TempDir(), "none")); err == nil {
		t.Error("missing file should fail")
	}
}
