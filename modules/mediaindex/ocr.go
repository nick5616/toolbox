package mediaindex

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/doctext"
	ix "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
)

type ocrTarget struct {
	item *prepared
	pic  *pic
}

// ocrTargets lists the pictures whose text is read: a PDF page without a text
// layer always, any other picture when the text gate passes its vector.
func ocrTargets(w ix.Writer, items []*prepared) []ocrTarget {
	var out []ocrTarget
	for _, it := range items {
		for _, p := range it.pics {
			if p.ocr == "" {
				continue
			}
			if p.force || (len(p.vec) > 0 && w.NeedsOCR(p.vec)) {
				out = append(out, ocrTarget{it, p})
			}
		}
	}
	return out
}

// readText runs the engine's ocr.image on every target and adds what it reads
// to the item as source "ocr" chunks. One picture failing never fails the
// batch.
func (m *IndexModule) readText(ctx context.Context, job *core.JobContext, w ix.Writer, items []*prepared) error {
	targets := ocrTargets(w, items)
	if len(targets) == 0 {
		return nil
	}
	outDir := filepath.Join(job.TempDir, "ocr")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("create ocr folder: %w", err)
	}
	last := map[*prepared]string{}
	for i, t := range targets {
		if err := ctx.Err(); err != nil {
			return err
		}
		job.Progress(float64(i)/float64(len(targets)), fmt.Sprintf("Reading text · %d/%d", i+1, len(targets)))
		text, err := m.ocrOne(ctx, job, outDir, fmt.Sprintf("o%d", i), t.pic.ocr)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			job.Logf("text reading failed for %s: %v", filepath.Base(t.item.res.Path), err)
			continue
		}
		if text == "" || text == last[t.item] {
			continue // nothing read, or the same words as the previous frame
		}
		last[t.item] = text
		for _, part := range doctext.SplitText(text) {
			t.item.res.Texts = append(t.item.res.Texts, core.MediaText{Source: core.TextSourceOCR, Pos: t.pic.pos, EndPos: -1, Text: part})
		}
	}
	return nil
}

// ocrOne calls ocr.image on one JPEG (bundled models, text output into
// outDir) and returns the text it read.
func (m *IndexModule) ocrOne(ctx context.Context, job *core.JobContext, outDir, base, input string) (string, error) {
	raw, err := m.d.Caller.Call(ctx, "ocr.image", map[string]any{
		"input":     input,
		"outputDir": outDir,
		"baseName":  base,
		"output":    "text",
		"det":       nil,
		"rec":       nil,
		"modelDir":  filepath.Join(m.d.ModelsDir, "ocr"),
	}, func(ev sidecar.Event) {
		if ev.Kind == "log" {
			job.Log(core.StreamStdout, ev.Line)
		}
		// "output" events are the scratch text file in TempDir: not registered.
	})
	if err != nil {
		return "", err
	}
	var res struct {
		Lines   int    `json:"lines"`
		Output  string `json:"output"`
		Preview string `json:"preview"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", fmt.Errorf("unreadable ocr result: %w", err)
	}
	if res.Lines == 0 {
		return "", nil
	}
	if res.Output == "" {
		return strings.TrimSpace(res.Preview), nil
	}
	b, err := os.ReadFile(res.Output)
	if err != nil {
		return strings.TrimSpace(res.Preview), nil
	}
	return strings.TrimSpace(string(b)), nil
}
