package pipelines

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// Chat limits and constants (SPEC.md §7.3).
const (
	maxTextFileBytes = 256 * 1024
	charsPerToken    = 3.5
	mapPrompt        = "Take concise notes of this part of a longer text, keeping any [h:mm:ss] timestamps:"
	// maxReduceRounds bounds how often notes are condensed again.
	maxReduceRounds = 3
	mapMaxTokens    = 1024
)

// reservedVarNames can't be chat field names: they are built in.
var reservedVarNames = map[string]bool{
	"item": true, "name": true, "ext": true, "role": true, "n": true,
	"date": true, "time": true, "pipeline": true, "file": true, "reply": true,
}

func validateChatJob(c ChatJob) error {
	if c.Mode != ChatWrite && c.Mode != ChatExtract {
		return core.ValidationError("Choose whether to write text or extract fields", nil)
	}
	if strings.TrimSpace(c.Prompt) == "" {
		return core.ValidationError("Write a prompt for the chat model", nil)
	}
	if utf8.RuneCountInString(c.Prompt) > maxPromptChars {
		return core.ValidationError(fmt.Sprintf("The prompt can be at most %d characters", maxPromptChars), nil)
	}
	if utf8.RuneCountInString(c.System) > maxSystemChars {
		return core.ValidationError(fmt.Sprintf("The instructions can be at most %d characters", maxSystemChars), nil)
	}
	if c.Temperature < 0 || c.Temperature > 1.5 {
		return core.ValidationError("Temperature must be between 0 and 1.5", nil)
	}
	if c.Mode == ChatExtract {
		return validateFields(c.Fields)
	}
	if c.Format != FormatMD && c.Format != FormatTXT {
		return core.ValidationError("Save the text as Markdown or plain text", nil)
	}
	return nil
}

func validateFields(fields []ChatField) error {
	if len(fields) < 1 || len(fields) > maxChatFields {
		return core.ValidationError(fmt.Sprintf("Extract 1 to %d fields", maxChatFields), nil)
	}
	seen := map[string]bool{}
	for i, f := range fields {
		switch {
		case !core.VarName.MatchString(f.Name):
			return core.ValidationError(fmt.Sprintf("Field %d: the name must be lowercase letters, digits and _, starting with a letter", i+1), nil)
		case reservedVarNames[f.Name]:
			return core.ValidationError(fmt.Sprintf("Field %d: {%s} is a built-in name, pick another", i+1, f.Name), nil)
		case seen[f.Name]:
			return core.ValidationError(fmt.Sprintf("Field %d: {%s} is used twice", i+1, f.Name), nil)
		case strings.TrimSpace(f.Label) == "":
			return core.ValidationError(fmt.Sprintf("Field %d needs a label", i+1), nil)
		case f.Type != "text" && f.Type != "number" && f.Type != "date":
			return core.ValidationError(fmt.Sprintf("Field %d: the type must be text, number or date", i+1), nil)
		}
		seen[f.Name] = true
	}
	return nil
}

// ---- run ------------------------------------------------------------------

func (m *Module) runChat(ctx context.Context, job *core.JobContext, o Options) error {
	c := *o.Chat
	if m.tg == nil {
		return core.Errorf(core.CodeDependencyMissing, "Local Chat isn't available").WithHint("Download a model in Local Chat first")
	}
	if _, err := m.tg.Ready(); err != nil {
		return err
	}
	dir, err := outDir(job, o.Pipeline)
	if err != nil {
		return err
	}
	label := c.Label
	if label == "" {
		label = "Ask Local Chat"
	}
	purpose := "Pipeline · " + label

	job.Progress(core.IndeterminateProgress, "Preparing the prompt")
	system, prompt, err := m.buildPrompt(ctx, job, c, purpose)
	if err != nil {
		return err
	}
	job.Progress(core.IndeterminateProgress, "Asking the chat model")

	if c.Mode == ChatExtract {
		return m.runExtract(ctx, job, c, dir, system, prompt, purpose)
	}
	reply, err := m.tg.Complete(ctx, core.CompletionRequest{
		System: system, Prompt: prompt, MaxTokens: 2048, Temperature: c.Temperature, Purpose: purpose,
	})
	if err != nil {
		return err
	}
	reply = strings.TrimSpace(reply)
	if reply == "" {
		return core.Errorf(core.CodeToolFailed, "The chat model's answer was empty").WithHint("Try again, or change the prompt")
	}
	stem := cleanName(c.OutputName)
	if stem == "" {
		stem = "Notes"
	}
	p, err := reserve(dir, stem, "."+c.Format)
	if err != nil {
		return err
	}
	if err := os.WriteFile(p, []byte(reply+"\n"), 0o644); err != nil {
		_ = os.Remove(p)
		return fmt.Errorf("writing %s: %w", filepath.Base(p), err)
	}
	rf, err := addOutput(job, p, "text", "Text")
	if err != nil {
		return err
	}
	// The reply itself is not in the result (64 KB cap): StepOutputs reads it from the file.
	return job.SetResult(jobResult{Files: []core.RunFile{rf}})
}

func (m *Module) runExtract(ctx context.Context, job *core.JobContext, c ChatJob, dir, system, prompt, purpose string) error {
	schema := fieldSchema(c.Fields)
	system = strings.TrimSpace(system + "\n\n" + extractInstructions(c.Fields))
	var vals map[string]string
	var lastErr error
	for attempt, temp := range []float64{c.Temperature, 0} {
		reply, err := m.tg.Complete(ctx, core.CompletionRequest{
			System: system, Prompt: prompt, JSONSchema: schema, MaxTokens: 512, Temperature: temp, Purpose: purpose,
		})
		if err != nil {
			return err
		}
		vals, lastErr = parseFields(reply, c.Fields)
		if lastErr == nil {
			break
		}
		if attempt == 0 {
			job.Logf("The answer wasn't usable (%v); trying once more", lastErr)
		}
	}
	if lastErr != nil {
		return core.Errorf(core.CodeToolFailed, "The chat model's answer wasn't usable").
			WithHint("Try again, simplify the fields, or pick a larger model").WithCause(lastErr)
	}
	res := jobResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for k, v := range vals {
		v, _ = core.CapVar(v)
		res.Vars[k] = v
	}
	if c.SaveJSON {
		stem := cleanName(c.OutputName)
		if stem == "" {
			stem = "Fields"
		}
		p, err := reserve(dir, stem, ".json")
		if err != nil {
			return err
		}
		if err := os.WriteFile(p, orderedJSON(c.Fields, vals), 0o644); err != nil {
			_ = os.Remove(p)
			return fmt.Errorf("writing %s: %w", filepath.Base(p), err)
		}
		rf, err := addOutput(job, p, "json", "JSON")
		if err != nil {
			return err
		}
		res.Files = append(res.Files, rf)
	}
	return job.SetResult(res)
}

// fieldSchema is the JSON schema of an extract reply: one required string
// property per field.
func fieldSchema(fields []ChatField) json.RawMessage {
	props := map[string]any{}
	names := make([]string, 0, len(fields))
	for _, f := range fields {
		desc := f.Label
		switch f.Type {
		case "number":
			desc += " (a number, digits only)"
		case "date":
			desc += " (a date as YYYY-MM-DD)"
		}
		props[f.Name] = map[string]any{"type": "string", "description": desc}
		names = append(names, f.Name)
	}
	b, _ := json.Marshal(map[string]any{
		"type": "object", "properties": props, "required": names, "additionalProperties": false,
	})
	return b
}

func extractInstructions(fields []ChatField) string {
	var b strings.Builder
	b.WriteString("Reply with one JSON object and nothing else. Every value is a string; use an empty string when the text doesn't say. Fields:")
	for _, f := range fields {
		fmt.Fprintf(&b, "\n- %s: %s (%s)", f.Name, f.Label, f.Type)
	}
	return b.String()
}

// parseFields reads an extract reply: a JSON object holding every field.
func parseFields(reply string, fields []ChatField) (map[string]string, error) {
	s := strings.TrimSpace(reply)
	if i, j := strings.Index(s, "{"), strings.LastIndex(s, "}"); i >= 0 && j > i {
		s = s[i : j+1]
	}
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("not a JSON object: %w", err)
	}
	out := make(map[string]string, len(fields))
	for _, f := range fields {
		v, ok := raw[f.Name]
		if !ok {
			return nil, fmt.Errorf("the field %q is missing", f.Name)
		}
		switch t := v.(type) {
		case string:
			out[f.Name] = strings.TrimSpace(t)
		case json.Number:
			out[f.Name] = t.String()
		case bool:
			out[f.Name] = strconv.FormatBool(t)
		case nil:
			out[f.Name] = ""
		default:
			return nil, fmt.Errorf("the field %q isn't a single value", f.Name)
		}
	}
	return out, nil
}

// orderedJSON writes the fields as an indented JSON object in field order.
func orderedJSON(fields []ChatField, vals map[string]string) []byte {
	var b bytes.Buffer
	b.WriteString("{\n")
	for i, f := range fields {
		k, _ := json.Marshal(f.Name)
		v, _ := json.Marshal(vals[f.Name])
		fmt.Fprintf(&b, "  %s: %s", k, v)
		if i < len(fields)-1 {
			b.WriteByte(',')
		}
		b.WriteByte('\n')
	}
	b.WriteString("}\n")
	return b.Bytes()
}

// ---- long text ------------------------------------------------------------

// promptBudget is the number of characters a prompt may take:
// ContextTokens × 0.7 − 1,024 tokens at 3.5 characters per token.
func promptBudget(contextTokens int) int {
	if contextTokens <= 0 {
		contextTokens = 4096
	}
	tokens := float64(contextTokens)*0.7 - 1024
	if tokens < 256 {
		tokens = 256
	}
	return int(tokens * charsPerToken)
}

// buildPrompt expands the prompt with its variables. When the result is over
// the budget, the longest variable is read in chunks (map) and replaced by
// the notes (reduce), up to a few rounds.
func (m *Module) buildPrompt(ctx context.Context, job *core.JobContext, c ChatJob, purpose string) (system, prompt string, err error) {
	budget := promptBudget(m.tg.ContextTokens())
	vars := make(map[string]string, len(c.Vars))
	for k, v := range c.Vars {
		vars[k] = v
	}
	expand := func() (string, string) {
		sys, _ := core.ExpandVars(c.System, vars)
		p, missing := core.ExpandVars(c.Prompt, vars)
		if len(missing) > 0 {
			job.Logf("Unknown variables in the prompt (left empty): %s", strings.Join(missing, ", "))
		}
		return sys, p
	}
	system, prompt = expand()
	used := core.TemplateVars(c.Prompt)
	for round := 0; round < maxReduceRounds && len(system)+len(prompt) > budget; round++ {
		name := ""
		for _, u := range used {
			if v, ok := vars[u]; ok && len(v) > len(vars[name]) {
				name = u
			}
		}
		chunkSize := budget / 2
		if name == "" || len(vars[name]) <= chunkSize {
			break
		}
		chunks := splitChunks(vars[name], chunkSize)
		if len(chunks) < 2 {
			break
		}
		if round == 0 {
			job.Logf("Long text: read in %d parts", len(chunks))
		} else {
			job.Logf("Long text: condensing again in %d parts", len(chunks))
		}
		notes := make([]string, 0, len(chunks))
		for i, ch := range chunks {
			if err := ctx.Err(); err != nil {
				return "", "", err
			}
			job.Progress(float64(i)/float64(len(chunks))*0.8, fmt.Sprintf("Reading part %d of %d", i+1, len(chunks)))
			reply, err := m.tg.Complete(ctx, core.CompletionRequest{
				Prompt: mapPrompt + "\n\n" + ch, MaxTokens: mapMaxTokens, Temperature: 0.2, Purpose: purpose,
			})
			if err != nil {
				return "", "", err
			}
			notes = append(notes, strings.TrimSpace(reply))
		}
		vars[name] = strings.Join(notes, "\n\n")
		system, prompt = expand()
	}
	return system, prompt, nil
}

// splitChunks cuts text into pieces of at most size bytes, on paragraph
// boundaries where it can, else on lines, else anywhere (on a rune boundary).
func splitChunks(text string, size int) []string {
	if size < 1 {
		size = 1
	}
	var out []string
	var cur strings.Builder
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			out = append(out, s)
		}
		cur.Reset()
	}
	add := func(piece, sep string) {
		if cur.Len() > 0 && cur.Len()+len(sep)+len(piece) > size {
			flush()
		}
		if cur.Len() > 0 {
			cur.WriteString(sep)
		}
		cur.WriteString(piece)
	}
	for _, para := range strings.Split(text, "\n\n") {
		if len(para) <= size {
			add(para, "\n\n")
			continue
		}
		flush()
		for _, line := range strings.Split(para, "\n") {
			if len(line) <= size {
				add(line, "\n")
				continue
			}
			flush()
			for len(line) > size {
				cut := size
				for cut > 0 && !utf8.RuneStart(line[cut]) {
					cut--
				}
				if cut == 0 {
					cut = size
				}
				out = append(out, line[:cut])
				line = line[cut:]
			}
			add(line, "\n")
		}
		flush()
	}
	flush()
	return out
}

// ---- reading input text ---------------------------------------------------

var (
	cueTags = regexp.MustCompile(`<[^>]*>`)
)

// readTextFile reads a chat input (≤ 256 KiB). SRT and VTT are reduced to
// their cue text.
func readTextFile(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", filepath.Base(path), err)
	}
	if st.Size() > maxTextFileBytes {
		return "", core.ValidationError(filepath.Base(path)+" is too long to give to the chat model (the limit is 256 KiB)", nil)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", filepath.Base(path), err)
	}
	s := strings.ToValidUTF8(strings.TrimPrefix(string(b), "\xEF\xBB\xBF"), "")
	switch strings.ToLower(filepath.Ext(path)) {
	case ".srt", ".vtt":
		s = cueText(s)
	}
	return strings.TrimSpace(s), nil
}

// cueText keeps only the spoken text of SRT or VTT content: per block, what
// follows the timing line (cue numbers, identifiers, the WEBVTT header and
// NOTE/STYLE/REGION blocks are dropped).
func cueText(s string) string {
	var out []string
	for _, block := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n\n") {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		timing := -1
		for i, l := range lines {
			if strings.Contains(l, "-->") {
				timing = i
				break
			}
		}
		if timing < 0 {
			continue
		}
		for _, l := range lines[timing+1:] {
			if t := strings.TrimSpace(cueTags.ReplaceAllString(l, "")); t != "" {
				out = append(out, t)
			}
		}
	}
	return strings.Join(out, "\n")
}
