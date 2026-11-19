package mediaindex

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"toolbox/core"
	"toolbox/core/deps"
	"toolbox/core/doctext"
	ix "toolbox/core/mediaindex"
	"toolbox/core/sidecar"
)

// The media-speech job (SPEC.md §3.5).

// Speech chunking and the "is there any speech" rule.
const (
	speechChunkMs    = 30_000
	speechChunkChars = 1000
	minSpeechShare   = 0.05

	// whisperRepo and whisperDir are the Whisper small model modules/transcribe
	// uses ("whisper-default"): <models>/whisper/small.
	whisperRepo = "Systran/faster-whisper-small"
	whisperDir  = "small"
)

// mergeCues merges consecutive cues into chunks of at most 30 s and 1,000
// characters. Chunks carry Pos/EndPos in ms. A single longer cue is split on
// its text with the cue's times.
func mergeCues(cues []doctext.Chunk, source string) []core.MediaText {
	out := []core.MediaText{}
	var cur *core.MediaText
	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}
	for _, c := range cues {
		text := strings.Join(strings.Fields(c.Text), " ")
		if text == "" {
			continue
		}
		end := max(c.EndPos, c.Pos)
		if len([]rune(text)) > speechChunkChars {
			flush()
			for _, part := range doctext.SplitText(text) {
				out = append(out, core.MediaText{Source: source, Pos: c.Pos, EndPos: end, Text: part})
			}
			continue
		}
		if cur != nil && (end-cur.Pos > speechChunkMs || len([]rune(cur.Text))+1+len([]rune(text)) > speechChunkChars) {
			flush()
		}
		if cur == nil {
			cur = &core.MediaText{Source: source, Pos: c.Pos, EndPos: end, Text: text}
			continue
		}
		cur.Text += " " + text
		cur.EndPos = max(cur.EndPos, end)
	}
	flush()
	return out
}

// spokenMs is the total time the cues cover (overlaps counted once).
func spokenMs(cues []doctext.Chunk) int64 {
	var total, upTo int64
	for _, c := range cues {
		start, end := c.Pos, max(c.EndPos, c.Pos)
		if start < upTo {
			start = upTo
		}
		if end > start {
			total += end - start
			upTo = end
		}
	}
	return total
}

// transcriptCues reads a transcript output: .srt/.vtt through doctext, or the
// transcribe module's JSON ({segments:[{start,end,text}]} in seconds).
func transcriptCues(path string) ([]doctext.Chunk, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".srt", ".vtt":
		return doctext.Extract(path, doctext.DefaultLimit)
	case ".json":
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var doc struct {
			Segments []struct {
				Start float64 `json:"start"`
				End   float64 `json:"end"`
				Text  string  `json:"text"`
			} `json:"segments"`
		}
		if err := json.Unmarshal(b, &doc); err != nil {
			return nil, fmt.Errorf("not a transcript: %w", err)
		}
		out := make([]doctext.Chunk, 0, len(doc.Segments))
		for _, s := range doc.Segments {
			out = append(out, doctext.Chunk{Pos: int64(s.Start * 1000), EndPos: int64(s.End * 1000), Text: s.Text})
		}
		return out, nil
	}
	return nil, fmt.Errorf("not a transcript")
}

func (m *SpeechModule) run(ctx context.Context, job *core.JobContext) error {
	o, err := core.DecodeOptions[ix.SpeechOptions](job)
	if err != nil {
		return err
	}
	if len(job.Inputs) != 1 {
		return core.ValidationError("Speech is read one file at a time", nil)
	}
	w := m.d.Writer
	if w == nil {
		return core.Errorf(core.CodeInternal, "Smart search isn't set up")
	}
	path := job.Inputs[0]
	job.SetTitle(filepath.Base(path))
	res := ix.SpeechResult{Path: path, Chunks: []core.MediaText{}}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		res.Failed = "The file isn't there any more"
		return w.StoreSpeech(ctx, res)
	}
	res.Size, res.ModMs = fi.Size(), fi.ModTime().UnixMilli()

	// Reuse an existing transcript first (no engine needed).
	if trs, err := w.TranscriptsFor(ctx, path); err != nil {
		job.Logf("looking for transcripts: %v", err)
	} else {
		for _, tr := range trs {
			if err := ctx.Err(); err != nil {
				return err
			}
			cues, err := transcriptCues(tr)
			if err != nil || len(cues) == 0 {
				continue
			}
			res.Chunks = mergeCues(cues, core.TextSourceSubs)
			if len(res.Chunks) == 0 {
				continue
			}
			job.Progress(1, "Used an existing transcript")
			return w.StoreSpeech(ctx, res)
		}
	}

	// Otherwise transcribe.
	ffprobe, err := job.Tool(deps.FFprobe)
	if err != nil {
		return err
	}
	info, err := probeMedia(ctx, ffprobe, path)
	if err != nil {
		res.Failed = "Couldn't read this file: " + reason(err)
		return w.StoreSpeech(ctx, res)
	}
	if limit := w.SpeechMaxMin(); !o.Force && limit > 0 && info.DurationMs > int64(limit)*60_000 {
		res.Skipped = fmt.Sprintf("Longer than %d min", limit)
		return w.StoreSpeech(ctx, res)
	}
	if len(info.Audio) == 0 {
		res.NoSpeech = true
		return w.StoreSpeech(ctx, res)
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return err
	}
	if _, err := job.Tool(deps.FFmpeg); err != nil {
		return err
	}
	outDir := filepath.Join(job.TempDir, "speech")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("create speech folder: %w", err)
	}
	raw, err := m.d.Caller.Call(ctx, "transcribe.run", map[string]any{
		"input":     path,
		"outputDir": outDir,
		"baseName":  "speech",
		"model":     whisperRepo,
		"modelDir":  filepath.Join(m.d.ModelsDir, "whisper", whisperDir),
		"language":  nil, // auto-detect
		"task":      "transcribe",
		"formats":   []string{"srt"}, // no word timestamps
		"vad":       true,
	}, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			job.Progress(ev.Pct, ev.Msg)
		case "log":
			job.Log(core.StreamStdout, ev.Line)
		}
	})
	if err != nil {
		return err
	}
	var tr struct {
		DurationSec float64  `json:"durationSec"`
		Outputs     []string `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &tr); err != nil {
		return core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	var cues []doctext.Chunk
	for _, p := range tr.Outputs {
		if strings.EqualFold(filepath.Ext(p), ".srt") {
			if cues, err = doctext.Extract(p, doctext.DefaultLimit); err != nil {
				res.Failed = "Couldn't read the transcript: " + reason(err)
				return w.StoreSpeech(ctx, res)
			}
			break
		}
	}
	dur := info.DurationMs
	if dur <= 0 {
		dur = int64(tr.DurationSec * 1000)
	}
	if len(cues) == 0 || (dur > 0 && float64(spokenMs(cues)) < minSpeechShare*float64(dur)) {
		res.NoSpeech = true
		return w.StoreSpeech(ctx, res)
	}
	res.Chunks = mergeCues(cues, core.TextSourceSpeech)
	job.Progress(1, fmt.Sprintf("%d passages", len(res.Chunks)))
	return w.StoreSpeech(ctx, res)
}
