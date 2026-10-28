package exif

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"toolbox/core"
)

type jobRec struct {
	mu      sync.Mutex
	outputs []string
	result  json.RawMessage
	msg     string
	logs    []string
}

func (r *jobRec) job(t *testing.T, inputs []string, opts Options, outDir string) *core.JobContext {
	t.Helper()
	raw, _ := json.Marshal(opts)
	return core.NewJobContext(core.JobContext{
		ID: "j", ModuleID: ModuleID, Inputs: inputs, Options: raw, OutputDir: outDir, TempDir: t.TempDir(),
	}, core.JobHooks{
		Progress: func(_ float64, m string) { r.mu.Lock(); r.msg = m; r.mu.Unlock() },
		Log:      func(_ core.LogStream, l string) { r.mu.Lock(); r.logs = append(r.logs, l); r.mu.Unlock() },
		Output: func(p string) (core.Output, error) {
			if _, err := os.Stat(p); err != nil {
				return core.Output{}, err
			}
			r.mu.Lock()
			r.outputs = append(r.outputs, p)
			r.mu.Unlock()
			return core.Output{Path: p}, nil
		},
		Tool:   func(string) (string, error) { return os.Args[0], nil },
		Result: func(b json.RawMessage) { r.mu.Lock(); r.result = b; r.mu.Unlock() },
	})
}

func runSetup(t *testing.T) (m *Module, in, outDir, cmdlog string) {
	t.Helper()
	t.Setenv("FAKE_EXIF_JSON", fixture(t, "before.json"))
	t.Setenv("FAKE_EXIF_JSON_AFTER", fixture(t, "after.json"))
	cmdlog = filepath.Join(t.TempDir(), "cmds.txt")
	t.Setenv("FAKE_EXIF_LOG", cmdlog)
	m = fakeModule(t)
	dir := t.TempDir()
	in = filepath.Join(dir, "photo.jpg")
	if err := os.WriteFile(in, []byte("original-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	return m, in, filepath.Join(dir, "Metadata"), cmdlog
}

func commands(t *testing.T, log string) [][]string {
	t.Helper()
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	var out [][]string
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		out = append(out, strings.Split(l, "\x1f"))
	}
	return out
}

func TestRunActions(t *testing.T) {
	tests := []struct {
		name     string
		opts     Options
		suffix   string
		wantArgs []string // prefix of the write command
		msg      string
		removed  int
	}{
		{"strip location", Options{Action: ActionStripLocation}, " (no location)",
			[]string{"-gps:all=", "-xmp:geotag="}, "Removed 3 location tags", 3},
		{"strip all", Options{Action: ActionStripAll, KeepOrientation: true}, " (clean)",
			[]string{"-all=", "-tagsFromFile", "@", "-Orientation", "-ICC_Profile"}, "Removed 3 tags", 3},
		{"edit", Options{Action: ActionEdit, Fields: map[string]string{FieldTitle: "T", FieldArtist: "A"}}, " (edited)",
			[]string{"-XMP-dc:Title=T", "-IFD0:Artist=A", "-XMP-dc:Creator=A"}, "Updated 2 fields", 3},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m, in, outDir, cmdlog := runSetup(t)
			var rec jobRec
			if err := m.Run(context.Background(), rec.job(t, []string{in}, tc.opts, outDir)); err != nil {
				t.Fatal(err)
			}
			wantOut := filepath.Join(outDir, "photo"+tc.suffix+".jpg")
			if len(rec.outputs) != 1 || rec.outputs[0] != wantOut {
				t.Fatalf("outputs = %v, want %s", rec.outputs, wantOut)
			}
			var res Result
			if err := json.Unmarshal(rec.result, &res); err != nil {
				t.Fatal(err)
			}
			if res.Action != tc.opts.Action || res.Output != wantOut || res.RemovedTags != 3 {
				t.Errorf("result = %+v", res)
			}
			if rec.msg != tc.msg {
				t.Errorf("message = %q, want %q", rec.msg, tc.msg)
			}
			// Input untouched; output is a new file.
			if b, _ := os.ReadFile(in); !bytes.Equal(b, []byte("original-bytes")) {
				t.Error("input was modified")
			}
			cmds := commands(t, cmdlog)
			write := cmds[1]
			n := len(tc.wantArgs)
			if len(write) < n+5 || strings.Join(write[:n], "|") != strings.Join(tc.wantArgs, "|") {
				t.Fatalf("write command = %q", write)
			}
			tail := write[len(write)-4:]
			if tail[0] != "-o" || tail[1] != wantOut || tail[2] != in {
				// tail[3] is nothing: the command ends with the input path
				tail = write[len(write)-3:]
				if tail[0] != "-o" || tail[1] != wantOut || tail[2] != in {
					t.Errorf("tail = %q", tail)
				}
			}
			for _, c := range cmds {
				if strings.Contains(strings.Join(c, " "), "overwrite") {
					t.Errorf("overwrite flag in %q", c)
				}
			}
		})
	}
}

func TestRunUniqueOutputPaths(t *testing.T) {
	m, in, outDir, _ := runSetup(t)
	opts := Options{Action: ActionStripAll}
	var got []string
	for i := 0; i < 3; i++ {
		var rec jobRec
		if err := m.Run(context.Background(), rec.job(t, []string{in}, opts, outDir)); err != nil {
			t.Fatal(err)
		}
		got = append(got, filepath.Base(rec.outputs[0]))
	}
	want := []string{"photo (clean).jpg", "photo (clean) (1).jpg", "photo (clean) (2).jpg"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("outputs = %v, want %v", got, want)
			break
		}
	}
}

func TestRunNegativeDifferenceClampsToZero(t *testing.T) {
	m, in, outDir, _ := runSetup(t)
	// "After" has more tags than "before".
	t.Setenv("FAKE_EXIF_JSON", fixture(t, "after.json"))
	t.Setenv("FAKE_EXIF_JSON_AFTER", fixture(t, "before.json"))
	var rec jobRec
	if err := m.Run(context.Background(), rec.job(t, []string{in}, Options{Action: ActionStripLocation}, outDir)); err != nil {
		t.Fatal(err)
	}
	var res Result
	_ = json.Unmarshal(rec.result, &res)
	if res.RemovedTags != 0 || rec.msg != "Removed 0 location tags" {
		t.Errorf("result %+v msg %q", res, rec.msg)
	}
}

func TestRunToolFailureLeavesNothing(t *testing.T) {
	m, in, outDir, _ := runSetup(t)
	t.Setenv("FAKE_EXIF_FAIL", "1")
	var rec jobRec
	err := m.Run(context.Background(), rec.job(t, []string{in}, Options{Action: ActionStripAll}, outDir))
	var ae *core.AppError
	if !errors.As(err, &ae) || ae.Code != core.CodeToolFailed || !strings.Contains(ae.Hint, "Can't write this") {
		t.Fatalf("err = %v", err)
	}
	if ents, _ := os.ReadDir(outDir); len(ents) != 0 {
		t.Errorf("leftover outputs: %v", ents)
	}
	if len(rec.outputs) != 0 {
		t.Error("nothing should be registered")
	}
}

func TestRunRejectsRawAndMissingTool(t *testing.T) {
	m, _, outDir, _ := runSetup(t)
	var rec jobRec
	raw := filepath.Join(t.TempDir(), "x.dng")
	os.WriteFile(raw, []byte("x"), 0o644)
	if err := m.Run(context.Background(), rec.job(t, []string{raw}, Options{Action: ActionStripAll}, outDir)); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("raw: %v", err)
	}
	job := core.NewJobContext(core.JobContext{Inputs: []string{raw}, Options: json.RawMessage(`{"action":"strip-all"}`)}, core.JobHooks{})
	if err := m.Run(context.Background(), job); !core.IsCode(err, core.CodeDependencyMissing) {
		t.Errorf("missing tool: %v", err)
	}
}

func TestRunCancel(t *testing.T) {
	m, in, outDir, _ := runSetup(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var rec jobRec
	err := m.Run(ctx, rec.job(t, []string{in}, Options{Action: ActionStripAll}, outDir))
	if !core.IsCode(err, core.CodeCancelled) {
		t.Errorf("err = %v", err)
	}
}
