package archiver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter: a step takes a list of links (a .txt or .url file,
// or links directly) and makes archived pages (+ PDFs).

var _ core.Chainable = (*Module)(nil)

// maxListBytes bounds a link-list file.
const maxListBytes = 1 << 20

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
	return withDefaults(o), nil
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

func stepSummary(o Options) string {
	parts := []string{"Single HTML file"}
	if o.RenderJS {
		parts = append(parts, "JavaScript rendered")
	}
	if o.AlsoPDF {
		parts = append(parts, "+ PDF")
	}
	return strings.Join(parts, " · ")
}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	o, err := decodeStep(options)
	if err != nil {
		return core.StepInfo{}, err
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return core.StepInfo{}, fmt.Errorf("marshal archiver options: %w", err)
	}
	if err := m.Validate([]string{"https://example.com/"}, raw); err != nil {
		return core.StepInfo{}, plainProblem(err)
	}
	produces := []core.StepProduct{{Role: "page", Label: "Page", Kind: core.KindDocument, Exts: []string{".html"}, Many: true}}
	if o.AlsoPDF {
		produces = append(produces, core.StepProduct{Role: "pdf", Label: "PDF", Kind: core.KindDocument, Exts: []string{".pdf"}, Many: true})
	}
	return core.StepInfo{
		Accepts:  core.Accepts{URLs: true, Extensions: []string{".txt", ".url"}},
		Produces: produces,
		Vars:     []core.StepVar{{Name: "title", Label: "Title", Type: core.ValueText}, {Name: "url", Label: "Link", Type: core.ValueText}},
		Summary:  stepSummary(o),
	}, nil
}

// linksFromList extracts http(s) links from a .txt list (one per line, '#'
// comments) or a .url shortcut (URL=… line).
func linksFromList(data string) []string {
	var out []string
	for _, line := range strings.Split(strings.ReplaceAll(data, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(line, string(rune(0xFEFF))))
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok && strings.EqualFold(strings.TrimSpace(k), "url") {
			line = strings.TrimSpace(v)
		}
		l := strings.ToLower(line)
		if strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://") {
			out = append(out, line)
		}
	}
	return out
}

func isLink(s string) bool {
	l := strings.ToLower(strings.TrimSpace(s))
	return strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://")
}

func readList(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open link list %s: %w", filepath.Base(path), err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxListBytes))
	if err != nil {
		return nil, fmt.Errorf("read link list %s: %w", filepath.Base(path), err)
	}
	return linksFromList(string(b)), nil
}

// PrepareStep implements core.Chainable.
func (m *Module) PrepareStep(ctx context.Context, req core.StepRequest) ([]core.StepJob, error) {
	o, err := decodeStep(req.Options)
	if err != nil {
		return nil, err
	}
	var links []string
	seen := map[string]bool{}
	add := func(l string) {
		if !seen[l] {
			seen[l] = true
			links = append(links, l)
		}
	}
	for _, f := range req.Item.Files {
		p := strings.TrimSpace(f.Path)
		if p == "" {
			continue
		}
		if isLink(p) {
			add(p)
			continue
		}
		list, err := readList(p)
		if err != nil {
			return nil, err
		}
		for _, l := range list {
			add(l)
		}
	}
	if len(links) == 0 {
		return nil, core.ValidationError("There's no link to archive", nil)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return nil, fmt.Errorf("marshal archiver options: %w", err)
	}
	if err := m.Validate(links, raw); err != nil {
		return nil, plainProblem(err)
	}
	return []core.StepJob{{Inputs: links, Options: o}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		role, label := "page", "Page"
		if strings.EqualFold(filepath.Ext(out.Path), ".pdf") {
			role, label = "pdf", "PDF"
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind,
			Role: role, RoleLabel: label, OutputID: out.ID})
	}
	res.Vars["title"], _ = core.CapVar(job.Title)
	if len(job.Inputs) > 0 {
		res.Vars["url"], _ = core.CapVar(job.Inputs[0])
	}
	return res, nil
}
