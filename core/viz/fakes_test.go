package viz

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// fakeEngine is a sidecar.Caller that writes canned engine outputs.
type fakeEngine struct {
	mu       sync.Mutex
	calls    []string
	params   map[string]map[string]any
	handlers map[string]func(ctx context.Context, p map[string]any, emit func(sidecar.Event)) (any, error)
}

func newFakeEngine(t *testing.T) *fakeEngine {
	e := &fakeEngine{params: map[string]map[string]any{}}
	e.handlers = map[string]func(context.Context, map[string]any, func(sidecar.Event)) (any, error){
		"stems.separate": func(_ context.Context, p map[string]any, emit func(sidecar.Event)) (any, error) {
			dir, base := p["outputDir"].(string), p["baseName"].(string)
			emit(sidecar.Event{Kind: "progress", Pct: 0.5, Msg: "Separating"})
			var stems []map[string]string
			for _, n := range []string{"Vocals", "Drums", "Bass", "Other"} {
				path := filepath.Join(dir, fmt.Sprintf("%s - %s.flac", base, n))
				if err := os.WriteFile(path, []byte(n), 0o644); err != nil {
					return nil, err
				}
				stems = append(stems, map[string]string{"name": n, "path": path})
			}
			return map[string]any{"stems": stems, "model": p["model"]}, nil
		},
		"viz.analyze": func(_ context.Context, p map[string]any, _ func(sidecar.Event)) (any, error) {
			return nil, writeFeatures(p["outDir"].(string), p["name"].(string), p["stems"] != nil)
		},
		"transcribe.run": func(_ context.Context, p map[string]any, _ func(sidecar.Event)) (any, error) {
			out := filepath.Join(p["outputDir"].(string), "lyrics.json")
			doc := `{"language":"en","segments":[
			 {"start":1,"end":3,"text":"We were burning","words":[{"start":1,"end":1.3,"word":" We"},{"start":1.4,"end":1.8,"word":" were"},{"start":2,"end":3,"word":" burning"}]},
			 {"start":5,"end":7,"text":"bright tonight","words":[{"start":5,"end":5.5,"word":" bright"},{"start":5.6,"end":7,"word":" tonight"}]}]}`
			return map[string]any{"outputs": []string{out}}, os.WriteFile(out, []byte(doc), 0o644)
		},
		"viz.mood": func(_ context.Context, p map[string]any, _ func(sidecar.Event)) (any, error) {
			n := len(p["lines"].([]any))
			var ls []map[string]any
			for i := 0; i < n; i++ {
				ls = append(ls, map[string]any{"emotion": "joy", "confidence": 0.8, "valence": 0.8, "energy": 0.8, "motifs": []string{"fire"}})
			}
			return map[string]any{"lines": ls}, nil
		},
	}
	return e
}

func (e *fakeEngine) Call(ctx context.Context, method string, params any, onEvent func(sidecar.Event)) (json.RawMessage, error) {
	b, _ := json.Marshal(params)
	var p map[string]any
	_ = json.Unmarshal(b, &p)
	e.mu.Lock()
	e.calls = append(e.calls, method)
	e.params[method] = p
	h := e.handlers[method]
	e.mu.Unlock()
	if h == nil {
		return nil, fmt.Errorf("unexpected engine call %s", method)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	emit := func(ev sidecar.Event) {
		if onEvent != nil {
			onEvent(ev)
		}
	}
	res, err := h(ctx, p, emit)
	if err != nil {
		return nil, err
	}
	return json.Marshal(res)
}

func (e *fakeEngine) count(method string) int {
	n := 0
	for _, c := range e.calls {
		if c == method {
			n++
		}
	}
	return n
}

func (e *fakeEngine) reset() { e.calls = nil }

// writeFeatures writes a canned 10 s song at 10 fps: brightness 0.5, vocals
// loud on frames 50..59 (5 s..6 s) only, presence flat.
func writeFeatures(dir, name string, stems bool) error {
	const frames = 100
	bin := make([]byte, frames*3)
	for i := 0; i < frames; i++ {
		bin[i] = 128 // mix.brightness
		if i >= 50 && i < 60 {
			bin[frames+i] = 250 // vocals.level
		} else {
			bin[frames+i] = 20
		}
		bin[2*frames+i] = 100 // mix.presence
	}
	info := map[string]any{
		"version": 1, "durationMs": 10000, "fps": 10, "frames": frames, "stems": stems,
		"tempo": 120.0, "beatsPerBar": 4, "downbeats": []int{0, 2000, 4000, 6000, 8000},
		"key":      map[string]any{"name": "A minor", "minor": true},
		"sections": []map[string]any{{"startMs": 0, "endMs": 5000, "label": "intro", "energy": 0.2}, {"startMs": 5000, "endMs": 10000, "label": "chorus", "energy": 0.9}},
		"events":   map[string]any{"held": [][]int{{8000, 9000, 60}}},
		"blocks": []map[string]any{
			{"id": "mix.brightness", "kind": "scalar", "offset": 0, "width": 1},
			{"id": "vocals.level", "kind": "scalar", "offset": frames, "width": 1},
			{"id": "mix.presence", "kind": "scalar", "offset": 2 * frames, "width": 1}},
		"features": name + ".bin",
	}
	b, _ := json.Marshal(info)
	if err := os.WriteFile(filepath.Join(dir, name+".bin"), bin, 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name+".json"), b, 0o644)
}

// fakeChat is a core.TextGenerator.
type fakeChat struct {
	mu       sync.Mutex
	readyErr error
	reqs     []core.CompletionRequest
	reply    func(req core.CompletionRequest, n int) (string, error)
}

func (f *fakeChat) Ready() (string, error) {
	if f.readyErr != nil {
		return "", f.readyErr
	}
	return "fake", nil
}

func (f *fakeChat) Complete(ctx context.Context, req core.CompletionRequest) (string, error) {
	f.mu.Lock()
	f.reqs = append(f.reqs, req)
	n := len(f.reqs)
	f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return f.reply(req, n)
}

// schemaCount reads n out of a request's JSON schema.
func schemaCount(req core.CompletionRequest) int {
	var s struct {
		MinItems int `json:"minItems"`
	}
	_ = json.Unmarshal(req.JSONSchema, &s)
	return s.MinItems
}

// chatJSON is a reply of n identical readings.
func chatJSON(n int, valence, energy float64, emotion string, motifs []string, emphasis []string) string {
	var items []map[string]any
	for i := 0; i < n; i++ {
		items = append(items, map[string]any{"valence": valence, "energy": energy, "emotion": emotion, "motifs": motifs, "emphasis": emphasis})
	}
	b, _ := json.Marshal(items)
	return string(b)
}

// jobRec is a recorded job context.
type jobRec struct {
	mu       sync.Mutex
	progress []float64
	outputs  []string
	logs     []string
	tools    map[string]string
}

func newJob(t *testing.T, rec *jobRec) *core.JobContext {
	if rec.tools == nil {
		rec.tools = map[string]string{sidecar.DepID: "engine", "ffmpeg": "ffmpeg"}
	}
	return core.NewJobContext(core.JobContext{ID: "j1", OutputDir: t.TempDir(), TempDir: t.TempDir()}, core.JobHooks{
		Progress: func(p float64, _ string) { rec.mu.Lock(); rec.progress = append(rec.progress, p); rec.mu.Unlock() },
		Log:      func(_ core.LogStream, l string) { rec.logs = append(rec.logs, l) },
		Output: func(p string) (core.Output, error) {
			rec.outputs = append(rec.outputs, p)
			return core.Output{}, nil
		},
		Tool: func(id string) (string, error) {
			if p, ok := rec.tools[id]; ok {
				return p, nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	})
}

// fakeSong makes an audio file and an Analyzer over fresh dirs.
func fakeSong(t *testing.T, sc sidecar.Caller, tg core.TextGenerator) (*Analyzer, string) {
	t.Helper()
	dir := t.TempDir()
	song := filepath.Join(dir, "My Song.mp3")
	if err := os.WriteFile(song, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := NewAnalyzer(filepath.Join(dir, "cache"), filepath.Join(dir, "models"), sc, tg)
	return a, song
}

// fakeFFmpeg replaces runFFmpeg for a test: it writes the last arg.
func fakeFFmpeg(t *testing.T) *[][]string {
	t.Helper()
	var got [][]string
	old := runFFmpeg
	runFFmpeg = func(_ context.Context, _ string, args []string) error {
		got = append(got, args)
		return os.WriteFile(args[len(args)-1], []byte("flac"), 0o644)
	}
	t.Cleanup(func() { runFFmpeg = old })
	return &got
}

func readText(t *testing.T, path string) textFile {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var tf textFile
	if err := json.Unmarshal(b, &tf); err != nil {
		t.Fatal(err)
	}
	return tf
}

func contains(ss []string, sub string) bool {
	for _, s := range ss {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
