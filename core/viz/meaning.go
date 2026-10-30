package viz

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"unicode"

	"toolbox/core"
	"toolbox/core/sidecar"
)

// The meaning of the words (SPEC.md §5.4): the mood reader (engine) and the
// optional Deeper reading with the Local Chat model.

var (
	emotions = []string{"joy", "love", "sadness", "anger", "fear", "calm", "hope", "awe"}
	motifSet = []string{"fire", "rain", "snow", "stars", "ocean", "flowers", "hearts", "city", "sun", "night", "storm", "smoke"}
)

const (
	chatBatchLines  = 30
	chatBatchChars  = 2500
	chatContextRows = 3
	chatConfidence  = 0.7
	readerTrusted   = 0.5 // the reader keeps the emotion at or above this confidence
	maxMotifs       = 3

	deepSystem = "You read song lyrics or speech and describe how each line feels, for a music visualiser. " +
		"For each line give: valence from -1 (dark, sad) to 1 (bright, happy); energy from 0 (still) to 1 (intense); " +
		"one emotion; up to 3 visual motifs only if the line clearly evokes them; up to 2 words from the line to emphasise. " +
		"Answer only with the JSON."
)

func neutralMeaning() meaning {
	return meaning{Valence: 0, Energy: 0.5, Emotion: "calm", Confidence: 0, Motifs: []string{}}
}

func hasLetter(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) {
			return true
		}
	}
	return false
}

func engineEvents(job *core.JobContext) func(sidecar.Event) {
	return func(ev sidecar.Event) {
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
	}
}

// readMood runs the engine's mood reader over the lines' texts.
func (a *Analyzer) readMood(ctx context.Context, job *core.JobContext, lines []textLine, model, tokenizer string) ([]meaning, error) {
	texts := make([]string, len(lines))
	for i, l := range lines {
		texts[i] = l.Text
	}
	params := map[string]any{
		"lines": texts, "modelPath": model, "tokenizerPath": tokenizer,
		"anchorsCachePath": filepath.Join(a.modelsDir, "mood", "anchors.npy"),
	}
	raw, err := a.sc.Call(ctx, "viz.mood", params, engineEvents(job))
	if err != nil {
		return nil, err
	}
	var res struct {
		Lines []struct {
			Emotion    string   `json:"emotion"`
			Confidence float64  `json:"confidence"`
			Valence    float64  `json:"valence"`
			Energy     float64  `json:"energy"`
			Motifs     []string `json:"motifs"`
		} `json:"lines"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("decoding the mood reading: %w", err)
	}
	if len(res.Lines) != len(lines) {
		return nil, fmt.Errorf("the mood reader returned %d readings for %d lines", len(res.Lines), len(lines))
	}
	out := make([]meaning, len(lines))
	for i, r := range res.Lines {
		m := meaning{Valence: clamp(r.Valence, -1, 1), Energy: clamp(r.Energy, 0, 1), Emotion: r.Emotion,
			Confidence: clamp(r.Confidence, 0, 1), Motifs: filterMotifs(r.Motifs)}
		if !slices.Contains(emotions, m.Emotion) {
			m.Emotion = "calm"
			m.Confidence = 0
		}
		out[i] = m
	}
	return out, nil
}

func clamp(v, lo, hi float64) float64 { return min(max(v, lo), hi) }

// filterMotifs keeps known motifs, in order, at most 3, never nil.
func filterMotifs(in []string) []string {
	out := []string{}
	for _, m := range in {
		if slices.Contains(motifSet, m) && !slices.Contains(out, m) && len(out) < maxMotifs {
			out = append(out, m)
		}
	}
	return out
}

// ---- Deeper reading -------------------------------------------------------

// chatReading is one line's reading from the chat model; ok is false when the
// model could not read it (the line then keeps the reader's result).
type chatReading struct {
	m        meaning
	emphasis []string
	ok       bool
}

// errBadReply marks a reply that failed the schema or had the wrong count.
var errBadReply = errors.New("the chat reply didn't match the schema")

func deepSchema(n int) json.RawMessage {
	s := map[string]any{
		"type": "array", "minItems": n, "maxItems": n,
		"items": map[string]any{
			"type":     "object",
			"required": []string{"valence", "energy", "emotion", "motifs", "emphasis"},
			"properties": map[string]any{
				"valence":  map[string]any{"type": "number", "minimum": -1, "maximum": 1},
				"energy":   map[string]any{"type": "number", "minimum": 0, "maximum": 1},
				"emotion":  map[string]any{"type": "string", "enum": emotions},
				"motifs":   map[string]any{"type": "array", "maxItems": 3, "items": map[string]any{"type": "string", "enum": motifSet}},
				"emphasis": map[string]any{"type": "array", "maxItems": 2, "items": map[string]any{"type": "string"}},
			},
		},
	}
	b, _ := json.Marshal(s)
	return b
}

func deepPrompt(context, texts []string) string {
	var b strings.Builder
	if len(context) > 0 {
		b.WriteString("Previous lines, for context only (do not rate them):\n")
		for _, c := range context {
			b.WriteString("- " + c + "\n")
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "Rate these %d lines, in order, as a JSON array of exactly %d objects:\n", len(texts), len(texts))
	for i, t := range texts {
		fmt.Fprintf(&b, "%d. %s\n", i+1, t)
	}
	return b.String()
}

// parseDeep validates a reply for n lines.
func parseDeep(reply string, n int) ([]chatReading, error) {
	reply = strings.TrimSpace(reply)
	if strings.HasPrefix(reply, "```") {
		reply = strings.TrimPrefix(reply, "```json")
		reply = strings.TrimPrefix(reply, "```")
		reply = strings.TrimSuffix(strings.TrimSpace(reply), "```")
	}
	var items []struct {
		Valence  *float64 `json:"valence"`
		Energy   *float64 `json:"energy"`
		Emotion  string   `json:"emotion"`
		Motifs   []string `json:"motifs"`
		Emphasis []string `json:"emphasis"`
	}
	if err := json.Unmarshal([]byte(reply), &items); err != nil || len(items) != n {
		return nil, errBadReply
	}
	out := make([]chatReading, n)
	for i, it := range items {
		if it.Valence == nil || it.Energy == nil || *it.Valence < -1 || *it.Valence > 1 || *it.Energy < 0 || *it.Energy > 1 ||
			!slices.Contains(emotions, it.Emotion) || len(it.Motifs) > maxMotifs || len(it.Emphasis) > 2 {
			return nil, errBadReply
		}
		for _, m := range it.Motifs {
			if !slices.Contains(motifSet, m) {
				return nil, errBadReply
			}
		}
		out[i] = chatReading{m: meaning{Valence: *it.Valence, Energy: *it.Energy, Emotion: it.Emotion,
			Confidence: chatConfidence, Motifs: filterMotifs(it.Motifs)}, emphasis: it.Emphasis, ok: true}
	}
	return out, nil
}

// rate asks the model about texts; errBadReply means the reply was unusable,
// any other error is a failed call.
func (a *Analyzer) rate(ctx context.Context, before, texts []string) ([]chatReading, error) {
	reply, err := a.textgen.Complete(ctx, core.CompletionRequest{
		System: deepSystem, Prompt: deepPrompt(before, texts), JSONSchema: deepSchema(len(texts)),
		MaxTokens: 120*len(texts) + 256, Temperature: 0.2, Purpose: "Reading the mood of the words",
	})
	if err != nil {
		return nil, err
	}
	return parseDeep(reply, len(texts))
}

// rateBatch rates one batch with the recovery of §5.4: one retry, then line by
// line, then a neutral reading.
func (a *Analyzer) rateBatch(ctx context.Context, before, texts []string) ([]chatReading, error) {
	for try := 0; try < 2; try++ {
		rs, err := a.rate(ctx, before, texts)
		if err == nil {
			return rs, nil
		}
		if !errors.Is(err, errBadReply) {
			return nil, err
		}
	}
	out := make([]chatReading, len(texts))
	for i, t := range texts {
		rs, err := a.rate(ctx, nil, []string{t})
		switch {
		case err == nil:
			out[i] = rs[0]
		case errors.Is(err, errBadReply):
			out[i] = chatReading{m: neutralMeaning()}
		default:
			return nil, err
		}
	}
	return out, nil
}

// deepRead reads every line that has letters with the chat model, in batches
// of up to 30 lines or 2,500 characters. A failed call (not a bad reply) stops
// the reading and returns the error.
func (a *Analyzer) deepRead(ctx context.Context, job *core.JobContext, lines []textLine) ([]chatReading, error) {
	out := make([]chatReading, len(lines))
	for i := range out {
		out[i] = chatReading{m: neutralMeaning()}
	}
	var idx []int
	for i, l := range lines {
		if hasLetter(l.Text) {
			idx = append(idx, i)
		}
	}
	var prev []string
	for pos := 0; pos < len(idx); {
		end, chars := pos, 0
		for end < len(idx) && end-pos < chatBatchLines {
			n := len([]rune(lines[idx[end]].Text))
			if end > pos && chars+n > chatBatchChars {
				break
			}
			chars += n
			end++
		}
		texts := make([]string, 0, end-pos)
		for _, i := range idx[pos:end] {
			texts = append(texts, lines[i].Text)
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		rs, err := a.rateBatch(ctx, prev, texts)
		if err != nil {
			return nil, err
		}
		for k, i := range idx[pos:end] {
			out[i] = rs[k]
		}
		prev = texts[max(0, len(texts)-chatContextRows):]
		pos = end
		job.Progress(float64(pos)/float64(len(idx)), "Reading the words more deeply")
	}
	return out, nil
}

// mergeReading combines the reader's result (nil = none) with the chat's
// (SPEC.md §5.4): below 0.5 reader confidence the chat's emotion, valence and
// energy replace the reader's, otherwise valence and energy are averaged and
// the emotion stays; motifs are the union, the reader's first, at most 3.
func mergeReading(reader *meaning, chat chatReading) meaning {
	switch {
	case !chat.ok && reader == nil:
		return neutralMeaning()
	case !chat.ok:
		return *reader
	case reader == nil:
		return chat.m
	}
	m := *reader
	if reader.Confidence < readerTrusted {
		m.Emotion, m.Valence, m.Energy = chat.m.Emotion, chat.m.Valence, chat.m.Energy
		m.Confidence = max(reader.Confidence, chat.m.Confidence)
	} else {
		m.Valence = (reader.Valence + chat.m.Valence) / 2
		m.Energy = (reader.Energy + chat.m.Energy) / 2
	}
	m.Motifs = filterMotifs(append(slices.Clone(reader.Motifs), chat.m.Motifs...))
	return m
}
