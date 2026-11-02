package visualizer

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"toolbox/core"
	"toolbox/core/viz"
)

// Pipeline step adapter (SPEC.md §6.2, §6.4). Steps use the "auto" action.

var _ core.Chainable = (*Module)(nil)

// StepOptions are the Visualizer's pipeline step options; steps use the
// "auto" action (analyze, then render).
type StepOptions struct {
	PresetID   string `json:"presetId"`   // the preset it came from ("" = a saved design); a label only
	DesignName string `json:"designName"` // shown in the summary
	ShowJSON   string `json:"showJson"`   // required, ≤ 512 KiB
	Mode       Mode   `json:"mode"`       // full | overlay (overlay needs a video input)
	Aspect     string `json:"aspect"`
	Height     int    `json:"height"`
	FPS        int    `json:"fps"`
	Audio      string `json:"audio"`      // "original" | "instrumental" (needs Stems)
	Background string `json:"background"` // "none" | "cover"
	Stems      bool   `json:"stems"`
	SaveStems  bool   `json:"saveStems"`
	Words      string `json:"words"`    // "none" | "detect"
	Language   string `json:"language"` // words: "" = auto
	Mood       bool   `json:"mood"`
}

// DefaultStepOptions: full frame 16:9 1080p30 with stems and mood, no words;
// the design is picked in the step editor.
func DefaultStepOptions() StepOptions {
	o := DefaultOptions()
	return StepOptions{Mode: o.Mode, Aspect: o.Aspect, Height: o.Height, FPS: o.FPS, Audio: o.Audio,
		Background: o.Background, Stems: true, Words: "none", Mood: true}
}

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultStepOptions() }

// withDefaults fills unset fields.
func (s StepOptions) withDefaults() StepOptions {
	d := DefaultStepOptions()
	if s.Mode == "" {
		s.Mode = d.Mode
	}
	if s.Aspect == "" {
		s.Aspect = d.Aspect
	}
	if s.Height == 0 {
		s.Height = d.Height
	}
	if s.FPS == 0 {
		s.FPS = d.FPS
	}
	if s.Audio == "" {
		s.Audio = d.Audio
	}
	if s.Background == "" {
		s.Background = d.Background
	}
	if s.Words == "" {
		s.Words = d.Words
	}
	return s
}

// autoOptions maps step options to the auto job's options.
func (s StepOptions) autoOptions() Options {
	return Options{
		Action: ActionAuto,
		Analyze: viz.AnalyzeOptions{
			Stems: s.Stems, SaveStems: s.SaveStems, Words: viz.WordsSource(s.Words),
			Language: s.Language, Mood: s.Mood,
		},
		ShowJSON: s.ShowJSON, Mode: s.Mode, Aspect: s.Aspect, Height: s.Height, FPS: s.FPS,
		Audio: s.Audio, Background: s.Background,
	}
}

func stepSummary(s StepOptions) string {
	name := s.DesignName
	if name == "" {
		name = s.PresetID
	}
	if name == "" {
		name = "Visualizer"
	}
	if s.Mode == ModeOverlay {
		return name + " · Over the video"
	}
	return fmt.Sprintf("%s · %s · %dp%d", name, s.Aspect, s.Height, s.FPS)
}

var stemRoles = []string{"vocals", "drums", "bass", "other"}

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	raw, err := core.DecodeOptionsJSON[StepOptions](options)
	if err != nil {
		return core.StepInfo{}, err
	}
	s := raw.withDefaults()
	info := core.StepInfo{
		Accepts:   core.Accepts{Extensions: Accepts()},
		Produces:  []core.StepProduct{{Role: "video", Label: "Video", Kind: core.KindVideo, Exts: []string{".mp4"}}},
		Vars:      []core.StepVar{},
		Templates: []string{}, Warnings: []string{}, Secrets: []core.StepSecret{},
		Summary: stepSummary(s),
	}
	if s.SaveStems && s.Stems {
		for _, r := range stemRoles {
			info.Produces = append(info.Produces, core.StepProduct{Role: r, Label: strings.ToUpper(r[:1]) + r[1:], Kind: core.KindAudio, Exts: []string{".flac"}})
		}
	}
	if s.Mode == ModeOverlay {
		info.Warnings = append(info.Warnings, "Visuals over the video need a video file")
	}
	switch {
	case strings.TrimSpace(s.ShowJSON) == "":
		return info, bad("showJson", "Pick a design")
	case s.Audio == "instrumental" && !s.Stems:
		return info, bad("audio", "The instrumental needs Separate instruments turned on")
	case s.SaveStems && !s.Stems:
		return info, bad("saveStems", "Saving the stems needs Separate instruments turned on")
	}
	if err := validateAuto("clip.mp4", s.autoOptions()); err != nil {
		return info, err
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
		jobs = append(jobs, core.StepJob{Inputs: []string{f.Path}, Options: s.autoOptions()})
	}
	return jobs, nil
}

var stemFile = regexp.MustCompile(`(?i) - (vocals|drums|bass|other)\.flac$`)

// StepOutputs implements core.Chainable: the video, and the saved stems
// (named "<song> - Vocals.flac" and so on) with their roles.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) {
	res := core.StepResult{Files: []core.RunFile{}, Vars: map[string]string{}}
	for _, out := range job.Outputs {
		rf := core.RunFile{Path: out.Path, Name: out.Name, Kind: out.Kind, OutputID: out.ID, Role: "video", RoleLabel: "Video"}
		if rf.Name == "" {
			rf.Name = filepath.Base(out.Path)
		}
		if sm := stemFile.FindStringSubmatch(filepath.Base(out.Path)); sm != nil {
			role := strings.ToLower(sm[1])
			rf.Role, rf.RoleLabel = role, strings.ToUpper(role[:1])+role[1:]
		}
		res.Files = append(res.Files, rf)
	}
	return res, nil
}
