package subtitles

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"toolbox/core"
)

const (
	batchMaxCues  = 40
	batchMaxChars = 2500
	contextLines  = 3
)

func languageName(code string) string {
	for _, l := range translationLanguages() {
		if l.Code == code {
			return l.Name
		}
	}
	return code
}

// batches groups cue indexes into runs of ≤ 40 cues or 2,500 characters.
func batches(cues []Cue) [][2]int {
	var out [][2]int
	start, chars := 0, 0
	for i, c := range cues {
		n := runeLen(c.Text)
		if i > start && (i-start >= batchMaxCues || chars+n > batchMaxChars) {
			out = append(out, [2]int{start, i})
			start, chars = i, 0
		}
		chars += n
	}
	if start < len(cues) {
		out = append(out, [2]int{start, len(cues)})
	}
	return out
}

func systemPrompt(source, target string) string {
	src := "the original language"
	if source != "" {
		src = languageName(source)
	}
	return fmt.Sprintf("You translate subtitles from %s to %s. Translate each item; keep each one short enough to read on screen; keep line breaks (\\n) where natural; keep names; never add notes.", src, languageName(target))
}

func arraySchema(n int) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"type":"array","items":{"type":"string"},"minItems":%d,"maxItems":%d}`, n, n))
}

var stringSchema = json.RawMessage(`{"type":"string"}`)

func userPrompt(items []string, prev []string) string {
	b, _ := json.Marshal(items)
	if len(prev) == 0 {
		return string(b)
	}
	p, _ := json.Marshal(prev)
	return "Previously translated lines (context only, do not repeat them):\n" + string(p) +
		"\n\nTranslate these items and reply with a JSON array of exactly " + fmt.Sprint(len(items)) + " strings:\n" + string(b)
}

func stripFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
		s = strings.TrimSuffix(strings.TrimSpace(s), "```")
	}
	return strings.TrimSpace(s)
}

func parseBatchReply(reply string, n int) ([]string, bool) {
	var out []string
	if err := json.Unmarshal([]byte(stripFence(reply)), &out); err != nil || len(out) != n {
		return nil, false
	}
	return out, true
}

// translateBatch translates items; it retries once on a bad reply, then goes
// cue by cue.
func translateBatch(ctx context.Context, tg core.TextGenerator, source, target string, items, prev []string) ([]string, error) {
	sys := systemPrompt(source, target)
	req := core.CompletionRequest{
		System: sys, Prompt: userPrompt(items, prev), JSONSchema: arraySchema(len(items)),
		Temperature: 0.2, Purpose: "Translating subtitles",
	}
	for attempt := 0; attempt < 2; attempt++ {
		reply, err := tg.Complete(ctx, req)
		if err != nil {
			return nil, err
		}
		if out, ok := parseBatchReply(reply, len(items)); ok {
			return out, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	out := make([]string, len(items))
	for i, it := range items {
		one, _ := json.Marshal(it)
		reply, err := tg.Complete(ctx, core.CompletionRequest{
			System: sys, Prompt: string(one), JSONSchema: stringSchema,
			Temperature: 0.2, Purpose: "Translating subtitles",
		})
		if err != nil {
			return nil, err
		}
		var s string
		if json.Unmarshal([]byte(stripFence(reply)), &s) != nil {
			s = strings.Trim(strings.TrimSpace(reply), `"`)
		}
		if strings.TrimSpace(s) == "" {
			s = it
		}
		out[i] = s
	}
	return out, nil
}

// translateCues translates all cues, keeping timings. progress is called
// after each batch with the number of cues done.
func translateCues(ctx context.Context, tg core.TextGenerator, cues []Cue, source, target string, lineLen int, progress func(done int)) ([]Cue, error) {
	if lineLen <= 0 {
		lineLen = 42
	}
	out := make([]Cue, len(cues))
	var prev []string
	for _, br := range batches(cues) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		items := make([]string, 0, br[1]-br[0])
		for _, c := range cues[br[0]:br[1]] {
			items = append(items, c.Text)
		}
		tr, err := translateBatch(ctx, tg, source, target, items, prev)
		if err != nil {
			return nil, err
		}
		for k, t := range tr {
			c := cues[br[0]+k]
			text := strings.TrimSpace(t)
			if text == "" {
				text = c.Text
			}
			out[br[0]+k] = Cue{StartMs: c.StartMs, EndMs: c.EndMs, Text: rewrap(text, lineLen)}
		}
		prev = prev[:0]
		for _, c := range out[max(br[0], br[1]-contextLines):br[1]] {
			prev = append(prev, c.Text)
		}
		if progress != nil {
			progress(br[1])
		}
	}
	return out, nil
}
