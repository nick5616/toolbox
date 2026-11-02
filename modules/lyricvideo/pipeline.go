package lyricvideo

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"

	"toolbox/core"
)

// Pipeline step adapter (SPEC.md §6.2, §6.4). Steps use the "auto" action.

var _ core.Chainable = (*Module)(nil)

// StepOptions are Lyric Video's pipeline step options; steps use the "auto"
// action (detect the lyrics, then render). Look.Title and Look.Artist take
// {vars}.
type StepOptions struct {
	Language string `json:"language"`
	Look     Look   `json:"look"`
	Audio    string `json:"audio"`  // "original" | "instrumental"
	Aspect   string `json:"aspect"` // "16:9" | "9:16" | "1:1"
	Height   int    `json:"height"` // 720 | 1080
}

// DefaultStepOptions: the default look titled with the item's name.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	look := DefaultLook()
	look.Title = "{item}"
	return StepOptions{Language: o.Language, Look: look, Audio: o.Audio, Aspect: o.Aspect, Height: o.Height}
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// withDefaults fills unset fields (the render fills empty look fields too).
func (s StepOptions) withDefaults() StepOptions {
	if s.Audio == "" {
		s.Audio = "original"
	}
	if s.Aspect == "" {
		s.Aspect = "16:9"
	}
	if s.Height == 0 {
		s.Height = 1080
	}
	return s
}

// autoOptions maps step options to the auto job's options (Look unexpanded).
func (s StepOptions) autoOptions() Options {
	return Options{
		Action: ActionAuto, Source: SourceDetect, Language: s.Language, Lines: []LyricLine{},
		Look: s.Look, Audio: s.Audio, Aspect: s.Aspect, Height: s.Height,
	}
}

func problemMessage(err error) string {
	ae := core.AsAppError(err)
	if len(ae.Fields) == 0 || ae.Message != "Some options are invalid" {
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
	parts := []string{"Lyrics"}
	if s.Look.Karaoke {
		parts[0] = "Karaoke"
	}
	parts = append(parts, s.Aspect)
	if s.Audio == "instrumental" {
		parts = append(parts, "instrumental")
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
		Accepts: core.Accepts{Extensions: Accepts()},
		Produces: []core.StepProduct{
			{Role: "video", Label: "Video", Kind: core.KindVideo, Exts: []string{".mp4"}},
			{Role: "lyrics", Label: "Lyrics", Kind: core.KindOther, Exts: []string{".lrc"}},
		},
		Vars:      []core.StepVar{},
		Templates: []string{"/look/title", "/look/artist"},
		Warnings:  []string{}, Secrets: []core.StepSecret{},
		Summary: stepSummary(s),
	}
	if err := validateOptions(s.autoOptions()); err != nil {
		return info, core.ValidationError(problemMessage(err), core.AsAppError(err).Fields)
	}
	return info, nil
}

// PrepareStep implements core.Chainable: one auto job per song.
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	raw, err := core.DecodeOptionsJSON[StepOptions](req.Options)
	if err != nil {
		return nil, err
	}
	s := raw.withDefaults()
	jobs := make([]core.StepJob, 0, len(req.Item.Files))
	for _, f := range req.Item.Files {
		o := s.autoOptions()
		vars := core.FileVars(f)
		o.Look.Title, _ = core.ExpandVars(s.Look.Title, req.Item.Vars, vars)
		o.Look.Artist, _ = core.ExpandVars(s.Look.Artist, req.Item.Vars, vars)
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: o})
	}
	return jobs, nil
}

// StepOutputs implements core.Chainable: the video and the .lrc.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		rf := core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID}
		if rf.Name == "" {
			rf.Name = filepath.Base(out.Path)
		}
		if strings.EqualFold(filepath.Ext(out.Path), ".lrc") {
			rf.Role, rf.RoleLabel = "lyrics", "Lyrics"
		} else {
			rf.Role, rf.RoleLabel = "video", "Video"
		}
		res.Files = append(res.Files, rf)
	}
	return res, nil
}
