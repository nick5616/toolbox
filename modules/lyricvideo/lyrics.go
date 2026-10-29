package lyricvideo

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"toolbox/core"
	"toolbox/core/sidecar"
)

const (
	stemsModel   = "UVR-MDX-NET-Inst_HQ_3.onnx" // the vocals-fast preset
	whisperModel = "small"
	whisperRepo  = "Systran/faster-whisper-small"

	vocalsName       = "vocals.flac"
	instrumentalName = "instrumental.flac"

	stemsPruneAge   = 7 * 24 * time.Hour
	previewPruneAge = 24 * time.Hour
)

// stemsDir is the cache folder for one song: sha1(path|size|mtime).
func (m *Module) stemsDir(song string) (string, error) {
	fi, err := os.Stat(song)
	if err != nil {
		return "", core.Errorf(core.CodeNotFound, "This song doesn't exist any more").WithHint(song)
	}
	sum := sha1.Sum([]byte(fmt.Sprintf("%s|%d|%d", song, fi.Size(), fi.ModTime().UnixNano())))
	return filepath.Join(m.cacheDir, hex.EncodeToString(sum[:])), nil
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

// cachedStems reports the cached vocals and instrumental paths ("" = absent).
func (m *Module) cachedStems(song string) (vocals, instrumental string) {
	dir, err := m.stemsDir(song)
	if err != nil {
		return "", ""
	}
	if p := filepath.Join(dir, vocalsName); fileExists(p) {
		vocals = p
	}
	if p := filepath.Join(dir, instrumentalName); fileExists(p) {
		instrumental = p
	}
	return vocals, instrumental
}

type stemsResult struct {
	Stems []struct {
		Name string `json:"name"`
		Path string `json:"path"`
	} `json:"stems"`
}

// ensureStems makes sure the vocals and instrumental of song are cached and
// returns their paths. Progress goes through job (callers scope it).
func (m *Module) ensureStems(ctx context.Context, job *core.JobContext, song string) (vocals, instrumental string, err error) {
	dir, err := m.stemsDir(song)
	if err != nil {
		return "", "", err
	}
	vocals, instrumental = m.cachedStems(song)
	if vocals != "" && instrumental != "" {
		now := time.Now()
		_ = os.Chtimes(dir, now, now) // keeps the folder out of the 7-day prune
		job.Progress(1, "Using the saved vocals")
		return vocals, instrumental, nil
	}
	if _, err := job.Tool(sidecar.DepID); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", core.Errorf(core.CodeInternal, "Couldn't create the lyric video cache").WithCause(err)
	}
	params := map[string]any{
		"input": song, "outputDir": dir, "model": stemsModel,
		"outputFormat": "flac", "baseName": "stem",
	}
	raw, err := m.sc.Call(ctx, "stems.separate", params, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			job.Progress(ev.Pct, ev.Msg)
		case "log":
			stream := core.StreamStdout
			if ev.Level == "warning" || ev.Level == "error" {
				stream = core.StreamStderr
			}
			job.Log(stream, ev.Line)
		}
	})
	if err != nil {
		return "", "", err
	}
	var res stemsResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", "", core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	for _, s := range res.Stems {
		var dst string
		switch strings.ToLower(s.Name) {
		case "vocals":
			dst = filepath.Join(dir, vocalsName)
		case "instrumental":
			dst = filepath.Join(dir, instrumentalName)
		default:
			continue
		}
		if s.Path != dst {
			_ = os.Remove(dst)
			if err := os.Rename(s.Path, dst); err != nil {
				return "", "", core.Errorf(core.CodeInternal, "Couldn't save the separated vocals").WithCause(err)
			}
		}
	}
	vocals, instrumental = m.cachedStems(song)
	if vocals == "" || instrumental == "" {
		return "", "", core.Errorf(core.CodeToolFailed, "The AI engine didn't produce vocals and an instrumental")
	}
	return vocals, instrumental, nil
}

// whisperDoc is the JSON transcribe.run writes.
type whisperDoc struct {
	Language string `json:"language"`
	Segments []struct {
		Start float64 `json:"start"`
		End   float64 `json:"end"`
		Text  string  `json:"text"`
		Words []struct {
			Start float64 `json:"start"`
			End   float64 `json:"end"`
			Word  string  `json:"word"`
		} `json:"words"`
	} `json:"segments"`
}

func secMs(s float64) int64 { return int64(s*1000 + 0.5) }

// parseWhisper turns the engine's JSON into segments.
func parseWhisper(data []byte) ([]recSegment, error) {
	var doc whisperDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("decoding the transcription: %w", err)
	}
	segs := make([]recSegment, 0, len(doc.Segments))
	for _, s := range doc.Segments {
		seg := recSegment{StartMs: secMs(s.Start), EndMs: secMs(s.End), Text: strings.TrimSpace(s.Text)}
		for _, w := range s.Words {
			seg.Words = append(seg.Words, recWord{StartMs: secMs(w.Start), EndMs: secMs(w.End), Text: strings.TrimSpace(w.Word)})
		}
		segs = append(segs, seg)
	}
	return segs, nil
}

func flattenWords(segs []recSegment) []recWord {
	var out []recWord
	for _, s := range segs {
		if len(s.Words) > 0 {
			out = append(out, s.Words...)
			continue
		}
		// A segment without word times: spread its words over it.
		ln := LyricLine{StartMs: s.StartMs, EndMs: s.EndMs, Text: s.Text}
		spreadWords(&ln)
		for _, w := range ln.Words {
			out = append(out, recWord{StartMs: w.StartMs, EndMs: w.EndMs, Text: w.Text})
		}
	}
	return out
}

// transcribeVocals runs transcribe.run on the isolated vocals.
func (m *Module) transcribeVocals(ctx context.Context, job *core.JobContext, vocals, language string) ([]recSegment, error) {
	var lang any
	if language != "" {
		lang = language
	}
	params := map[string]any{
		"input": vocals, "outputDir": job.TempDir, "baseName": "lyrics",
		"model": whisperRepo, "modelDir": filepath.Join(m.modelsDir, "whisper", whisperModel),
		"language": lang, "task": "transcribe", "formats": []string{"json"}, "vad": true,
	}
	raw, err := m.sc.Call(ctx, "transcribe.run", params, func(ev sidecar.Event) {
		switch ev.Kind {
		case "progress":
			job.Progress(ev.Pct, ev.Msg)
		case "log":
			stream := core.StreamStdout
			if ev.Level == "warning" || ev.Level == "error" {
				stream = core.StreamStderr
			}
			job.Log(stream, ev.Line)
		}
	})
	if err != nil {
		return nil, err
	}
	var res struct {
		Outputs []string `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, core.Errorf(core.CodeInternal, "The AI engine returned an unreadable result").WithCause(err)
	}
	for _, p := range res.Outputs {
		if strings.EqualFold(filepath.Ext(p), ".json") {
			data, err := os.ReadFile(p)
			if err != nil {
				return nil, fmt.Errorf("reading the transcription: %w", err)
			}
			segs, err := parseWhisper(data)
			if err != nil {
				return nil, core.Errorf(core.CodeInternal, "The AI engine returned an unreadable transcription").WithCause(err)
			}
			return segs, nil
		}
	}
	return nil, core.Errorf(core.CodeToolFailed, "The AI engine didn't write word timings")
}

// runLyrics is the "lyrics" action.
func (m *Module) runLyrics(ctx context.Context, job *core.JobContext, o Options) error {
	song := job.Inputs[0]
	job.SetTitle(filepath.Base(song))
	res := Result{Action: ActionLyrics, Lines: []LyricLine{}}

	source := o.Source
	text := o.Text
	if source == SourceFile {
		data, err := os.ReadFile(o.LyricsPath)
		if err != nil {
			return core.Errorf(core.CodeNotFound, "Couldn't read the lyrics file").WithHint(o.LyricsPath).WithCause(err)
		}
		switch strings.ToLower(filepath.Ext(o.LyricsPath)) {
		case ".lrc":
			res.Lines = ParseLRC(string(data))
		case ".srt", ".vtt":
			res.Lines = ParseCues(string(data))
		default: // .txt: align it
			source, text = SourceAlign, string(data)
		}
		if source == SourceFile {
			if len(res.Lines) == 0 {
				return core.Errorf(core.CodeValidation, "No lyric lines found in that file").WithHint("Check that it has timestamps")
			}
			res.Matched = 1
			_, inst := m.cachedStems(song)
			res.HasInstrumental = inst != ""
			job.Progress(1, fmt.Sprintf("%d lines", len(res.Lines)))
			return job.SetResult(res)
		}
	}
	if strings.TrimSpace(text) == "" && source == SourceAlign {
		return core.ValidationError("Paste the lyrics first", map[string]string{"text": "Paste the lyrics first"})
	}

	vocals, _, err := m.ensureStems(ctx, job.Scoped(0, 0.5), song)
	if err != nil {
		return err
	}
	segs, err := m.transcribeVocals(ctx, job.Scoped(0.5, 0.95), vocals, o.Language)
	if err != nil {
		return err
	}
	if source == SourceDetect {
		res.Lines = DetectLines(segs)
		if len(res.Lines) == 0 {
			return core.Errorf(core.CodeToolFailed, "No words were recognised").
				WithHint("Try pasting the lyrics instead")
		}
		res.Matched = 1
	} else {
		res.Lines, res.Matched = AlignLyrics(text, flattenWords(segs))
	}
	_, inst := m.cachedStems(song)
	res.HasInstrumental = inst != ""
	job.Progress(1, fmt.Sprintf("%d lines", len(res.Lines)))
	return job.SetResult(res)
}

// pruneCache deletes stems folders untouched for 7 days and previews older
// than a day.
func (m *Module) pruneCache() {
	if m.cacheDir == "" {
		return
	}
	entries, err := os.ReadDir(m.cacheDir)
	if err != nil {
		return
	}
	now := time.Now()
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		age := now.Sub(info.ModTime())
		switch {
		case e.IsDir() && age > stemsPruneAge:
			_ = os.RemoveAll(filepath.Join(m.cacheDir, e.Name()))
		case !e.IsDir() && strings.HasPrefix(e.Name(), "preview-") && age > previewPruneAge:
			_ = os.Remove(filepath.Join(m.cacheDir, e.Name()))
		}
	}
}
