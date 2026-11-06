package transcribe

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2): one submission with every file of the
// item; the module splits it into one job per file.

var _ core.Chainable = (*Module)(nil)

// maxReadBytes is how much of a transcript file is read into a variable.
const maxReadBytes = 1 << 20

// decodeStep decodes step options strictly over the defaults, so unset
// fields keep their defaults.
func decodeStep(raw json.RawMessage) (Options, error) {
	o := DefaultOptions()
	if len(bytes.TrimSpace(raw)) == 0 {
		return o, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, core.ValidationError("Invalid options", nil).WithCause(fmt.Errorf("decode options: %w", err))
	}
	return o, nil
}

func plainProblem(err error) error {
	ae := core.AsAppError(err)
	if ae == nil || len(ae.Fields) == 0 {
		return err
	}
	keys := make([]string, 0, len(ae.Fields))
	for k := range ae.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return core.ValidationError(ae.Fields[keys[0]], ae.Fields)
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultOptions() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	if err := validateOptions(o); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	has := func(f string) bool { return slices.Contains(o.Formats, f) }
	var products []core.StepProduct
	if has(FormatTXT) {
		products = append(products, core.StepProduct{Role: "text", Label: "Text", Kind: core.KindDocument, Exts: []string{".txt"}})
	}
	if has(FormatSRT) || has(FormatVTT) {
		p := core.StepProduct{Role: "subtitles", Label: "Subtitles", Kind: core.KindOther}
		if has(FormatSRT) {
			p.Exts = append(p.Exts, ".srt")
		}
		if has(FormatVTT) {
			p.Exts = append(p.Exts, ".vtt")
		}
		p.Many = len(p.Exts) > 1
		products = append(products, p)
	}
	if has(FormatJSON) {
		products = append(products, core.StepProduct{Role: "json", Label: "JSON", Kind: core.KindDocument, Exts: []string{".json"}})
	}
	vars := []core.StepVar{{Name: "transcript", Label: "Transcript", Type: core.ValueText}}
	if has(FormatSRT) || has(FormatVTT) || has(FormatJSON) {
		vars = append(vars, core.StepVar{Name: "transcript_timed", Label: "Transcript with times", Type: core.ValueText})
	}
	vars = append(vars, core.StepVar{Name: "language", Label: "Language", Type: core.ValueText})

	var formats []string
	for _, f := range AllFormats() {
		if has(f) {
			formats = append(formats, strings.ToUpper(f))
		}
	}
	model := string(o.Model)
	summary := strings.ToUpper(model[:1]) + model[1:] + " model · " + strings.Join(formats, ", ")
	if o.Task == TaskTranslate {
		summary += " · to English"
	}
	return core.StepInfo{
		Accepts:  m.Descriptor().Accepts,
		Produces: products,
		Vars:     vars,
		Summary:  summary,
	}, nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	inputs := make([]string, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		inputs = append(inputs, f.Path)
	}
	if len(inputs) == 0 {
		return nil, core.ValidationError("There's no file to transcribe", nil)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal transcribe options: %w", err)
	}
	if err := m.Validate(inputs, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: inputs, Options: o}}, nil
}

// roleOf names a transcript file's role by its extension.
func roleOf(path string) (role, label string) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".txt":
		return "text", "Text"
	case ".srt", ".vtt":
		return "subtitles", "Subtitles"
	case ".json":
		return "json", "JSON"
	}
	return "", ""
}

// readText reads at most 1 MiB of a file as text; "" when unreadable.
func readText(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxReadBytes))
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(string(b), string(rune(0xFEFF)))
}

// cue is one timed piece of text.
type cue struct {
	start float64
	text  string
}

// parseStamp parses "HH:MM:SS,mmm", "HH:MM:SS.mmm" or "MM:SS.mmm".
func parseStamp(s string) (float64, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), ",", ".")
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, false
	}
	total := 0.0
	for _, p := range parts {
		v, err := strconv.ParseFloat(p, 64)
		if err != nil || v < 0 {
			return 0, false
		}
		total = total*60 + v
	}
	return total, true
}

// parseCues reads the cues of an SRT or WebVTT document.
func parseCues(doc string) []cue {
	doc = strings.ReplaceAll(strings.ReplaceAll(doc, "\r\n", "\n"), "\r", "\n")
	var cues []cue
	for _, block := range strings.Split(doc, "\n\n") {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		at := -1
		for i, l := range lines {
			if strings.Contains(l, "-->") {
				at = i
				break
			}
		}
		if at < 0 {
			continue // a header, a NOTE or a stray number
		}
		start, ok := parseStamp(strings.SplitN(lines[at], "-->", 2)[0])
		if !ok {
			continue
		}
		var words []string
		for _, l := range lines[at+1:] {
			if l = strings.TrimSpace(l); l != "" {
				words = append(words, l)
			}
		}
		if len(words) > 0 {
			cues = append(cues, cue{start, strings.Join(words, " ")})
		}
	}
	return cues
}

// parseJSONCues reads the segments of the module's JSON output.
func parseJSONCues(doc string) []cue {
	var d struct {
		Segments []struct {
			Start float64 `json:"start"`
			Text  string  `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal([]byte(doc), &d); err != nil {
		return nil
	}
	var cues []cue
	for _, s := range d.Segments {
		if t := strings.TrimSpace(s.Text); t != "" {
			cues = append(cues, cue{s.Start, t})
		}
	}
	return cues
}

func plain(cues []cue) string {
	lines := make([]string, len(cues))
	for i, c := range cues {
		lines[i] = c.text
	}
	return strings.Join(lines, "\n")
}

func timed(cues []cue) string {
	lines := make([]string, len(cues))
	for i, c := range cues {
		t := int(c.start)
		lines[i] = fmt.Sprintf("[%d:%02d:%02d] %s", t/3600, t%3600/60, t%60, c.text)
	}
	return strings.Join(lines, "\n")
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	byExt := map[string]string{}
	for _, out := range job.Outputs {
		role, label := roleOf(out.Path)
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, Role: role, RoleLabel: label, OutputID: out.ID})
		if _, dup := byExt[strings.ToLower(filepath.Ext(out.Path))]; !dup {
			byExt[strings.ToLower(filepath.Ext(out.Path))] = out.Path
		}
	}
	if job.ResultJSON != "" {
		var r Result
		if err := json.Unmarshal([]byte(job.ResultJSON), &r); err != nil {
			return res, fmt.Errorf("read transcribe result: %w", err)
		}
		res.Vars["language"] = r.Language
	}

	// The timed text comes from the first of srt, vtt, json that exists.
	var cues []cue
	switch {
	case byExt[".srt"] != "":
		cues = parseCues(readText(byExt[".srt"]))
	case byExt[".vtt"] != "":
		cues = parseCues(readText(byExt[".vtt"]))
	case byExt[".json"] != "":
		cues = parseJSONCues(readText(byExt[".json"]))
	}
	if len(cues) > 0 {
		res.Vars["transcript_timed"], _ = core.CapVar(timed(cues))
	}
	switch {
	case byExt[".txt"] != "":
		res.Vars["transcript"], _ = core.CapVar(strings.TrimSpace(readText(byExt[".txt"])))
	case len(cues) > 0:
		res.Vars["transcript"], _ = core.CapVar(plain(cues))
	}
	return res, nil
}
