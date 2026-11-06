package subtitles

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
	"toolbox/core/viz"
)

// Pipeline step adapter (SPEC.md §6.2, §6.4). Steps use the "auto" action.

var _ core.Chainable = (*Module)(nil)

// StepOptions are Subtitles' pipeline step options; steps use the "auto"
// action (generate, translate, then save, burn or embed in one job).
type StepOptions struct {
	Model              string           `json:"model"`
	Language           string           `json:"language"`
	TranslateToEnglish bool             `json:"translateToEnglish"` // Whisper's own translation
	TargetLanguage     string           `json:"targetLanguage"`     // "" = keep; else via Local Chat
	MaxLineChars       int              `json:"maxLineChars"`
	MaxLines           int              `json:"maxLines"`
	Save               []string         `json:"save"`  // "srt", "vtt" (0–2)
	Video              string           `json:"video"` // "none" | "burn" | "embed"
	Style              Style            `json:"style"`
	Size               string           `json:"size"`
	Position           string           `json:"position"`
	Font               string           `json:"font"`
	TrackLanguage      string           `json:"trackLanguage"`
	MaxSizeMB          int              `json:"maxSizeMB"`
	Canvas             string           `json:"canvas"` // audio input + burn
	CanvasHeight       int              `json:"canvasHeight"`
	Background         string           `json:"background"` // "color" | "image" | "visualizer"
	BackgroundColor    string           `json:"backgroundColor"`
	BackgroundPath     string           `json:"backgroundPath"`
	Visuals            *viz.VisualsSpec `json:"visuals"`
}

// DefaultStepOptions: generate with the small model, save an SRT, burn it in.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{
		Model: o.Model, Language: o.Language, MaxLineChars: o.MaxLineChars, MaxLines: o.MaxLines,
		Save: []string{"srt"}, Video: VideoBurn, Style: o.Style, Size: o.Size, Position: o.Position,
		Font: o.Font, Canvas: o.Canvas, CanvasHeight: o.CanvasHeight, Background: o.Background,
		BackgroundColor: o.BackgroundColor,
	}
}

// withDefaults fills unset fields from the defaults.
func (s StepOptions) withDefaults() StepOptions {
	d := DefaultStepOptions()
	if s.Model == "" {
		s.Model = d.Model
	}
	if s.MaxLineChars == 0 {
		s.MaxLineChars = d.MaxLineChars
	}
	if s.MaxLines == 0 {
		s.MaxLines = d.MaxLines
	}
	if s.Video == "" {
		s.Video = d.Video
	}
	if s.Style == "" {
		s.Style = d.Style
	}
	if s.Size == "" {
		s.Size = d.Size
	}
	if s.Position == "" {
		s.Position = d.Position
	}
	if s.Font == "" {
		s.Font = d.Font
	}
	if s.Canvas == "" {
		s.Canvas = d.Canvas
	}
	if s.CanvasHeight == 0 {
		s.CanvasHeight = d.CanvasHeight
	}
	if s.Background == "" {
		s.Background = d.Background
	}
	if s.BackgroundColor == "" {
		s.BackgroundColor = d.BackgroundColor
	}
	return s
}

// autoOptions maps step options to the auto job's options.
func (s StepOptions) autoOptions() Options {
	formats := append([]string{}, s.Save...)
	return Options{
		Action: ActionAuto, Model: s.Model, Language: s.Language, TranslateToEnglish: s.TranslateToEnglish,
		MaxLineChars: s.MaxLineChars, MaxLines: s.MaxLines, Cues: []Cue{}, Formats: formats,
		TargetLanguage: s.TargetLanguage, Style: s.Style, Size: s.Size, Position: s.Position, Font: s.Font,
		TrackLanguage: s.TrackLanguage, Canvas: s.Canvas, CanvasHeight: s.CanvasHeight,
		Background: s.Background, BackgroundColor: s.BackgroundColor, BackgroundPath: s.BackgroundPath,
		Visuals: s.Visuals, Video: s.Video, MaxSizeMB: s.MaxSizeMB,
	}
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

func stepAccepts() core.Accepts {
	return core.Accepts{Extensions: append(append([]string{}, media.VideoExtensions()...), media.AudioExtensions()...)}
}

// firstProblem turns a validation error into one message: the first field's
// message in key order.
func firstProblem(err error) string {
	ae := core.AsAppError(err)
	if len(ae.Fields) == 0 {
		return ae.Message
	}
	keys := make([]string, 0, len(ae.Fields))
	for k := range ae.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return ae.Fields[keys[0]]
}

func stepSummary(s StepOptions) string {
	var parts []string
	switch s.Video {
	case VideoBurn:
		parts = append(parts, "Burn", strings.ToLower(string(s.Style)))
		if s.MaxSizeMB > 0 {
			parts = append(parts, fmt.Sprintf("≤ %d MB", s.MaxSizeMB))
		}
	case VideoEmbed:
		parts = append(parts, "Embed track")
	default:
		if len(s.Save) > 0 {
			up := make([]string, len(s.Save))
			for i, f := range s.Save {
				up[i] = strings.ToUpper(f)
			}
			parts = append(parts, "Save "+strings.Join(up, ", "))
		}
	}
	if s.TargetLanguage != "" {
		parts = append(parts, "to "+languageName(s.TargetLanguage))
	}
	if len(parts) == 0 {
		return "Subtitles"
	}
	return strings.Join(parts, " · ")
}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	raw, err := core.DecodeOptionsJSON[StepOptions](options)
	if err != nil {
		return core.StepInfo{}, err
	}
	s := raw.withDefaults()
	info := core.StepInfo{
		Accepts:   stepAccepts(),
		Vars:      []core.StepVar{{Name: "subtitles", Label: "Subtitle text", Type: core.ValueText}, {Name: "language", Label: "Language", Type: core.ValueText}},
		Templates: []string{}, Warnings: []string{}, Secrets: []core.StepSecret{},
		Summary: stepSummary(s),
	}
	if len(s.Save) > 0 {
		exts := make([]string, len(s.Save))
		for i, f := range s.Save {
			exts[i] = "." + f
		}
		info.Produces = append(info.Produces, core.StepProduct{Role: "subtitles", Label: "Subtitles", Kind: core.KindOther, Exts: exts, Many: len(exts) > 1})
	}
	switch s.Video {
	case VideoBurn:
		info.Produces = append(info.Produces, core.StepProduct{Role: "video", Label: "Video", Kind: core.KindVideo, Exts: []string{".mp4"}})
	case VideoEmbed:
		info.Produces = append(info.Produces, core.StepProduct{Role: "video", Label: "Video", Kind: core.KindVideo})
	}
	if info.Produces == nil {
		info.Produces = []core.StepProduct{}
	}
	if s.TargetLanguage != "" && m.tg != nil {
		if st := m.translatorStatus(); !st.Ready {
			info.Warnings = append(info.Warnings, "Translating needs a Local Chat model: "+st.Error)
		}
	}
	if f := validateAuto(s.autoOptions()); len(f) > 0 {
		verr := core.ValidationError("Some options are invalid", f)
		return info, core.ValidationError(firstProblem(verr), f)
	}
	return info, nil
}

// PrepareStep implements core.Chainable: one auto job per file.
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	raw, err := core.DecodeOptionsJSON[StepOptions](req.Options)
	if err != nil {
		return nil, err
	}
	s := raw.withDefaults()
	jobs := make([]core.StepJob, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		o := s.autoOptions()
		// A visualizer background needs a design; audio without one gets the colour.
		if o.Video == VideoBurn && o.Background == "visualizer" && o.Visuals == nil &&
			core.KindForPath(f.Path) == core.KindAudio {
			o.Background = "color"
		}
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: o})
	}
	return jobs, nil
}

// maxSubtitleVarBytes is how much of a subtitle file the variable reads.
const maxSubtitleVarBytes = 1 << 20

// StepOutputs implements core.Chainable: the subtitle files and the video,
// with the cue text and the language as variables.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	var subs []core.Output
	for _, out := range job.Outputs {
		rf := core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID}
		if rf.Name == "" {
			rf.Name = filepath.Base(out.Path)
		}
		if isSubtitleExt(out.Path) {
			rf.Role, rf.RoleLabel = "subtitles", "Subtitles"
			subs = append(subs, out)
		} else {
			rf.Role, rf.RoleLabel = "video", "Video"
		}
		res.Files = append(res.Files, rf)
	}
	if job.ResultJSON != "" {
		var r Result
		if json.Unmarshal([]byte(job.ResultJSON), &r) == nil {
			res.Vars["language"] = r.Language
		}
	}
	// Prefer the .srt: the .vtt has a header but parses the same.
	slices.SortStableFunc(subs, func(a, b core.Output) int {
		return strings.Compare(strings.ToLower(filepath.Ext(a.Path)), strings.ToLower(filepath.Ext(b.Path)))
	})
	for _, out := range subs {
		if text, err := cueText(out.Path); err == nil {
			res.Vars["subtitles"] = text
			break
		}
	}
	return res, nil
}

// cueText reads a subtitle file as plain text, one cue per line.
func cueText(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open subtitles: %w", err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxSubtitleVarBytes))
	if err != nil {
		return "", fmt.Errorf("read subtitles: %w", err)
	}
	var sb strings.Builder
	for _, c := range parseCues(decodeText(b)) {
		line := strings.Join(strings.Fields(c.Text), " ")
		if line == "" {
			continue
		}
		if sb.Len()+len(line)+1 > core.MaxVarBytes {
			break
		}
		if sb.Len() > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(line)
	}
	return sb.String(), nil
}
