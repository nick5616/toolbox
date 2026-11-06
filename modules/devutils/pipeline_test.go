package devutils

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"toolbox/core"
)

// stepJob runs a job of the module with an output folder and returns the
// registered outputs and the result.
func stepJob(t *testing.T, inputs []string, o Options) (outs []string, result json.RawMessage, err error) {
	t.Helper()
	b, _ := json.Marshal(o)
	dir := t.TempDir()
	job := core.NewJobContext(core.JobContext{Inputs: inputs, Options: b, OutputDir: dir}, core.JobHooks{
		Output: func(p string) (core.Output, error) {
			outs = append(outs, p)
			return core.Output{ID: "o" + filepath.Base(p), Path: p, Name: filepath.Base(p), Kind: core.KindForPath(p)}, nil
		},
		Result: func(r json.RawMessage) { result = r },
	})
	err = (&Module{}).Run(context.Background(), job)
	return outs, result, err
}

func TestDescribeStep(t *testing.T) {
	m := &Module{}
	tests := []struct {
		name, opts, summary, ext, wantErr string
	}{
		{"defaults", `{}`, "SHA256 · SHA1 · MD5", ".sha256", ""},
		{"csv", `{"format":"csv"}`, "SHA256 · SHA1 · MD5 · CSV", ".csv", ""},
		{"encode base64", `{"action":"encode"}`, "Base64 · files up to 10 MiB", ".base64.txt", ""},
		{"encode hex", `{"action":"encode","encoding":"hex"}`, "Hex · files up to 10 MiB", ".hex.txt", ""},
		{"unknown action", `{"action":"x"}`, "", "", "Unknown action"},
		{"unknown algo", `{"algorithms":["sha3"]}`, "", "", "Unknown algorithm"},
		{"no algos", `{"algorithms":[]}`, "", "", "at least one"},
		{"bad format", `{"format":"xml"}`, "", "", ".sha256 file or a CSV"},
		{"bad encoding", `{"action":"encode","encoding":"rot13"}`, "", "", "Base64 or hex"},
		{"unknown option", `{"nope":1}`, "", "", "Invalid"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			info, err := m.DescribeStep(json.RawMessage(tc.opts))
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if info.Summary != tc.summary || len(info.Produces) != 1 || info.Produces[0].Exts[0] != tc.ext {
				t.Errorf("info = %+v", info)
			}
			if !info.Accepts.Any {
				t.Error("a Dev Utilities step reads any file")
			}
		})
	}
	info, _ := m.DescribeStep(json.RawMessage(`{}`))
	names := ""
	for _, v := range info.Vars {
		names += v.Name + " "
	}
	if names != "sha256 sha1 md5 " {
		t.Errorf("vars = %q", names)
	}
}

func TestPrepareStep(t *testing.T) {
	m := &Module{}
	a := writeFile(t, "a.txt", []byte("abc"))
	b := writeFile(t, "b.txt", []byte("abc"))
	files := []core.RunFile{{Path: a}, {Path: b}}
	jobs, err := m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"name":"{item} sums"}`),
		Item:    core.StepItem{Files: files, Vars: map[string]string{"item": "Trip"}},
	})
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %v, %v", jobs, err)
	}
	o := jobs[0].Options.(Options)
	if o.Action != ActionChecksums || o.Name != "Trip sums" || len(jobs[0].Inputs) != 2 || len(o.Algorithms) != 3 {
		t.Errorf("job = %+v %+v", jobs[0].Inputs, o)
	}
	raw, _ := json.Marshal(o)
	if err := m.Validate(jobs[0].Inputs, raw); err != nil {
		t.Errorf("the prepared job doesn't validate: %v", err)
	}

	// More than 100 files split into jobs of 100.
	many := make([]core.RunFile, 0, 205)
	for range 205 {
		many = append(many, core.RunFile{Path: a})
	}
	jobs, err = m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{}`), Item: core.StepItem{Files: many}})
	if err != nil || len(jobs) != 3 {
		t.Fatalf("205 files -> %d jobs, %v", len(jobs), err)
	}

	// Encode refuses a file over the cap, by name.
	big := writeFile(t, "big.bin", make([]byte, maxBase64Bytes+1))
	_, err = m.PrepareStep(context.Background(), core.StepRequest{
		Options: json.RawMessage(`{"action":"encode"}`), Item: core.StepItem{Files: []core.RunFile{{Path: big}}},
	})
	if err == nil || !strings.Contains(err.Error(), "big.bin is larger than 10 MiB") {
		t.Errorf("err = %v", err)
	}
	if _, err := m.PrepareStep(context.Background(), core.StepRequest{Options: json.RawMessage(`{}`)}); err == nil {
		t.Error("no files should fail")
	}
}

func TestChecksumsSidecarAndCSV(t *testing.T) {
	empty := writeFile(t, "empty", nil)
	abc := writeFile(t, "abc.txt", []byte("abc"))

	outs, result, err := stepJob(t, []string{empty, abc}, Options{
		Action: ActionChecksums, Format: FormatSidecar, Algorithms: []string{AlgoSHA256, AlgoMD5}, Name: "sums",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(outs) != 2 || filepath.Base(outs[0]) != "sums.sha256" || filepath.Base(outs[1]) != "sums.md5" {
		t.Fatalf("outputs = %v", outs)
	}
	b, _ := os.ReadFile(outs[0])
	want := vectors[""][AlgoSHA256] + "  empty\n" + vectors["abc"][AlgoSHA256] + "  abc.txt\n" // sha256sum -c format
	if string(b) != want {
		t.Errorf("sidecar =\n%q\nwant\n%q", b, want)
	}
	var res Result
	if err := json.Unmarshal(result, &res); err != nil || len(res.Files) != 2 {
		t.Fatalf("result = %s, %v", result, err)
	}

	outs, _, err = stepJob(t, []string{abc}, Options{Action: ActionChecksums, Format: FormatCSV, Algorithms: []string{AlgoSHA256, AlgoSHA1, AlgoMD5}})
	if err != nil || len(outs) != 1 || filepath.Base(outs[0]) != "abc.txt.csv" {
		t.Fatalf("csv outputs = %v, %v", outs, err)
	}
	b, _ = os.ReadFile(outs[0])
	want = "file,size,sha256,sha1,md5\nabc.txt,3," + vectors["abc"][AlgoSHA256] + "," + vectors["abc"][AlgoSHA1] + "," + vectors["abc"][AlgoMD5] + "\n"
	if string(b) != want {
		t.Errorf("csv = %q, want %q", b, want)
	}

	// A single file's sidecar is named after the file.
	outs, _, err = stepJob(t, []string{abc}, Options{Action: ActionChecksums, Algorithms: []string{AlgoSHA256}})
	if err != nil || filepath.Base(outs[0]) != "abc.txt.sha256" {
		t.Fatalf("auto name = %v, %v", outs, err)
	}
}

func TestEncodeHexAndBase64(t *testing.T) {
	p := writeFile(t, "note.txt", []byte("hello"))
	outs, _, err := stepJob(t, []string{p}, Options{Action: ActionEncode, Encoding: EncodingBase64})
	if err != nil || len(outs) != 1 || filepath.Base(outs[0]) != "note.txt.base64.txt" {
		t.Fatalf("base64 = %v, %v", outs, err)
	}
	if b, _ := os.ReadFile(outs[0]); string(b) != "aGVsbG8=" {
		t.Errorf("base64 = %q", b)
	}
	outs, _, err = stepJob(t, []string{p}, Options{Action: ActionEncode, Encoding: EncodingHex})
	if err != nil || filepath.Base(outs[0]) != "note.txt.hex.txt" {
		t.Fatalf("hex = %v, %v", outs, err)
	}
	if b, _ := os.ReadFile(outs[0]); string(b) != "68656c6c6f" {
		t.Errorf("hex = %q", b)
	}
	big := writeFile(t, "big.bin", make([]byte, maxBase64Bytes+1))
	if _, _, err := stepJob(t, []string{big}, Options{Action: ActionEncode}); err == nil || !strings.Contains(err.Error(), "10 MiB") {
		t.Errorf("over the cap: %v", err)
	}
}

func TestStepOutputsRolesAndVars(t *testing.T) {
	m := &Module{}
	opts, _ := json.Marshal(Options{Action: ActionChecksums})
	res, _ := json.Marshal(Result{Files: []FileHashes{{Path: "x", Hashes: map[string]string{AlgoSHA256: "aa", AlgoMD5: "bb"}}}})
	out, err := m.StepOutputs(core.Job{
		OptionsJSON: string(opts), ResultJSON: string(res),
		Outputs: []core.Output{{ID: "1", Path: filepath.Join("d", "x.sha256"), Name: "x.sha256", Kind: core.KindOther}},
	})
	if err != nil || len(out.Files) != 1 || out.Files[0].Role != "checksums" || out.Files[0].OutputID != "1" {
		t.Fatalf("out = %+v, %v", out, err)
	}
	if out.Vars["sha256"] != "aa" || out.Vars["md5"] != "bb" {
		t.Errorf("vars = %v", out.Vars)
	}
	// Several files: no single digest to expose.
	res, _ = json.Marshal(Result{Files: []FileHashes{{Hashes: map[string]string{AlgoMD5: "1"}}, {Hashes: map[string]string{AlgoMD5: "2"}}}})
	out, _ = m.StepOutputs(core.Job{OptionsJSON: string(opts), ResultJSON: string(res)})
	if len(out.Vars) != 0 {
		t.Errorf("vars for two files = %v", out.Vars)
	}
	opts, _ = json.Marshal(Options{Action: ActionEncode})
	out, _ = m.StepOutputs(core.Job{OptionsJSON: string(opts), Outputs: []core.Output{{Path: "a.base64.txt"}}})
	if out.Files[0].Role != "encoded" {
		t.Errorf("encode role = %q", out.Files[0].Role)
	}
}

func TestHashActionStillWorksWithoutAnAction(t *testing.T) {
	abc := writeFile(t, "abc", []byte("abc"))
	outs, result, err := stepJob(t, []string{abc}, Options{Algorithms: []string{AlgoSHA256}})
	if err != nil || len(outs) != 0 || len(result) == 0 {
		t.Fatalf("hash: outs=%v result=%s err=%v", outs, result, err)
	}
}
