package editstudio

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"toolbox/core"
	"toolbox/core/media"
)

// Pipeline step adapters (Phase 14 A2): the Video Editor's "Assemble a video"
// (VideoModule) and Edit Studio's "Cut to the beat" (Module). Both build an
// edit from all the run's files together and export it as one video.

var (
	_ core.Chainable = (*Module)(nil)
	_ core.Chainable = (*VideoModule)(nil)
)

var mediaExts = func() []string {
	return slices.Concat(media.VideoExtensions(), media.ImageExtensions(), media.AudioExtensions())
}

// stepProducts is the one video both steps make.
func stepProducts() []core.StepProduct {
	return []core.StepProduct{{Role: "video", Label: "Video", Kind: core.KindVideo, Exts: []string{".mp4"}}}
}

// allFiles lists a together step's files in item order.
func allFiles(req core.StepRequest) []core.RunFile {
	if len(req.Items) == 0 {
		return req.Item.Files
	}
	var out []core.RunFile
	for _, it := range req.Items {
		out = append(out, it.Files...)
	}
	return out
}

// stepVars are the variables a together step expands templates with: the first
// item's, plus the first file's name/ext/role.
func stepVars(req core.StepRequest, files []core.RunFile) []map[string]string {
	maps := []map[string]string{}
	switch {
	case len(req.Items) > 0:
		maps = append(maps, req.Items[0].Vars)
	case req.Item.Vars != nil:
		maps = append(maps, req.Item.Vars)
	}
	if len(files) > 0 {
		maps = append(maps, core.FileVars(files[0]))
	}
	return maps
}

func expand(tpl string, maps []map[string]string) string {
	out, _ := core.ExpandVars(tpl, maps...)
	return out
}

func kindOf(f core.RunFile) core.OutputKind {
	if f.Kind != "" && f.Kind != core.KindOther {
		return f.Kind
	}
	return core.KindForPath(f.Path)
}

func resultFiles(job core.Job) core.StepResult {
	res := core.StepResult{Files: make([]core.RunFile, 0, len(job.Outputs)), Vars: map[string]string{}}
	for _, out := range job.Outputs {
		name := out.Name
		if name == "" {
			name = filepath.Base(out.Path)
		}
		res.Files = append(res.Files, core.RunFile{Path: out.Path, Name: name, Kind: core.KindVideo, OutputID: out.ID, Role: "video", RoleLabel: "Video"})
	}
	return res
}

// waitForWindow makes a step wait until a window can draw for it.
func (m *Module) waitForWindow() error { return m.cfg.Broker.WaitForHost() }

// --- Assemble a video (Video Editor) -------------------------------------------

// StepDefaults implements core.Chainable.
func (v *VideoModule) StepDefaults() any { return DefaultAssembleRequest() }

// DescribeStep implements core.Chainable.
func (v *VideoModule) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	raw, err := core.DecodeOptionsJSON[AssembleRequest](options)
	if err != nil {
		return core.StepInfo{}, err
	}
	r := raw.withDefaults()
	info := core.StepInfo{
		Accepts:  core.Accepts{Extensions: mediaExts()},
		Produces: stepProducts(), Vars: []core.StepVar{}, Together: true,
		Templates: []string{"/title", "/music", "/name"}, Warnings: []string{}, Secrets: []core.StepSecret{},
	}
	switch {
	case r.TemplateID != "":
		info.Summary = "Assemble into " + labelOr(r.TemplateName, "a saved edit")
		if _, err := v.m.docs.Load(context.Background(), r.TemplateID); err != nil {
			return info, vErr("templateId", "The template edit isn't there any more. Pick another")
		}
	default:
		info.Summary = fmt.Sprintf("Assemble · %s · %dp%d", r.Aspect, r.Height, r.FPS)
	}
	if r.Transition == "crossfade" {
		info.Summary += " · crossfade"
	}
	if err := validateAssemble(raw); err != nil {
		return info, err
	}
	return info, nil
}

func labelOr(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

// PrepareStep implements core.Chainable: one job with every clip, in order.
func (v *VideoModule) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	raw, err := core.DecodeOptionsJSON[AssembleRequest](req.Options)
	if err != nil {
		return nil, err
	}
	r := raw.withDefaults()
	if err := validateAssemble(r); err != nil {
		return nil, err
	}
	files := allFiles(req)
	if len(files) == 0 {
		return nil, nil
	}
	if err := v.m.waitForWindow(); err != nil {
		return nil, err
	}
	maps := stepVars(req, files)
	r.Title = expand(r.Title, maps)
	r.Music = expand(r.Music, maps)
	r.Name = expand(r.Name, maps)
	paths := make([]string, len(files))
	for i, f := range files {
		paths[i] = f.Path
	}
	return []core.StepJob{{Inputs: paths, Options: Options{Action: ActionAssemble, Assemble: &r}}}, nil
}

// StepOutputs implements core.Chainable.
func (v *VideoModule) StepOutputs(job core.Job) (core.StepResult, error) {
	return resultFiles(job), nil
}

// --- Cut to the beat (Edit Studio) -------------------------------------------

// StepDefaults implements core.Chainable.
func (m *Module) StepDefaults() any { return DefaultBeatRequest() }

// DescribeStep implements core.Chainable.
func (m *Module) DescribeStep(options json.RawMessage) (core.StepInfo, error) {
	raw, err := core.DecodeOptionsJSON[BeatRequest](options)
	if err != nil {
		return core.StepInfo{}, err
	}
	r := raw.withDefaults()
	info := core.StepInfo{
		Accepts:  core.Accepts{Extensions: mediaExts()},
		Produces: stepProducts(), Vars: []core.StepVar{}, Together: true,
		Templates: []string{"/song", "/name"}, Warnings: []string{}, Secrets: []core.StepSecret{},
		Summary: fmt.Sprintf("Cut to the beat · %s · %s · %dp%d", r.RecipeID, r.Aspect, r.Height, r.FPS),
	}
	if err := validateBeat(raw); err != nil {
		return info, err
	}
	return info, nil
}

// PrepareStep implements core.Chainable: one job with the song and the clips.
// Without a song option, the first audio file is the song. It waits while no
// window is open to run the recipe in.
func (m *Module) PrepareStep(_ context.Context, req core.StepRequest) ([]core.StepJob, error) {
	raw, err := core.DecodeOptionsJSON[BeatRequest](req.Options)
	if err != nil {
		return nil, err
	}
	r := raw.withDefaults()
	if err := validateBeat(r); err != nil {
		return nil, err
	}
	files := allFiles(req)
	if len(files) == 0 {
		return nil, nil
	}
	maps := stepVars(req, files)
	song := strings.TrimSpace(expand(r.Song, maps))
	var clips []string
	for _, f := range files {
		switch kindOf(f) {
		case core.KindAudio:
			if song == "" {
				song = f.Path
			}
		case core.KindVideo, core.KindImage:
			clips = append(clips, f.Path)
		}
	}
	if song == "" {
		return nil, vErr("song", "Add a song to cut to, or pick one in the step")
	}
	if len(clips) == 0 {
		return nil, vErr("inputs", "Add some clips or photos to cut")
	}
	if err := m.waitForWindow(); err != nil {
		return nil, err
	}
	r.Song = song
	r.Name = expand(r.Name, maps)
	return []core.StepJob{{Inputs: clips, Options: Options{Action: ActionBeat, Beat: &r}}}, nil
}

// StepOutputs implements core.Chainable.
func (m *Module) StepOutputs(job core.Job) (core.StepResult, error) { return resultFiles(job), nil }
