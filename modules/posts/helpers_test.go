package posts

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/modules/composer"
	"toolbox/modules/videoeditor"
)

type memStore struct {
	mu sync.Mutex
	m  map[string]core.StoredProject
}

func (s *memStore) ListProjects(_ context.Context, kind core.ProjectKind) ([]core.StoredProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []core.StoredProject
	for _, p := range s.m {
		if p.Kind == kind {
			out = append(out, p)
		}
	}
	return out, nil
}

func (s *memStore) GetProject(_ context.Context, id string) (core.StoredProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[id]
	if !ok {
		return core.StoredProject{}, core.Errorf(core.CodeNotFound, "Project not found")
	}
	return p, nil
}

func (s *memStore) PutProject(_ context.Context, p core.StoredProject) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[p.ID] = p
	return nil
}

func (s *memStore) DeleteProject(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, id)
	return nil
}

type fakeComps struct {
	comp   composer.Composition
	render string
	err    error
}

func (f *fakeComps) Get(context.Context, string) (composer.Composition, error) { return f.comp, f.err }
func (f *fakeComps) RenderPath(string) (string, error)                         { return f.render, f.err }

type fakeVideos struct {
	doc    videoeditor.VideoProject
	render func(out string, o videoeditor.RenderOptions) error
	opts   videoeditor.RenderOptions
}

func (f *fakeVideos) Get(context.Context, string) (videoeditor.VideoProject, error) {
	return f.doc, nil
}

func (f *fakeVideos) RenderProject(_ context.Context, _ *core.JobContext, _ videoeditor.VideoProject, out string, o videoeditor.RenderOptions) error {
	f.opts = o
	return f.render(out, o)
}

// testEnv is a module over an in-memory store with a fake job harness.
type testEnv struct {
	t      *testing.T
	m      *Module
	outDir string
	tmpDir string
	// recorded job state
	outputs []string
	result  json.RawMessage
	title   string
	tools   map[string]string
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	root := t.TempDir()
	e := &testEnv{t: t, outDir: filepath.Join(root, "Posts"), tmpDir: filepath.Join(root, "tmp"), tools: map[string]string{}}
	os.MkdirAll(e.outDir, 0o755)
	e.m = New(Config{
		Store:       &memStore{m: map[string]core.StoredProject{}},
		ProjectsDir: filepath.Join(root, "projects"),
		Resolve: func(id string) (string, error) {
			if p, ok := e.tools[id]; ok {
				return p, nil
			}
			return "", core.ErrDependencyMissing(id, "")
		},
	})
	e.m.now = func() time.Time { return time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC) }
	return e
}

// save stores doc as a post named name and returns its ID.
func (e *testEnv) save(name string, doc Post) string {
	e.t.Helper()
	info, err := e.m.docs.Create(context.Background(), name, doc)
	if err != nil {
		e.t.Fatal(err)
	}
	return info.ID
}

func (e *testEnv) run(ctx context.Context, id string) error {
	raw, _ := json.Marshal(Options{Action: ActionExport, ProjectID: id})
	hooks := core.JobHooks{
		Title: func(s string) { e.title = s },
		Output: func(p string) (core.Output, error) {
			e.outputs = append(e.outputs, p)
			return core.Output{Path: p}, nil
		},
		Tool: func(dep string) (string, error) { return e.m.cfg.Resolve(dep) },
		Result: func(r json.RawMessage) {
			e.result = r
		},
	}
	jc := core.NewJobContext(core.JobContext{ID: "j1", ModuleID: ModuleID, Options: raw, OutputDir: e.outDir, TempDir: e.tmpDir}, hooks)
	return e.m.Run(ctx, jc)
}

func (e *testEnv) exportResult() ExportResult {
	e.t.Helper()
	var r ExportResult
	if err := json.Unmarshal(e.result, &r); err != nil {
		e.t.Fatal(err)
	}
	return r
}

// gradient fills a w×h image with a horizontal gradient.
func gradient(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x * 255 / w), uint8(y * 255 / h), 90, 255})
		}
	}
	return img
}

// exifPayload builds an Exif APP1 payload with the given orientation and,
// when gps is set, a GPS IFD pointer.
func exifPayload(orientation uint16, gps bool) []byte {
	le := binary.LittleEndian
	var t bytes.Buffer
	t.WriteString("II")
	t.Write(le.AppendUint16(nil, 42))
	t.Write(le.AppendUint32(nil, 8))
	n := 1
	if gps {
		n = 2
	}
	t.Write(le.AppendUint16(nil, uint16(n)))
	// entry: tag, type SHORT(3), count 1, value
	t.Write(le.AppendUint16(nil, tagOrientation))
	t.Write(le.AppendUint16(nil, 3))
	t.Write(le.AppendUint32(nil, 1))
	t.Write(le.AppendUint16(nil, orientation))
	t.Write([]byte{0, 0})
	gpsOff := uint32(8 + 2 + 12*n + 4)
	if gps {
		t.Write(le.AppendUint16(nil, tagGPSPointer))
		t.Write(le.AppendUint16(nil, 4)) // LONG
		t.Write(le.AppendUint32(nil, 1))
		t.Write(le.AppendUint32(nil, gpsOff))
	}
	t.Write(le.AppendUint32(nil, 0)) // no next IFD
	if gps {
		t.Write(le.AppendUint16(nil, 1))
		t.Write(le.AppendUint16(nil, 0)) // GPSVersionID
		t.Write(le.AppendUint16(nil, 1)) // BYTE
		t.Write(le.AppendUint32(nil, 4))
		t.Write([]byte{2, 3, 0, 0})
		t.Write(le.AppendUint32(nil, 0))
	}
	return append(append([]byte(nil), exifHeader...), t.Bytes()...)
}

// writeJPEG writes a JPEG of img with an optional Exif segment.
func writeJPEG(t *testing.T, path string, img image.Image, exif []byte) {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	data := b.Bytes()
	if exif != nil {
		data = spliceExif(data, exif)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func writePNG(t *testing.T, path string, img image.Image) {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func imageSize(t *testing.T, path string) (int, int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height
}

var errFake = errors.New("fake")

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

func asAppError(err error, target **core.AppError) bool { return errors.As(err, target) }
