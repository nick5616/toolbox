package chat

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"toolbox/core"
	"toolbox/core/imaging"
)

// ---- helpers ----

func exifJPEG(t *testing.T, w, h int, orientation uint16) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
		}
	}
	var enc bytes.Buffer
	if err := jpeg.Encode(&enc, img, nil); err != nil {
		t.Fatal(err)
	}
	raw := enc.Bytes()
	if orientation == 0 {
		return raw
	}
	var tiff bytes.Buffer
	bo := binary.LittleEndian
	tiff.WriteString("II")
	_ = binary.Write(&tiff, bo, uint16(42))
	_ = binary.Write(&tiff, bo, uint32(8))
	_ = binary.Write(&tiff, bo, uint16(1))
	_ = binary.Write(&tiff, bo, uint16(0x0112))
	_ = binary.Write(&tiff, bo, uint16(3))
	_ = binary.Write(&tiff, bo, uint32(1))
	_ = binary.Write(&tiff, bo, orientation)
	_ = binary.Write(&tiff, bo, uint16(0))
	_ = binary.Write(&tiff, bo, uint32(0))
	var out bytes.Buffer
	out.Write(raw[:2])
	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	out.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&out, binary.BigEndian, uint16(len(payload)+2))
	out.Write(payload)
	out.Write(raw[2:])
	return out.Bytes()
}

func writeFile(t *testing.T, path string, data []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// visionEntry is a text-model entry that also has a (tiny) projector.
func visionEntry(id string) catalogEntry {
	return catalogEntry{
		ID: id, Label: id, File: id + ".gguf", Bytes: 3, VisionDefault: id == "vis",
		MMProj: &mmprojFile{File: "mmproj-F16.gguf", Bytes: 4},
	}
}

// installVision writes the GGUF and projector of e under the harness.
func (h *harness) installVision(t *testing.T, e catalogEntry) {
	t.Helper()
	writeFile(t, h.c.modelPath(e), []byte("abc"))
	writeFile(t, h.c.mmprojPath(e), []byte("abcd"))
}

// requests reads every recorded completion body.
func readRecorded(t *testing.T, rec string) []map[string]any {
	t.Helper()
	b, _ := os.ReadFile(rec)
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

// imageURLs extracts the data URLs of the last user message.
func imageURLs(t *testing.T, req map[string]any) []string {
	t.Helper()
	msgs := req["messages"].([]any)
	last := msgs[len(msgs)-1].(map[string]any)
	parts, ok := last["content"].([]any)
	if !ok {
		t.Fatalf("content is not parts: %v", last["content"])
	}
	var urls []string
	for _, p := range parts {
		pm := p.(map[string]any)
		if pm["type"] == "image_url" {
			urls = append(urls, pm["image_url"].(map[string]any)["url"].(string))
		}
	}
	return urls
}

func decodeDataURL(t *testing.T, u string) image.Image {
	t.Helper()
	const prefix = "data:image/jpeg;base64,"
	if !strings.HasPrefix(u, prefix) {
		t.Fatalf("not a jpeg data URL: %.40s", u)
	}
	b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(u, prefix))
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

// ---- server args ----

func TestServerArgsMMProj(t *testing.T) {
	has := func(args []string, flag, val string) bool {
		for i, a := range args {
			if a == flag && i+1 < len(args) && args[i+1] == val {
				return true
			}
		}
		return false
	}
	with := serverArgs("m.gguf", "p.gguf", "k", 4096, true)
	if !has(with, "--mmproj", "p.gguf") || !has(with, "--host", "127.0.0.1") || !has(with, "--port", "0") ||
		!has(with, "--api-key-file", "k") {
		t.Fatalf("args = %v", with)
	}
	for _, a := range serverArgs("m.gguf", "", "k", 4096, false) {
		if a == "--mmproj" {
			t.Fatal("--mmproj without a projector")
		}
	}
	found := false
	for _, a := range with {
		found = found || a == "--no-webui"
	}
	if !found {
		t.Fatal("safety flags lost")
	}
}

func TestLaunchPassesMMProjOnlyWhenPresent(t *testing.T) {
	h := newHarness(t, "ok")
	argsFile := filepath.Join(t.TempDir(), "args")
	h.setEnv("FAKE_ARGS", argsFile)
	e := visionEntry("vis")
	h.entry = e
	h.c.entries = func() []catalogEntry { return []catalogEntry{e} }
	// GGUF only: text chat works, no --mmproj.
	writeFile(t, h.c.modelPath(e), []byte("abc"))
	if _, err := h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "hi", Model: "vis"}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(argsFile)
	if strings.Contains(string(b), "--mmproj") {
		t.Fatalf("args = %s", b)
	}
	// Projector appears: the server restarts with it.
	writeFile(t, h.c.mmprojPath(e), []byte("abcd"))
	if _, err := h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "hi", Model: "vis"}); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(argsFile)
	lines := strings.Split(string(b), "\n")
	ok := false
	for i, l := range lines {
		if l == "--mmproj" && i+1 < len(lines) && lines[i+1] == h.c.mmprojPath(e) {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("args = %s", b)
	}
	if !strings.Contains(filepath.Base(h.c.mmprojPath(e)), "vis.mmproj-F16.gguf") {
		t.Fatalf("projector name = %s", h.c.mmprojPath(e))
	}
}

// ---- images ----

func TestEncodeImageSizeOrientationAndFormat(t *testing.T) {
	dir := t.TempDir()
	big := writeFile(t, filepath.Join(dir, "big.jpg"), exifJPEG(t, 2000, 1000, 0))
	small := writeFile(t, filepath.Join(dir, "small.jpg"), exifJPEG(t, 300, 100, 0))
	rot := writeFile(t, filepath.Join(dir, "rot.jpg"), exifJPEG(t, 300, 100, 6)) // 90° → 100×300
	for _, tc := range []struct {
		name string
		path string
		w, h int
	}{
		{"downscaled", big, 896, 448},
		{"kept", small, 300, 100},
		{"rotated", rot, 100, 300},
	} {
		b, err := encodeImage(context.Background(), tc.path)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
		if err != nil || cfg.Width != tc.w || cfg.Height != tc.h {
			t.Errorf("%s: %dx%d, %v; want %dx%d", tc.name, cfg.Width, cfg.Height, err, tc.w, tc.h)
		}
	}
	// A tall image is bounded on its long side too.
	tall := writeFile(t, filepath.Join(dir, "tall.jpg"), exifJPEG(t, 500, 2000, 0))
	b, _ := encodeImage(context.Background(), tall)
	if cfg, _ := jpeg.DecodeConfig(bytes.NewReader(b)); cfg.Height != 896 || cfg.Width != 224 {
		t.Errorf("tall: %dx%d", cfg.Width, cfg.Height)
	}
	// Not a picture.
	bad := writeFile(t, filepath.Join(dir, "bad.jpg"), []byte("nope"))
	if _, err := encodeImage(context.Background(), bad); !core.IsCode(err, core.CodeValidation) {
		t.Errorf("bad: %v", err)
	}
}

type fakeHEIC struct{ png string }

func (f fakeHEIC) ToPNG(context.Context, string) (string, error) { return f.png, nil }
func (f fakeHEIC) Available() bool                               { return true }

func TestEncodeImageHEICThroughConverter(t *testing.T) {
	dir := t.TempDir()
	var pb bytes.Buffer
	if err := png.Encode(&pb, image.NewNRGBA(image.Rect(0, 0, 64, 32))); err != nil {
		t.Fatal(err)
	}
	conv := fakeHEIC{png: writeFile(t, filepath.Join(dir, "cache.png"), pb.Bytes())}
	imaging.SetHEICConverter(conv)
	t.Cleanup(func() { imaging.SetHEICConverter(nil) })
	heic := writeFile(t, filepath.Join(dir, "photo.heic"), []byte("not really heic"))
	b, err := encodeImage(context.Background(), heic)
	if err != nil {
		t.Fatal(err)
	}
	if cfg, err := jpeg.DecodeConfig(bytes.NewReader(b)); err != nil || cfg.Width != 64 || cfg.Height != 32 {
		t.Fatalf("heic: %+v %v", cfg, err)
	}
}

func TestCompleteSendsImagePartsSeedAndNoPaths(t *testing.T) {
	h := newHarness(t, "ok")
	e := visionEntry("vis")
	h.entry = e
	h.c.entries = func() []catalogEntry { return []catalogEntry{e} }
	h.installVision(t, e)
	rec := filepath.Join(t.TempDir(), "rec")
	h.setEnv("FAKE_RECORD", rec)

	dir := t.TempDir()
	p1 := writeFile(t, filepath.Join(dir, "secret-name-one.jpg"), exifJPEG(t, 1200, 800, 0))
	p2 := writeFile(t, filepath.Join(dir, "secret-name-two.jpg"), exifJPEG(t, 300, 100, 6))
	schema := json.RawMessage(`{"type":"object","properties":{"a":{"type":"string"}}}`)
	_, err := h.c.Complete(context.Background(), core.CompletionRequest{
		System: "sys", Prompt: "describe", Images: []string{p1, p2}, Model: "vis", Seed: 1234, JSONSchema: schema,
	})
	if err != nil {
		t.Fatal(err)
	}
	reqs := readRecorded(t, rec)
	if len(reqs) != 1 {
		t.Fatalf("requests = %d", len(reqs))
	}
	req := reqs[0]
	urls := imageURLs(t, req)
	if len(urls) != 2 {
		t.Fatalf("images = %d", len(urls))
	}
	if im := decodeDataURL(t, urls[0]); im.Bounds().Dx() != 896 || im.Bounds().Dy() != 597 {
		t.Errorf("first = %v", im.Bounds())
	}
	if im := decodeDataURL(t, urls[1]); im.Bounds().Dx() != 100 || im.Bounds().Dy() != 300 {
		t.Errorf("rotated = %v", im.Bounds())
	}
	if req["seed"] != float64(1234) {
		t.Errorf("seed = %v", req["seed"])
	}
	rf, _ := req["response_format"].(map[string]any)
	if rf["type"] != "json_schema" {
		t.Errorf("response_format = %v", rf)
	}
	raw, _ := os.ReadFile(rec)
	for _, bad := range []string{"secret-name", filepath.Base(dir), filepath.ToSlash(dir), strings.ReplaceAll(dir, `\`, `\\`)} {
		if strings.Contains(string(raw), bad) {
			t.Errorf("request body contains %q", bad)
		}
	}
	// The text part rides first, and a system message precedes.
	msgs := req["messages"].([]any)
	if msgs[0].(map[string]any)["role"] != "system" {
		t.Errorf("messages = %v", msgs)
	}
	parts := msgs[1].(map[string]any)["content"].([]any)
	if first := parts[0].(map[string]any); first["type"] != "text" || first["text"] != "describe" {
		t.Errorf("first part = %v", first)
	}

	// No seed → no "seed" field; no images → plain string content.
	if err := os.Remove(rec); err != nil {
		t.Fatal(err)
	}
	if _, err := h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "plain", Model: "vis"}); err != nil {
		t.Fatal(err)
	}
	req = readRecorded(t, rec)[0]
	if _, has := req["seed"]; has {
		t.Error("seed sent as zero")
	}
	last := req["messages"].([]any)[0].(map[string]any)
	if last["content"] != "plain" {
		t.Errorf("content = %v", last["content"])
	}
}

func TestCompleteImagesNeedAModelThatSees(t *testing.T) {
	h := newHarness(t, "ok") // the fake text model: no projector
	p := writeFile(t, filepath.Join(t.TempDir(), "a.jpg"), exifJPEG(t, 50, 50, 0))
	_, err := h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "x", Images: []string{p}})
	if !core.IsCode(err, core.CodeValidation) || !strings.Contains(err.Error(), "This model can't read pictures") {
		t.Fatalf("err = %v", err)
	}
	if slotHolder(h) != nil {
		t.Fatal("slot held")
	}
	// A vision entry whose projector is missing can't see either.
	e := visionEntry("vis")
	h.c.entries = func() []catalogEntry { return []catalogEntry{h.entry, e} }
	writeFile(t, h.c.modelPath(e), []byte("abc"))
	_, err = h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "x", Images: []string{p}, Model: "vis"})
	if !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("no projector: %v", err)
	}
	// Unknown / missing requested models.
	if _, err = h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "x", Model: "nope"}); !core.IsCode(err, core.CodeNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}

// ---- Ollama ----

func ollamaVisionServer(t *testing.T, caps []string, chatBody *map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/show":
			_ = json.NewEncoder(w).Encode(map[string]any{"capabilities": caps})
		case "/api/chat":
			b, _ := io.ReadAll(r.Body)
			if chatBody != nil {
				_ = json.Unmarshal(b, chatBody)
			}
			io.WriteString(w, `{"message":{"role":"assistant","content":"seen"},"done":true}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (h *harness) useOllama(t *testing.T, url, model string) {
	t.Helper()
	cs := core.DefaultChatSettings()
	cs.OllamaURL = url
	cs.DefaultModel = model
	if _, err := h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs}); err != nil {
		t.Fatal(err)
	}
}

func TestOllamaImagesAndVision(t *testing.T) {
	var body map[string]any
	srv := ollamaVisionServer(t, []string{"completion", "vision"}, &body)
	h := newHarness(t, "ok")
	h.useOllama(t, srv.URL, "ollama:llava")
	if m, err := h.c.Vision(); err != nil || m != "ollama:llava" {
		t.Fatalf("vision = %q %v", m, err)
	}
	p := writeFile(t, filepath.Join(t.TempDir(), "a.jpg"), exifJPEG(t, 100, 50, 0))
	out, err := h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "look", Images: []string{p}, Seed: 9})
	if err != nil || out != "seen" {
		t.Fatalf("out = %q %v", out, err)
	}
	msgs := body["messages"].([]any)
	imgs, _ := msgs[len(msgs)-1].(map[string]any)["images"].([]any)
	if len(imgs) != 1 {
		t.Fatalf("body = %v", body)
	}
	raw, err := base64.StdEncoding.DecodeString(imgs[0].(string))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jpeg.Decode(bytes.NewReader(raw)); err != nil {
		t.Fatal(err)
	}
	if body["options"].(map[string]any)["seed"] != float64(9) {
		t.Errorf("options = %v", body["options"])
	}

	// No vision capability: refused, and Vision() falls past it.
	srv2 := ollamaVisionServer(t, []string{"completion"}, nil)
	h.useOllama(t, srv2.URL, "ollama:phi3")
	if _, err := h.c.Complete(context.Background(), core.CompletionRequest{Prompt: "look", Images: []string{p}}); !core.IsCode(err, core.CodeValidation) {
		t.Fatalf("no vision: %v", err)
	}
	if _, err := h.c.Vision(); !core.IsCode(err, core.CodeDependencyMissing) {
		t.Fatalf("Vision = %v", err)
	}
}

// ---- Vision() ----

func TestVisionChoices(t *testing.T) {
	text := catalogEntry{ID: "text", Label: "Text", File: "text.gguf", Bytes: 3}
	seer := visionEntry("seer")
	def := visionEntry("vis")
	cases := []struct {
		name    string
		install func(h *harness)
		chat    string // default model
		want    string
		wantErr bool
	}{
		{"nothing", func(h *harness) {}, "", "", true},
		{"text model only", func(h *harness) { writeFile(t, h.c.modelPath(text), []byte("abc")) }, "text", "", true},
		{"chat model sees", func(h *harness) { h.installVision(t, seer) }, "seer", "seer", false},
		{"chat model lacks projector, default ready", func(h *harness) {
			writeFile(t, h.c.modelPath(seer), []byte("abc"))
			h.installVision(t, def)
		}, "seer", "vis", false},
		{"text chat model, default ready", func(h *harness) {
			writeFile(t, h.c.modelPath(text), []byte("abc"))
			h.installVision(t, def)
		}, "text", "vis", false},
		{"default has GGUF only", func(h *harness) { writeFile(t, h.c.modelPath(def), []byte("abc")) }, "", "", true},
		{"default has projector only", func(h *harness) { writeFile(t, h.c.mmprojPath(def), []byte("abcd")) }, "", "", true},
		{"wrong projector size", func(h *harness) {
			writeFile(t, h.c.modelPath(def), []byte("abc"))
			writeFile(t, h.c.mmprojPath(def), []byte("abcde"))
		}, "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, "ok")
			os.Remove(h.models + "/llm/fake.gguf")
			h.c.entries = func() []catalogEntry { return []catalogEntry{text, seer, def} }
			tc.install(h)
			if tc.chat != "" {
				cs := core.DefaultChatSettings()
				cs.DefaultModel = tc.chat
				if _, err := h.c.cfg.Settings.Update(context.Background(), core.SettingsPatch{Chat: &cs}); err != nil {
					t.Fatal(err)
				}
			}
			got, err := h.c.Vision()
			if tc.wantErr {
				if !core.IsCode(err, core.CodeDependencyMissing) || !strings.Contains(err.Error(), "Install the Caption Writer pack to read pictures") {
					t.Fatalf("err = %v (model %q)", err, got)
				}
			} else if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
			if h.c.srv != nil {
				t.Fatal("Vision started the server")
			}
		})
	}
}

// ---- model switching ----

func TestModelSwitchWaitsForInteractiveReplyThenRestores(t *testing.T) {
	h := newHarness(t, "ok")
	argsFile := filepath.Join(t.TempDir(), "args")
	h.setEnv("FAKE_ARGS", argsFile)
	vis := visionEntry("vis")
	h.c.entries = func() []catalogEntry { return []catalogEntry{h.entry, vis} }
	h.installVision(t, vis)
	serverModel := func() string {
		h.c.mu.Lock()
		defer h.c.mu.Unlock()
		if h.c.srv == nil {
			return ""
		}
		return h.c.srv.model
	}

	// An interactive reply streams on "fake".
	conv := h.newConv(t)
	r, err := h.svc.Send(conv.ID, "SLOW please")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "fake server", func() bool { return serverModel() == "fake" })

	type res struct {
		out string
		err error
	}
	rc := make(chan res, 1)
	p := writeFile(t, filepath.Join(t.TempDir(), "a.jpg"), exifJPEG(t, 100, 80, 0))
	go func() {
		out, err := h.c.Complete(context.Background(), core.CompletionRequest{
			Prompt: "caption", Images: []string{p}, Model: "vis", Purpose: "Writing captions",
		})
		rc <- res{out, err}
	}()
	select {
	case <-rc:
		t.Fatal("the background request interrupted the reply")
	case <-time.After(300 * time.Millisecond):
	}
	if m := serverModel(); m != "fake" {
		t.Fatalf("server switched early: %q", m)
	}
	if b := h.svc.Status().Busy; b != "" {
		t.Fatalf("busy before the slot was free: %q", b)
	}

	// The reply ends; the background request restarts the server on "vis".
	if err := h.svc.Stop(conv.ID); err != nil {
		t.Fatal(err)
	}
	h.waitDone(t, r.AssistantMessageID)
	got := <-rc
	if got.err != nil || !strings.HasPrefix(got.out, "echo:") {
		t.Fatalf("complete: %q %v", got.out, got.err)
	}
	if m := serverModel(); m != "vis" {
		t.Fatalf("server model = %q", m)
	}
	b, _ := os.ReadFile(argsFile)
	if !strings.Contains(string(b), "vis.gguf") || !strings.Contains(string(b), "--mmproj") {
		t.Fatalf("args = %s", b)
	}

	// The next interactive message reloads the user's chat model.
	r2, err := h.svc.Send(conv.ID, "hello again")
	if err != nil {
		t.Fatal(err)
	}
	if d := h.waitDone(t, r2.AssistantMessageID); d.Status != core.ChatMessageDone {
		t.Fatalf("done = %+v", d)
	}
	if m := serverModel(); m != "fake" {
		t.Fatalf("server model after chat = %q", m)
	}
	b, _ = os.ReadFile(argsFile)
	if !strings.Contains(string(b), "fake.gguf") || strings.Contains(string(b), "--mmproj") {
		t.Fatalf("args = %s", b)
	}
}

func TestBusyShowsPurposeForVisionRequest(t *testing.T) {
	h := newHarness(t, "ok")
	e := visionEntry("vis")
	h.entry = e
	h.c.entries = func() []catalogEntry { return []catalogEntry{e} }
	h.installVision(t, e)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.c.Complete(ctx, core.CompletionRequest{Prompt: "SLOW", Model: "vis", Purpose: "Writing captions"})
	}()
	waitFor(t, "purpose", func() bool { return h.svc.Status().Busy == "Writing captions" })
	cancel()
	<-done
}

// ---- projector download / verify / remove ----

func projectorHarness(t *testing.T, ggufData, projData []byte, projSum string) (*harness, catalogEntry, *modelServer, *modelServer, *core.JobContext) {
	t.Helper()
	h := newHarness(t, "ok")
	os.Remove(h.models + "/llm/fake.gguf")
	gs, ps := newModelServer(t, ggufData), newModelServer(t, projData)
	e := catalogEntry{
		ID: "vis", Label: "Vis", File: "Vis-Q4.gguf", Bytes: int64(len(ggufData)), SHA256: sha(ggufData),
		MMProj: &mmprojFile{File: "mmproj-F16.gguf", Bytes: int64(len(projData)), SHA256: projSum},
	}
	h.entry = e
	h.c.entries = func() []catalogEntry { return []catalogEntry{e} }
	h.c.modelURL = func(catalogEntry) string { return gs.srv.URL + "/m.gguf" }
	h.c.mmprojURL = func(catalogEntry) string { return ps.srv.URL + "/p.gguf" }
	return h, e, gs, ps, core.NewJobContext(core.JobContext{ID: "j"}, core.JobHooks{})
}

func TestProjectorDownloadVerifyAndRemove(t *testing.T) {
	gguf, proj := testData(200_000), testData(120_000)
	h, e, _, _, job := projectorHarness(t, gguf, proj, sha(testData(120_000)))
	m := &Module{c: h.c}
	if m.ModelPresent("vis") {
		t.Fatal("present before")
	}
	if err := m.FetchModel(context.Background(), job, "vis"); err != nil {
		t.Fatal(err)
	}
	if !m.ModelPresent("vis") || !h.c.visionReady(e) {
		t.Fatal("not present after fetch")
	}
	want := filepath.Join(h.models, "llm", "Vis-Q4.mmproj-F16.gguf")
	if h.c.mmprojPath(e) != want {
		t.Fatalf("path = %s", h.c.mmprojPath(e))
	}
	got, _ := os.ReadFile(want)
	if sha(got) != sha(proj) {
		t.Fatal("projector content wrong")
	}
	for _, p := range []string{h.c.modelPath(e) + ".part", want + ".part"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s left behind", p)
		}
	}
	// Removing the model removes the projector.
	if err := m.RemoveModel("vis"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{h.c.modelPath(e), want} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s still there", p)
		}
	}
}

func TestProjectorFetchedWhenGGUFAlreadyThere(t *testing.T) {
	gguf, proj := testData(10_000), testData(7_000)
	h, e, gs, ps, job := projectorHarness(t, gguf, proj, sha(proj))
	writeFile(t, h.c.modelPath(e), gguf)
	if !h.c.modelPresent("vis") || h.c.visionReady(e) {
		t.Fatal("setup")
	}
	if err := h.c.downloadModel(context.Background(), job, e); err != nil {
		t.Fatal(err)
	}
	if !h.c.visionReady(e) {
		t.Fatal("projector missing")
	}
	if gs.hits.Load() != 0 || ps.hits.Load() == 0 {
		t.Fatalf("requests: gguf %d, projector %d", gs.hits.Load(), ps.hits.Load())
	}
}

func TestProjectorChecksumMismatch(t *testing.T) {
	gguf, proj := testData(10_000), testData(7_000)
	h, e, _, _, job := projectorHarness(t, gguf, proj, sha([]byte("something else")))
	err := h.c.downloadModel(context.Background(), job, e)
	if !core.IsCode(err, core.CodeToolFailed) || !strings.Contains(err.Error(), errCorrupt) {
		t.Fatalf("err = %v", err)
	}
	if h.c.projectorPresent(e) {
		t.Fatal("corrupt projector kept")
	}
	if _, err := os.Stat(h.c.mmprojPath(e) + ".part"); !os.IsNotExist(err) {
		t.Fatal(".part kept")
	}
	// The GGUF was fine and stays: text chat works.
	if !h.c.modelPresent("vis") {
		t.Fatal("GGUF removed")
	}
}
