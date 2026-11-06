// Package tts is Text to Speech: Kokoro (ONNX) in the AI engine reads text,
// Markdown, HTML and subtitle files aloud (Phase 15, T1).
package tts

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// ModuleID is Text to Speech's module ID.
const ModuleID = "tts"

// Module implements core.Module, core.ModelProvider and core.Chainable.
type Module struct {
	sc         sidecar.Caller
	modelsDir  string // <models>; the Kokoro files are in <modelsDir>/tts/
	previewDir string // <support>/cache/tts-preview
	textDir    string // <support>/tmp/tts-text: pasted text becomes a file here
}

var _ core.ModelProvider = (*Module)(nil)

// Register adds the module to the registry.
func Register(reg *core.Registry, sc sidecar.Caller, modelsDir, previewDir, textDir string) (*Module, error) {
	m := &Module{sc: sc, modelsDir: modelsDir, previewDir: previewDir, textDir: textDir}
	return m, reg.Register(m)
}

// Descriptor implements core.Module.
func (m *Module) Descriptor() core.Descriptor {
	return core.Descriptor{
		ID: ModuleID, Name: "Text to Speech", Icon: "audio-lines", Category: core.CategoryAudio,
		Tagline:     "Read text aloud with natural voices",
		Description: "Turn text, Markdown, web pages and subtitle files into spoken audio with local AI voices. Split a long text into one file per chapter. Everything runs on your computer.",
		Status:      core.StatusReady,
		Accepts:     core.Accepts{Extensions: Accepts()},
		Requires:    []string{sidecar.DepID, "ffmpeg"},
		Order:       182, OutputSubdir: "Speech",
		SplitInputs: true, MaxConcurrent: 1, MaxInputs: 100,
	}
}

// Validate implements core.Module.
func (m *Module) Validate(inputs []string, options json.RawMessage) error {
	return m.validate(inputs, options)
}

// Run implements core.Module.
func (m *Module) Run(ctx context.Context, job *core.JobContext) error { return m.run(ctx, job) }

// ModelPresent implements core.ModelProvider.
func (m *Module) ModelPresent(preset string) bool { return m.modelPresent(preset) }

// FetchModel implements core.ModelProvider.
func (m *Module) FetchModel(ctx context.Context, job *core.JobContext, preset string) error {
	return m.fetchModel(ctx, job, preset)
}

// RemoveModel implements core.ModelProvider.
func (m *Module) RemoveModel(preset string) error { return m.removeModel(preset) }

// PruneCache deletes preview audio older than a day and pasted-text files
// older than a week (called at start).
func (m *Module) PruneCache() {
	pruneOlder(m.previewDir, 24*time.Hour)
	pruneOlder(m.textDir, 7*24*time.Hour)
}

// prunePreviews drops stale previews before a new one is made.
func (m *Module) prunePreviews() { pruneOlder(m.previewDir, time.Hour) }

// DiscardPreviews deletes every preview (the view calls it on unmount).
func (m *Module) DiscardPreviews() { pruneOlder(m.previewDir, 0) }

func pruneOlder(dir string, age time.Duration) {
	if dir == "" {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-age)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || (age > 0 && info.ModTime().After(cutoff)) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(dir, e.Name()))
	}
}

var slugBad = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f#]+`)

// slug is a short file-name stem from the first words of a text.
func slug(text string) string {
	first := strings.TrimSpace(text)
	if i := strings.IndexAny(first, "\r\n"); i >= 0 {
		first = first[:i]
	}
	first = strings.TrimSpace(slugBad.ReplaceAllString(first, " "))
	first = strings.Join(strings.Fields(first), " ")
	runes := []rune(first)
	if len(runes) > 40 {
		runes = runes[:40]
	}
	first = strings.Trim(string(runes), " .")
	if first == "" {
		return "Pasted text"
	}
	return first
}

// writeText saves pasted text as <textDir>/<id>/<first words>.txt and returns the path.
func (m *Module) writeText(text string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", core.ValidationError("Type or paste some text first", map[string]string{"text": "Type or paste some text first"})
	}
	if len(text) > MaxTextBytes {
		return "", core.ValidationError("That text is too long (limit 8 MB)", map[string]string{"text": "Too long"})
	}
	if m.textDir == "" {
		return "", core.Errorf(core.CodeInternal, "Pasted text isn't available")
	}
	var id [6]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", fmt.Errorf("make an id: %w", err)
	}
	dir := filepath.Join(m.textDir, hex.EncodeToString(id[:]))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create the text folder: %w", err)
	}
	path := filepath.Join(dir, slug(text)+".txt")
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return "", fmt.Errorf("save the text: %w", err)
	}
	return path, nil
}
